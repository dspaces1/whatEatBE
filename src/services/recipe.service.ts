import { supabaseAdmin } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { normalizeDietaryLabels } from '../utils/dietary-labels.js';
import { normalizeCuisine } from '../utils/cuisines.js';
import { normalizeRecipeTags } from '../utils/recipe-tags.js';
import {
  recipeEnvelopeSchema,
  legacyCreateRecipeSchema,
  legacyToEnvelope,
  envelopeToDbRecipe,
  envelopeToDbIngredients,
  envelopeToDbSteps,
  envelopeToDbMedia,
  dbToEnvelope,
  type RecipeEnvelope,
  type LegacyCreateRecipe,
} from '../schemas/envelope.js';
import type { Recipe, RecipeIngredient, RecipeStep, RecipeMedia, RecipeListItem } from '../types/index.js';
import { withRecipeOwnership } from '../utils/recipe-payload.js';

export interface PaginatedRecipes {
  recipes: RecipeListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class RecipeService {
  /**
   * Get paginated list of user's recipes
   */
  async getUserRecipes(
    userId: string,
    page: number = 1,
    limit: number = 20,
    search?: string
  ): Promise<PaginatedRecipes> {
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('recipes')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike('title', `%${search}%`);
    }

    const { data: recipes, error, count } = await query;

    if (error) {
      throw new Error(`Failed to fetch recipes: ${error.message}`);
    }

    if (!recipes || recipes.length === 0) {
      return {
        recipes: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    }

    // Get media for all recipes
    const recipeIds = recipes.map((r) => r.id);
    const { data: media } = await supabaseAdmin
      .from('recipe_media')
      .select('recipe_id, media_type, url, name')
      .in('recipe_id', recipeIds)
      .order('position');

    // Map media to recipes
    const mediaByRecipeId = new Map<string, RecipeMedia[]>();
    if (media) {
      for (const m of media) {
        const existing = mediaByRecipeId.get(m.recipe_id) || [];
        existing.push(m as RecipeMedia);
        mediaByRecipeId.set(m.recipe_id, existing);
      }
    }

    const recipesWithMedia: RecipeListItem[] = recipes.map((r) => {
      const baseItem = {
        id: r.id,
        title: r.title,
        description: r.description,
        calories: r.calories,
        prep_time_minutes: r.prep_time_minutes,
        cook_time_minutes: r.cook_time_minutes,
        servings: r.servings,
        tags: normalizeRecipeTags(r.tags ?? []),
        cuisine: normalizeCuisine(r.cuisine),
        source_type: r.source_type as 'manual' | 'url' | 'image' | 'ai',
        created_at: r.created_at,
        media: (mediaByRecipeId.get(r.id) || []).map((m) => ({
          media_type: m.media_type as 'image' | 'video',
          url: m.url,
          name: m.name,
        })),
      };

      return withRecipeOwnership(baseItem, { isUserOwned: true });
    });

    return {
      recipes: recipesWithMedia,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / limit),
      },
    };
  }

  /**
   * Get a single recipe by ID with full details
   */
  async getRecipeById(
    recipeId: string,
    userId: string
  ): Promise<{ envelope: RecipeEnvelope; isUserOwned: boolean } | null> {
    const { data: recipe, error } = await supabaseAdmin
      .from('recipes')
      .select('*')
      .eq('id', recipeId)
      .is('deleted_at', null)
      .single();

    if (error || !recipe) {
      return null;
    }

    // Check access: user owns it OR it's a global recipe
    const isUserOwned = recipe.user_id === userId;
    if (recipe.user_id !== null && !isUserOwned) {
      return null;
    }

    // Get ingredients, steps, media
    const [
      { data: ingredients },
      { data: steps },
      { data: media },
    ] = await Promise.all([
      supabaseAdmin
        .from('recipe_ingredients')
        .select('*')
        .eq('recipe_id', recipeId)
        .order('position'),
      supabaseAdmin
        .from('recipe_steps')
        .select('*')
        .eq('recipe_id', recipeId)
        .order('position'),
      supabaseAdmin
        .from('recipe_media')
        .select('*')
        .eq('recipe_id', recipeId)
        .order('position'),
    ]);

    return {
      envelope: dbToEnvelope(
        recipe as Recipe,
        (ingredients ?? []) as RecipeIngredient[],
        (steps ?? []) as RecipeStep[],
        (media ?? []) as RecipeMedia[]
      ),
      isUserOwned,
    };
  }

  /**
   * Create a new recipe (accepts both envelope and legacy format)
   */
  async createRecipe(
    input: RecipeEnvelope | LegacyCreateRecipe,
    userId: string
  ): Promise<Recipe> {
    // Normalize to envelope format
    let envelope: RecipeEnvelope;
    if ('format' in input && input.format === 'whatEat-recipe') {
      envelope = recipeEnvelopeSchema.parse(input);
    } else {
      const legacy = legacyCreateRecipeSchema.parse(input);
      envelope = legacyToEnvelope(legacy);
    }

    // Insert recipe
    const recipeData = envelopeToDbRecipe(envelope, userId);
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .insert(recipeData)
      .select()
      .single();

    if (recipeError || !recipe) {
      throw new Error(`Failed to create recipe: ${recipeError?.message}`);
    }

    // Insert ingredients
    if (envelope.recipe.ingredients.length > 0) {
      const ingredientsData = envelopeToDbIngredients(envelope, recipe.id);
      const { error: ingError } = await supabaseAdmin
        .from('recipe_ingredients')
        .insert(ingredientsData);

      if (ingError) {
        // Cleanup on failure
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to create ingredients: ${ingError.message}`);
      }
    }

    // Insert steps
    if (envelope.recipe.steps.length > 0) {
      const stepsData = envelopeToDbSteps(envelope, recipe.id);
      const { error: stepsError } = await supabaseAdmin
        .from('recipe_steps')
        .insert(stepsData);

      if (stepsError) {
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to create steps: ${stepsError.message}`);
      }
    }

    // Insert media
    if (envelope.recipe.media.length > 0) {
      const mediaData = envelopeToDbMedia(envelope, recipe.id);
      const { error: mediaError } = await supabaseAdmin
        .from('recipe_media')
        .insert(mediaData);

      if (mediaError) {
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to create media: ${mediaError.message}`);
      }
    }

    logger.info({ recipeId: recipe.id, userId }, 'Created recipe');
    return recipe as Recipe;
  }

  /**
   * Update an existing recipe
   */
  async updateRecipe(
    recipeId: string,
    userId: string,
    input: Partial<RecipeEnvelope['recipe']>
  ): Promise<Recipe> {
    // Verify ownership
    const { data: existing } = await supabaseAdmin
      .from('recipes')
      .select('id')
      .eq('id', recipeId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single();

    if (!existing) {
      throw new Error('Recipe not found');
    }

    // Update recipe fields
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (input.title !== undefined) updateData.title = input.title;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.servings !== undefined) updateData.servings = input.servings;
    if (input.calories !== undefined) updateData.calories = input.calories;
    if (input.prep_time_minutes !== undefined) updateData.prep_time_minutes = input.prep_time_minutes;
    if (input.cook_time_minutes !== undefined) updateData.cook_time_minutes = input.cook_time_minutes;
    if (input.tags !== undefined) updateData.tags = normalizeRecipeTags(input.tags);
    if (input.cuisine !== undefined) updateData.cuisine = normalizeCuisine(input.cuisine);
    if (input.dietary_labels !== undefined) {
      updateData.dietary_labels = normalizeDietaryLabels(input.dietary_labels);
    }
    if (input.metadata !== undefined) updateData.metadata = input.metadata;

    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .update(updateData)
      .eq('id', recipeId)
      .select()
      .single();

    if (recipeError) {
      throw new Error(`Failed to update recipe: ${recipeError.message}`);
    }

    // Update ingredients if provided
    if (input.ingredients !== undefined) {
      await supabaseAdmin.from('recipe_ingredients').delete().eq('recipe_id', recipeId);

      if (input.ingredients.length > 0) {
        const ingredientsData = input.ingredients.map((ing, index) => ({
          recipe_id: recipeId,
          position: index + 1,
          raw_text: ing.raw_text,
        }));
        await supabaseAdmin.from('recipe_ingredients').insert(ingredientsData);
      }
    }

    // Update steps if provided
    if (input.steps !== undefined) {
      await supabaseAdmin.from('recipe_steps').delete().eq('recipe_id', recipeId);

      if (input.steps.length > 0) {
        const stepsData = input.steps.map((step, index) => ({
          recipe_id: recipeId,
          position: index + 1,
          instruction: step.instruction,
        }));
        await supabaseAdmin.from('recipe_steps').insert(stepsData);
      }
    }

    // Update media if provided
    if (input.media !== undefined) {
      await supabaseAdmin.from('recipe_media').delete().eq('recipe_id', recipeId);

      if (input.media.length > 0) {
        const mediaData = input.media.map((m, index) => ({
          recipe_id: recipeId,
          position: index + 1,
          media_type: m.media_type,
          url: m.url,
          name: m.name ?? null,
          is_generated: m.is_generated,
        }));
        await supabaseAdmin.from('recipe_media').insert(mediaData);
      }
    }

    logger.info({ recipeId, userId }, 'Updated recipe');
    return recipe as Recipe;
  }

  /**
   * Delete a recipe (soft delete)
   */
  async deleteRecipe(recipeId: string, userId: string): Promise<boolean> {
    const { error } = await supabaseAdmin
      .from('recipes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', recipeId)
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (error) {
      logger.error({ error, recipeId, userId }, 'Failed to delete recipe');
      return false;
    }

    logger.info({ recipeId, userId }, 'Deleted recipe');
    return true;
  }

  /**
   * Copy a recipe to user's collection (fork)
   */
  async copyRecipe(
    sourceRecipeId: string,
    userId: string,
    options?: { allowPrivate?: boolean }
  ): Promise<Recipe> {
    // Get source recipe
    const { data: source } = await supabaseAdmin
      .from('recipes')
      .select('*')
      .eq('id', sourceRecipeId)
      .is('deleted_at', null)
      .single();

    if (!source) {
      throw new Error('Source recipe not found');
    }

    // Check access: global recipe OR user owns it unless explicitly allowed
    if (!options?.allowPrivate && source.user_id !== null && source.user_id !== userId) {
      throw new Error('Cannot copy this recipe');
    }

    // Get ingredients, steps, media
    const [
      { data: ingredients },
      { data: steps },
      { data: media },
    ] = await Promise.all([
      supabaseAdmin.from('recipe_ingredients').select('*').eq('recipe_id', sourceRecipeId).order('position'),
      supabaseAdmin.from('recipe_steps').select('*').eq('recipe_id', sourceRecipeId).order('position'),
      supabaseAdmin.from('recipe_media').select('*').eq('recipe_id', sourceRecipeId).order('position'),
    ]);

    // Create new recipe
    const { data: newRecipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .insert({
        user_id: userId,
        title: source.title,
        description: source.description,
        servings: source.servings,
        calories: source.calories,
        prep_time_minutes: source.prep_time_minutes,
        cook_time_minutes: source.cook_time_minutes,
        tags: normalizeRecipeTags(source.tags),
        cuisine: normalizeCuisine(source.cuisine),
        dietary_labels: normalizeDietaryLabels(source.dietary_labels),
        source_type: source.source_type,
        source_recipe_id: sourceRecipeId,
        metadata: source.metadata,
      })
      .select()
      .single();

    if (recipeError || !newRecipe) {
      throw new Error(`Failed to copy recipe: ${recipeError?.message}`);
    }

    // Copy ingredients
    if (ingredients && ingredients.length > 0) {
      await supabaseAdmin.from('recipe_ingredients').insert(
        ingredients.map((ing) => ({
          recipe_id: newRecipe.id,
          position: ing.position,
          raw_text: ing.raw_text,
          quantity: ing.quantity,
          unit: ing.unit,
          ingredient_name: ing.ingredient_name,
        }))
      );
    }

    // Copy steps
    if (steps && steps.length > 0) {
      await supabaseAdmin.from('recipe_steps').insert(
        steps.map((step) => ({
          recipe_id: newRecipe.id,
          position: step.position,
          instruction: step.instruction,
        }))
      );
    }

    // Copy media
    if (media && media.length > 0) {
      await supabaseAdmin.from('recipe_media').insert(
        media.map((m) => ({
          recipe_id: newRecipe.id,
          position: m.position,
          media_type: m.media_type,
          url: m.url,
          storage_path: m.storage_path,
          name: m.name,
          is_generated: m.is_generated,
        }))
      );
    }

    logger.info({ sourceRecipeId, newRecipeId: newRecipe.id, userId }, 'Copied recipe');
    return newRecipe as Recipe;
  }
}

export const recipeService = new RecipeService();
