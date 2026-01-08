import { supabaseAdmin } from '../config/supabase.js';
import type {
  FeedRecipe,
  FeedRecipeIngredient,
  FeedRecipeStep,
  FeedRecipeMedia,
  Recipe,
} from '../types/index.js';

export interface FeedRecipeListItem {
  id: string;
  title: string;
  description: string | null;
  calories: number | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  servings: number | null;
  created_at: string;
  media: FeedRecipeMedia[];
}

export interface PaginatedFeedResult {
  recipes: FeedRecipeListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class FeedService {
  /**
   * Get paginated list of feed recipes with media
   */
  async getFeedRecipes(page: number = 1, limit: number = 20): Promise<PaginatedFeedResult> {
    const offset = (page - 1) * limit;

    // Get feed recipes
    const { data: recipes, error, count } = await supabaseAdmin
      .from('feed_recipes')
      .select('*', { count: 'exact' })
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to fetch feed recipes: ${error.message}`);
    }

    if (!recipes || recipes.length === 0) {
      return {
        recipes: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0,
        },
      };
    }

    // Get media for all recipes
    const recipeIds = recipes.map((r) => r.id);
    const { data: media } = await supabaseAdmin
      .from('feed_recipe_media')
      .select('*')
      .in('feed_recipe_id', recipeIds)
      .order('position');

    // Map media to recipes
    const mediaByRecipeId = new Map<string, FeedRecipeMedia[]>();
    if (media) {
      for (const m of media) {
        const existing = mediaByRecipeId.get(m.feed_recipe_id) || [];
        existing.push(m as FeedRecipeMedia);
        mediaByRecipeId.set(m.feed_recipe_id, existing);
      }
    }

    const recipesWithMedia: FeedRecipeListItem[] = recipes.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      calories: r.calories,
      prep_time_minutes: r.prep_time_minutes,
      cook_time_minutes: r.cook_time_minutes,
      servings: r.servings,
      created_at: r.created_at,
      media: mediaByRecipeId.get(r.id) || [],
    }));

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
   * Get a single feed recipe by ID with full details
   */
  async getFeedRecipeById(id: string): Promise<FeedRecipe | null> {
    const { data: recipe, error } = await supabaseAdmin
      .from('feed_recipes')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (error || !recipe) {
      return null;
    }

    // Get ingredients
    const { data: ingredients } = await supabaseAdmin
      .from('feed_recipe_ingredients')
      .select('*')
      .eq('feed_recipe_id', id)
      .order('position');

    // Get steps
    const { data: steps } = await supabaseAdmin
      .from('feed_recipe_steps')
      .select('*')
      .eq('feed_recipe_id', id)
      .order('position');

    // Get media
    const { data: media } = await supabaseAdmin
      .from('feed_recipe_media')
      .select('*')
      .eq('feed_recipe_id', id)
      .order('position');

    return {
      ...recipe,
      ingredients: (ingredients ?? []) as FeedRecipeIngredient[],
      steps: (steps ?? []) as FeedRecipeStep[],
      media: (media ?? []) as FeedRecipeMedia[],
    } as FeedRecipe;
  }

  /**
   * Save a feed recipe to user's collection (creates a copy)
   */
  async saveFeedRecipeToUser(feedRecipeId: string, userId: string): Promise<Recipe> {
    // Get the feed recipe with all details
    const feedRecipe = await this.getFeedRecipeById(feedRecipeId);

    if (!feedRecipe) {
      throw new Error('Feed recipe not found');
    }

    // Create the user's recipe copy
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .insert({
        user_id: userId,
        title: feedRecipe.title,
        description: feedRecipe.description,
        source_type: 'ai',
        source_feed_recipe_id: feedRecipeId,
        calories: feedRecipe.calories,
        prep_time_minutes: feedRecipe.prep_time_minutes,
        cook_time_minutes: feedRecipe.cook_time_minutes,
        servings: feedRecipe.servings,
      })
      .select()
      .single();

    if (recipeError || !recipe) {
      throw new Error(`Failed to save recipe: ${recipeError?.message}`);
    }

    // Copy ingredients
    if (feedRecipe.ingredients && feedRecipe.ingredients.length > 0) {
      const { error: ingredientsError } = await supabaseAdmin
        .from('recipe_ingredients')
        .insert(
          feedRecipe.ingredients.map((ing) => ({
            recipe_id: recipe.id,
            position: ing.position,
            raw_text: ing.raw_text,
            quantity: ing.quantity,
            unit: ing.unit,
            ingredient_name: ing.ingredient_name,
          }))
        );

      if (ingredientsError) {
        // Rollback recipe creation
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to copy ingredients: ${ingredientsError.message}`);
      }
    }

    // Copy steps
    if (feedRecipe.steps && feedRecipe.steps.length > 0) {
      const { error: stepsError } = await supabaseAdmin
        .from('recipe_steps')
        .insert(
          feedRecipe.steps.map((step) => ({
            recipe_id: recipe.id,
            position: step.position,
            instruction: step.instruction,
          }))
        );

      if (stepsError) {
        // Rollback
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to copy steps: ${stepsError.message}`);
      }
    }

    // Copy media
    if (feedRecipe.media && feedRecipe.media.length > 0) {
      const { error: mediaError } = await supabaseAdmin
        .from('recipe_media')
        .insert(
          feedRecipe.media.map((m) => ({
            recipe_id: recipe.id,
            position: m.position,
            media_type: m.media_type,
            url: m.url,
            name: m.name,
          }))
        );

      if (mediaError) {
        // Rollback
        await supabaseAdmin.from('recipes').delete().eq('id', recipe.id);
        throw new Error(`Failed to copy media: ${mediaError.message}`);
      }
    }

    return recipe as Recipe;
  }
}

export const feedService = new FeedService();
