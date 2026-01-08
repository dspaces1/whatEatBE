import { supabaseAdmin } from '../config/supabase.js';
import type { Recipe, RecipeIngredient, RecipeStep, RecipeMedia } from '../types/index.js';

export interface CreateRecipeInput {
  user_id: string;
  title: string;
  description?: string;
  source_type: 'manual' | 'url' | 'image' | 'ai';
  source_url?: string;
  source_feed_recipe_id?: string;
  image_path?: string;
  calories?: number;
  prep_time_minutes?: number;
  cook_time_minutes?: number;
  servings?: number;
  ingredients?: Array<{
    raw_text: string;
    quantity?: number;
    unit?: string;
    ingredient_name?: string;
  }>;
  steps?: Array<{
    instruction: string;
  }>;
  media?: Array<{
    media_type: 'image' | 'video';
    url: string;
    name?: string;
  }>;
}

export class RecipeService {
  /**
   * Create a new recipe with ingredients, steps, and media
   */
  async create(input: CreateRecipeInput): Promise<Recipe> {
    const { ingredients, steps, media, ...recipeData } = input;

    // Create recipe
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .insert(recipeData)
      .select()
      .single();

    if (recipeError || !recipe) {
      throw new Error(`Failed to create recipe: ${recipeError?.message}`);
    }

    // Create ingredients
    if (ingredients && ingredients.length > 0) {
      const { error: ingredientsError } = await supabaseAdmin
        .from('recipe_ingredients')
        .insert(
          ingredients.map((ing, index) => ({
            recipe_id: recipe.id,
            position: index + 1,
            ...ing,
          }))
        );

      if (ingredientsError) {
        // Rollback recipe creation
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to create ingredients: ${ingredientsError.message}`);
      }
    }

    // Create steps
    if (steps && steps.length > 0) {
      const { error: stepsError } = await supabaseAdmin
        .from('recipe_steps')
        .insert(
          steps.map((step, index) => ({
            recipe_id: recipe.id,
            position: index + 1,
            ...step,
          }))
        );

      if (stepsError) {
        // Rollback recipe creation
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to create steps: ${stepsError.message}`);
      }
    }

    // Create media
    if (media && media.length > 0) {
      const { error: mediaError } = await supabaseAdmin
        .from('recipe_media')
        .insert(
          media.map((m, index) => ({
            recipe_id: recipe.id,
            position: index + 1,
            ...m,
          }))
        );

      if (mediaError) {
        // Rollback recipe creation
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to create media: ${mediaError.message}`);
      }
    }

    return recipe as Recipe;
  }

  /**
   * Get a recipe by ID with ingredients, steps, and media
   */
  async getById(id: string, userId: string): Promise<Recipe | null> {
    const { data: recipe, error } = await supabaseAdmin
      .from('recipes')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single();

    if (error || !recipe) {
      return null;
    }

    // Get ingredients
    const { data: ingredients } = await supabaseAdmin
      .from('recipe_ingredients')
      .select('*')
      .eq('recipe_id', id)
      .order('position');

    // Get steps
    const { data: steps } = await supabaseAdmin
      .from('recipe_steps')
      .select('*')
      .eq('recipe_id', id)
      .order('position');

    // Get media
    const { data: media } = await supabaseAdmin
      .from('recipe_media')
      .select('*')
      .eq('recipe_id', id)
      .order('position');

    return {
      ...recipe,
      ingredients: (ingredients ?? []) as RecipeIngredient[],
      steps: (steps ?? []) as RecipeStep[],
      media: (media ?? []) as RecipeMedia[],
    } as Recipe;
  }

  /**
   * Soft delete a recipe
   */
  async delete(id: string, userId: string): Promise<boolean> {
    const { error } = await supabaseAdmin
      .from('recipes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .is('deleted_at', null);

    return !error;
  }
}

export const recipeService = new RecipeService();





