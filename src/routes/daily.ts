import { Router, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth, requireDailyGenerationAdmin, AuthenticatedRequest } from '../middleware/auth.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';
import { dailyGenerationService } from '../services/daily-generation.service.js';
import type { Json } from '../types/index.js';

const router = Router();

const generateSchema = z.object({
  count_per_meal: z.coerce.number().int().min(1).max(5).default(2),
});

const refreshSchema = z.object({
  count_per_meal: z.coerce.number().int().min(1).max(5).default(2),
});

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'dessert'] as const;
type MealType = typeof MEAL_TYPES[number];

type SuggestionRecipeData = {
  title?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

type SuggestionRow = {
  id: string;
  recipe_data: SuggestionRecipeData;
  generated_at: string;
  saved_recipe_id?: string | null;
  run_id?: string | null;
  trigger_source?: string;
  rank?: number | null;
};

const MAX_REFRESH_POOL = 500;

const normalizeMealType = (value: unknown): MealType | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (MEAL_TYPES as readonly string[]).includes(normalized)
    ? (normalized as MealType)
    : null;
};

const getMealType = (recipe: SuggestionRecipeData): MealType | null => {
  const metadataMealType = normalizeMealType(recipe.metadata?.meal_type);
  if (metadataMealType) {
    return metadataMealType;
  }

  const tags = recipe.tags ?? [];
  for (const tag of tags) {
    const normalized = normalizeMealType(tag);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const pickRandom = <T,>(items: T[], count: number): T[] => {
  if (items.length <= count) {
    return items.slice();
  }

  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy.slice(0, count);
};

// Get today's daily suggestions
router.get('/suggestions', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = today.toISOString().split('T')[0];

    const { data: latestRun, error: runError } = await supabaseAdmin
      .from('daily_recipe_runs')
      .select('id, status, trigger_source, created_at')
      .eq('user_id', authReq.userId)
      .eq('target_date', targetDate)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runError && runError.code !== 'PGRST116') {
      throw new BadRequestError('Failed to fetch daily run');
    }

    let suggestionsQuery = supabaseAdmin
      .from('daily_suggestions')
      .select('*')
      .eq('user_id', authReq.userId)
      .is('saved_recipe_id', null);

    if (latestRun?.id) {
      suggestionsQuery = suggestionsQuery
        .eq('run_id', latestRun.id)
        .order('rank', { ascending: true })
        .order('generated_at', { ascending: false });
    } else {
      suggestionsQuery = suggestionsQuery
        .gte('generated_at', today.toISOString())
        .order('generated_at', { ascending: false });
    }

    const { data: suggestions, error } = await suggestionsQuery;

    if (error) {
      throw new BadRequestError('Failed to fetch suggestions');
    }

    res.json({ suggestions: suggestions ?? [], run: latestRun ?? null });
  } catch (err) {
    next(err);
  }
});

// Refresh daily suggestions with random historical recipes (no persistence)
router.get('/refresh', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { count_per_meal: countPerMeal } = refreshSchema.parse(req.query);

    const { data, error } = await supabaseAdmin
      .from('daily_suggestions')
      .select('id, recipe_data, generated_at, saved_recipe_id, run_id, trigger_source, rank')
      .eq('user_id', authReq.userId)
      .is('saved_recipe_id', null)
      .order('generated_at', { ascending: false })
      .limit(MAX_REFRESH_POOL);

    if (error) {
      throw new BadRequestError('Failed to fetch historical suggestions');
    }

    const buckets: Record<MealType, SuggestionRow[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      dessert: [],
    };

    for (const row of data ?? []) {
      const suggestion = row as SuggestionRow;
      const mealType = getMealType(suggestion.recipe_data);
      if (mealType) {
        buckets[mealType].push(suggestion);
      }
    }

    const suggestions = {
      breakfast: pickRandom(buckets.breakfast, countPerMeal),
      lunch: pickRandom(buckets.lunch, countPerMeal),
      dinner: pickRandom(buckets.dinner, countPerMeal),
      dessert: pickRandom(buckets.dessert, countPerMeal),
    };

    res.json({ suggestions });
  } catch (err) {
    next(err);
  }
});

// Generate new daily suggestions (manual trigger)
router.post('/generate', requireAuth, requireDailyGenerationAdmin, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { count_per_meal: countPerMeal } = generateSchema.parse(req.body ?? {});

    const result = await dailyGenerationService.generateSharedForAllUsers({
      countPerMeal,
      triggerSource: 'manual',
    });

    const runId = result.runIdsByUser[authReq.userId];
    if (!runId) {
      throw new BadRequestError('No daily suggestions generated for this user');
    }

    const { data: suggestions, error } = await supabaseAdmin
      .from('daily_suggestions')
      .select('*')
      .eq('user_id', authReq.userId)
      .eq('run_id', runId)
      .order('rank', { ascending: true });

    if (error) {
      throw new BadRequestError('Failed to fetch generated suggestions');
    }

    res.status(201).json({
      run_id: runId,
      suggestions: suggestions ?? [],
    });
  } catch (err) {
    next(err);
  }
});

// Save a daily suggestion as a recipe
router.post('/suggestions/:id/save', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    // Get the suggestion
    const { data: suggestion, error: fetchError } = await supabaseAdmin
      .from('daily_suggestions')
      .select('*')
      .eq('id', id)
      .eq('user_id', authReq.userId)
      .single();

    if (fetchError || !suggestion) {
      throw new NotFoundError('Suggestion');
    }

    if (suggestion.saved_recipe_id) {
      throw new BadRequestError('Suggestion already saved');
    }

    // Extract recipe data from the suggestion
    const recipeData = suggestion.recipe_data as {
      title?: string;
      description?: string;
      ingredients?: Array<{ raw_text: string; quantity?: number; unit?: string; ingredient_name?: string }>;
      steps?: Array<{ instruction: string }>;
      prep_time_minutes?: number;
      cook_time_minutes?: number;
      servings?: number;
      calories?: number;
      tags?: string[];
      cuisine?: string;
      dietary_labels?: string[];
      metadata?: Record<string, unknown>;
      media?: Array<{ media_type: 'image' | 'video'; url: string; name?: string | null; is_generated?: boolean }>;
    };

    // Create the recipe
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .insert({
        user_id: authReq.userId,
        title: recipeData.title ?? 'Untitled Recipe',
        description: recipeData.description,
        source_type: 'ai',
        prep_time_minutes: recipeData.prep_time_minutes,
        cook_time_minutes: recipeData.cook_time_minutes,
        servings: recipeData.servings,
        calories: recipeData.calories,
        tags: recipeData.tags ?? [],
        cuisine: recipeData.cuisine,
        dietary_labels: recipeData.dietary_labels ?? [],
        metadata: (recipeData.metadata ?? {}) as Json,
      })
      .select()
      .single();

    if (recipeError || !recipe) {
      throw new BadRequestError('Failed to create recipe from suggestion');
    }

    // Create ingredients
    if (recipeData.ingredients && recipeData.ingredients.length > 0) {
      await supabaseAdmin
        .from('recipe_ingredients')
        .insert(
          recipeData.ingredients.map((ing, index) => ({
            recipe_id: recipe.id,
            position: index + 1,
            raw_text: ing.raw_text,
            quantity: ing.quantity,
            unit: ing.unit,
            ingredient_name: ing.ingredient_name,
          }))
        );
    }

    // Create steps
    if (recipeData.steps && recipeData.steps.length > 0) {
      await supabaseAdmin
        .from('recipe_steps')
        .insert(
          recipeData.steps.map((step, index) => ({
            recipe_id: recipe.id,
            position: index + 1,
            instruction: step.instruction,
          }))
        );
    }

    // Create media
    if (recipeData.media && recipeData.media.length > 0) {
      await supabaseAdmin
        .from('recipe_media')
        .insert(
          recipeData.media.map((media, index) => ({
            recipe_id: recipe.id,
            position: index + 1,
            media_type: media.media_type,
            url: media.url,
            name: media.name ?? null,
            is_generated: media.is_generated ?? false,
          }))
        );
    }

    // Update the suggestion with the saved recipe ID
    await supabaseAdmin
      .from('daily_suggestions')
      .update({ saved_recipe_id: recipe.id })
      .eq('id', id);

    res.status(201).json(recipe);
  } catch (err) {
    next(err);
  }
});

// Get user preferences
router.get('/preferences', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;

    const { data: preferences, error } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .eq('user_id', authReq.userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 is "not found" - that's okay, we'll return defaults
      throw new BadRequestError('Failed to fetch preferences');
    }

    res.json({
      preferences: preferences ?? {
        user_id: authReq.userId,
        dietary_restrictions: [],
        preferred_cuisines: [],
        excluded_ingredients: [],
      },
    });
  } catch (err) {
    next(err);
  }
});

// Update user preferences
router.put('/preferences', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { dietary_restrictions, preferred_cuisines, excluded_ingredients } = req.body;

    const { data: preferences, error } = await supabaseAdmin
      .from('user_preferences')
      .upsert({
        user_id: authReq.userId,
        dietary_restrictions: dietary_restrictions ?? [],
        preferred_cuisines: preferred_cuisines ?? [],
        excluded_ingredients: excluded_ingredients ?? [],
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new BadRequestError('Failed to update preferences');
    }

    res.json({ preferences });
  } catch (err) {
    next(err);
  }
});

export default router;
