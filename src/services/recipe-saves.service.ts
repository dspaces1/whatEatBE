import { supabaseAdmin } from '../config/supabase.js';
import { recipeService } from './recipe.service.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

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
}

export const recipeSavesService = new RecipeSavesService();
