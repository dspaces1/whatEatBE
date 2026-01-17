import { supabaseAdmin } from '../config/supabase.js';
import { recipeService } from './recipe.service.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { normalizeCuisine } from '../utils/cuisines.js';
import { normalizeRecipeTags } from '../utils/recipe-tags.js';
import type { RecipeListItem } from '../types/index.js';

export type RecipeSaveSource =
  | { source_type: 'daily_plan_item'; source_id: string }
  | { source_type: 'recipe'; source_id: string }
  | { source_type: 'share'; source_id: string };

export type RecipeSaveResult = {
  id: string;
  recipe_id: string;
  source_recipe_id: string | null;
  daily_plan_item_id: string | null;
  created_at: string;
  recipe_title: string;
};

export type RecipeSaveListItem = {
  id: string;
  saved_at: string;
  source_recipe_id: string | null;
  daily_plan_item_id: string | null;
  recipe: RecipeListItem;
};

export interface PaginatedRecipeSaves {
  recipe_saves: RecipeSaveListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const getExistingSaveBySource = async (
  userId: string,
  sourceRecipeId: string
): Promise<{ id: string; recipe_id: string } | null> => {
  const { data, error } = await supabaseAdmin
    .from('recipe_saves')
    .select('id, recipe_id')
    .eq('user_id', userId)
    .eq('source_recipe_id', sourceRecipeId)
    .maybeSingle();

  if (error) {
    throw new BadRequestError('Failed to check existing saves');
  }

  return data ?? null;
};

export class RecipeSavesService {
  async createRecipeSave(userId: string, input: RecipeSaveSource): Promise<RecipeSaveResult> {
    let sourceRecipeId: string;
    let dailyPlanItemId: string | null = null;

    if (input.source_type === 'daily_plan_item') {
      const { data: planItem, error: fetchError } = await supabaseAdmin
        .from('daily_meal_plan_items')
        .select('id, recipe_id')
        .eq('id', input.source_id)
        .single();

      if (fetchError || !planItem) {
        throw new NotFoundError('Suggestion');
      }

      dailyPlanItemId = planItem.id;
      sourceRecipeId = planItem.recipe_id;

      const { data: existingByItem, error: itemLookupError } = await supabaseAdmin
        .from('recipe_saves')
        .select('id, recipe_id')
        .eq('user_id', userId)
        .eq('daily_plan_item_id', planItem.id)
        .maybeSingle();

      if (itemLookupError) {
        throw new BadRequestError('Failed to check existing saves');
      }

      if (existingByItem) {
        throw new ConflictError('Suggestion already saved');
      }
    } else if (input.source_type === 'share') {
      const { data: share, error: shareError } = await supabaseAdmin
        .from('recipe_shares')
        .select('recipe_id, expires_at')
        .eq('share_token', input.source_id)
        .single();

      if (shareError || !share) {
        throw new NotFoundError('Share');
      }

      if (share.expires_at && new Date(share.expires_at) < new Date()) {
        throw new NotFoundError('Share');
      }

      sourceRecipeId = share.recipe_id;
    } else {
      sourceRecipeId = input.source_id;
    }

    const existingBySource = await getExistingSaveBySource(userId, sourceRecipeId);
    if (existingBySource) {
      throw new ConflictError('Recipe already saved');
    }

    let copiedRecipe;
    try {
      copiedRecipe = await recipeService.copyRecipe(sourceRecipeId, userId, {
        allowPrivate: input.source_type === 'share',
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new NotFoundError('Recipe');
      }
      if (error instanceof Error && error.message.includes('Cannot copy')) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }

    const { data: save, error: saveError } = await supabaseAdmin
      .from('recipe_saves')
      .insert({
        user_id: userId,
        recipe_id: copiedRecipe.id,
        source_recipe_id: sourceRecipeId,
        daily_plan_item_id: dailyPlanItemId,
      })
      .select('id, recipe_id, source_recipe_id, daily_plan_item_id, created_at')
      .single();

    if (saveError || !save) {
      await recipeService.deleteRecipe(copiedRecipe.id, userId);
      throw new BadRequestError('Failed to save recipe');
    }

    return {
      id: save.id,
      recipe_id: save.recipe_id,
      source_recipe_id: save.source_recipe_id,
      daily_plan_item_id: save.daily_plan_item_id,
      created_at: save.created_at,
      recipe_title: copiedRecipe.title,
    };
  }

  async deleteRecipeSave(userId: string, saveId: string): Promise<void> {
    const { data: save, error: fetchError } = await supabaseAdmin
      .from('recipe_saves')
      .select('id, recipe_id')
      .eq('id', saveId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !save) {
      throw new NotFoundError('Recipe save');
    }

    const { error: deleteError } = await supabaseAdmin
      .from('recipe_saves')
      .delete()
      .eq('id', save.id)
      .eq('user_id', userId);

    if (deleteError) {
      throw new BadRequestError('Failed to delete recipe save');
    }

    const deleted = await recipeService.deleteRecipe(save.recipe_id, userId);
    if (!deleted) {
      logger.warn({ saveId, recipeId: save.recipe_id, userId }, 'Failed to delete saved recipe');
    }
  }

  async listRecipeSaves(userId: string, page: number, limit: number): Promise<PaginatedRecipeSaves> {
    const offset = (page - 1) * limit;

    const { data: saves, error, count } = await supabaseAdmin
      .from('recipe_saves')
      .select('id, recipe_id, source_recipe_id, daily_plan_item_id, created_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new BadRequestError('Failed to fetch recipe saves');
    }

    if (!saves || saves.length === 0) {
      return {
        recipe_saves: [],
        pagination: {
          page,
          limit,
          total: count ?? 0,
          totalPages: Math.ceil((count ?? 0) / limit),
        },
      };
    }

    const recipeIds = saves.map((save) => save.recipe_id);
    const { data: recipes, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .in('id', recipeIds);

    if (recipeError) {
      throw new BadRequestError('Failed to fetch saved recipes');
    }

    const { data: media } = await supabaseAdmin
      .from('recipe_media')
      .select('recipe_id, media_type, url, name')
      .in('recipe_id', recipeIds)
      .order('position');

    const mediaByRecipeId = new Map<
      string,
      Array<{ media_type: string; url: string; name: string | null }>
    >();
    if (media) {
      for (const item of media) {
        const existing = mediaByRecipeId.get(item.recipe_id) || [];
        existing.push(item);
        mediaByRecipeId.set(item.recipe_id, existing);
      }
    }

    const recipeById = new Map<string, RecipeListItem>();
    for (const recipe of recipes ?? []) {
      recipeById.set(recipe.id, {
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        calories: recipe.calories,
        prep_time_minutes: recipe.prep_time_minutes,
        cook_time_minutes: recipe.cook_time_minutes,
        servings: recipe.servings,
        tags: normalizeRecipeTags(recipe.tags ?? []),
        cuisine: normalizeCuisine(recipe.cuisine),
        source_type: recipe.source_type as 'manual' | 'url' | 'image' | 'ai',
        created_at: recipe.created_at,
        media: (mediaByRecipeId.get(recipe.id) || []).map((item) => ({
          media_type: item.media_type as 'image' | 'video',
          url: item.url,
          name: item.name,
        })),
      });
    }

    const recipeSaves: RecipeSaveListItem[] = [];
    for (const save of saves) {
      const recipe = recipeById.get(save.recipe_id);
      if (!recipe) {
        continue;
      }
      recipeSaves.push({
        id: save.id,
        saved_at: save.created_at,
        source_recipe_id: save.source_recipe_id,
        daily_plan_item_id: save.daily_plan_item_id,
        recipe,
      });
    }

    return {
      recipe_saves: recipeSaves,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / limit),
      },
    };
  }
}

export const recipeSavesService = new RecipeSavesService();
