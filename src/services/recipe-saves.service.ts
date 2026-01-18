import { supabaseAdmin } from '../config/supabase.js';
import { recipeService } from './recipe.service.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { dbToEnvelope, type RecipeEnvelopeData } from '../schemas/envelope.js';
import { withRecipeOwnership, type RecipePayload } from '../utils/recipe-payload.js';
import type { RecipeIngredient, RecipeStep, RecipeMedia } from '../types/index.js';

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
  recipe_data: RecipePayload<RecipeEnvelopeData>;
};

export type RecipeSaveListItem = {
  id: string;
  saved_at: string;
  source_recipe_id: string | null;
  daily_plan_item_id: string | null;
  recipe_data: RecipePayload<RecipeEnvelopeData>;
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

    const recipeResult = await recipeService.getRecipeById(copiedRecipe.id, userId);
    if (!recipeResult) {
      throw new BadRequestError('Failed to load saved recipe');
    }

    return {
      id: save.id,
      recipe_id: save.recipe_id,
      source_recipe_id: save.source_recipe_id,
      daily_plan_item_id: save.daily_plan_item_id,
      created_at: save.created_at,
      recipe_data: withRecipeOwnership(recipeResult.envelope.recipe, { isUserOwned: true }),
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

    const [
      { data: ingredients },
      { data: steps },
      { data: media },
    ] = await Promise.all([
      supabaseAdmin
        .from('recipe_ingredients')
        .select('*')
        .in('recipe_id', recipeIds)
        .order('position'),
      supabaseAdmin
        .from('recipe_steps')
        .select('*')
        .in('recipe_id', recipeIds)
        .order('position'),
      supabaseAdmin
        .from('recipe_media')
        .select('*')
        .in('recipe_id', recipeIds)
        .order('position'),
    ]);

    const ingredientsByRecipeId = new Map<string, RecipeIngredient[]>();
    for (const item of ingredients ?? []) {
      const existing = ingredientsByRecipeId.get(item.recipe_id) ?? [];
      existing.push(item as RecipeIngredient);
      ingredientsByRecipeId.set(item.recipe_id, existing);
    }

    const stepsByRecipeId = new Map<string, RecipeStep[]>();
    for (const item of steps ?? []) {
      const existing = stepsByRecipeId.get(item.recipe_id) ?? [];
      existing.push(item as RecipeStep);
      stepsByRecipeId.set(item.recipe_id, existing);
    }

    const mediaByRecipeId = new Map<string, RecipeMedia[]>();
    for (const item of media ?? []) {
      const existing = mediaByRecipeId.get(item.recipe_id) ?? [];
      existing.push(item as RecipeMedia);
      mediaByRecipeId.set(item.recipe_id, existing);
    }

    const recipeDataById = new Map<string, RecipeEnvelopeData>();
    for (const recipe of recipes ?? []) {
      const envelope = dbToEnvelope(
        recipe,
        ingredientsByRecipeId.get(recipe.id) ?? [],
        stepsByRecipeId.get(recipe.id) ?? [],
        mediaByRecipeId.get(recipe.id) ?? []
      );
      recipeDataById.set(recipe.id, envelope.recipe);
    }

    const recipeSaves: RecipeSaveListItem[] = [];
    for (const save of saves) {
      const recipeData = recipeDataById.get(save.recipe_id);
      if (!recipeData) {
        continue;
      }
      recipeSaves.push({
        id: save.id,
        saved_at: save.created_at,
        source_recipe_id: save.source_recipe_id,
        daily_plan_item_id: save.daily_plan_item_id,
        recipe_data: withRecipeOwnership(recipeData, { isUserOwned: true }),
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
