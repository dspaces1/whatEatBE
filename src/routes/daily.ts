import { Router, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth, requireDailyGenerationAdmin, AuthenticatedRequest } from '../middleware/auth.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';
import { dailyGenerationService } from '../services/daily-generation.service.js';
import { recipeService } from '../services/recipe.service.js';
import { dbToEnvelope, type RecipeEnvelope } from '../schemas/envelope.js';
import type { Recipe, RecipeIngredient, RecipeStep, RecipeMedia } from '../types/index.js';

const router = Router();

const generateSchema = z.object({
  count_per_meal: z.coerce.number().int().min(1).max(5).default(2),
});

const refreshSchema = z.object({
  count_per_meal: z.coerce.number().int().min(1).max(5).default(2),
});

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'dessert'] as const;
type MealType = typeof MEAL_TYPES[number];

type SuggestionRecipeData = RecipeEnvelope['recipe'];

type SuggestionRow = {
  id: string;
  user_id?: string;
  recipe_data: SuggestionRecipeData;
  generated_at: string;
  expires_at?: string;
  saved_recipe_id?: string | null;
  run_id?: string | null;
  trigger_source?: string;
  rank?: number | null;
};

type PlanItemRow = {
  id: string;
  plan_id: string;
  recipe_id: string;
  meal_type: MealType;
  rank: number;
  created_at: string;
};

const MAX_REFRESH_POOL = 500;

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

const buildRecipeDataById = async (
  recipeIds: string[]
): Promise<Map<string, SuggestionRecipeData>> => {
  const dataById = new Map<string, SuggestionRecipeData>();
  if (recipeIds.length === 0) {
    return dataById;
  }

  const { data: recipes, error: recipeError } = await supabaseAdmin
    .from('recipes')
    .select('*')
    .in('id', recipeIds)
    .is('deleted_at', null);

  if (recipeError) {
    throw new BadRequestError('Failed to fetch recipes');
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
  for (const ingredient of ingredients ?? []) {
    const existing = ingredientsByRecipeId.get(ingredient.recipe_id) ?? [];
    existing.push(ingredient as RecipeIngredient);
    ingredientsByRecipeId.set(ingredient.recipe_id, existing);
  }

  const stepsByRecipeId = new Map<string, RecipeStep[]>();
  for (const step of steps ?? []) {
    const existing = stepsByRecipeId.get(step.recipe_id) ?? [];
    existing.push(step as RecipeStep);
    stepsByRecipeId.set(step.recipe_id, existing);
  }

  const mediaByRecipeId = new Map<string, RecipeMedia[]>();
  for (const item of media ?? []) {
    const existing = mediaByRecipeId.get(item.recipe_id) ?? [];
    existing.push(item as RecipeMedia);
    mediaByRecipeId.set(item.recipe_id, existing);
  }

  for (const recipe of recipes ?? []) {
    const envelope = dbToEnvelope(
      recipe as Recipe,
      ingredientsByRecipeId.get(recipe.id) ?? [],
      stepsByRecipeId.get(recipe.id) ?? [],
      mediaByRecipeId.get(recipe.id) ?? []
    );
    dataById.set(recipe.id, envelope.recipe);
  }

  return dataById;
};

// Get today's daily suggestions
router.get('/suggestions', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = today.toISOString().split('T')[0];

    const { data: latestPlan, error: planError } = await supabaseAdmin
      .from('daily_meal_plans')
      .select('id, status, trigger_source, created_at')
      .eq('plan_date', targetDate)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (planError && planError.code !== 'PGRST116') {
      throw new BadRequestError('Failed to fetch daily plan');
    }

    if (!latestPlan) {
      res.json({ suggestions: [], run: null });
      return;
    }

    const { data: planItems, error: planItemsError } = await supabaseAdmin
      .from('daily_meal_plan_items')
      .select('id, recipe_id, meal_type, rank')
      .eq('plan_id', latestPlan.id)
      .order('rank', { ascending: true });

    if (planItemsError) {
      throw new BadRequestError('Failed to fetch suggestions');
    }

    const itemIds = (planItems ?? []).map((item) => item.id);
    const recipeIds = (planItems ?? []).map((item) => item.recipe_id);
    const recipeDataById = await buildRecipeDataById(recipeIds);

    const savedByItemId = new Map<string, string>();
    if (itemIds.length > 0) {
      const { data: saves, error: savesError } = await supabaseAdmin
        .from('recipe_saves')
        .select('daily_plan_item_id, recipe_id')
        .eq('user_id', authReq.userId)
        .in('daily_plan_item_id', itemIds);

      if (savesError) {
        throw new BadRequestError('Failed to fetch saved suggestions');
      }

      for (const save of saves ?? []) {
        if (save.daily_plan_item_id) {
          savedByItemId.set(save.daily_plan_item_id, save.recipe_id);
        }
      }
    }

    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 999);

    const suggestions: SuggestionRow[] = [];
    for (const item of planItems ?? []) {
      const recipeData = recipeDataById.get(item.recipe_id);
      if (!recipeData) {
        throw new BadRequestError('Failed to resolve suggestion recipes');
      }

      suggestions.push({
        id: item.id,
        user_id: authReq.userId,
        recipe_data: recipeData,
        generated_at: latestPlan.created_at,
        expires_at: expiresAt.toISOString(),
        saved_recipe_id: savedByItemId.get(item.id) ?? null,
        run_id: latestPlan.id,
        trigger_source: latestPlan.trigger_source,
        rank: item.rank,
      });
    }

    res.json({ suggestions, run: latestPlan });
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
      .from('daily_meal_plan_items')
      .select('id, plan_id, recipe_id, meal_type, rank, created_at')
      .order('created_at', { ascending: false })
      .limit(MAX_REFRESH_POOL);

    if (error) {
      throw new BadRequestError('Failed to fetch historical suggestions');
    }

    const savedItemIds = new Set<string>();
    if (data && data.length > 0) {
      const { data: saves, error: savesError } = await supabaseAdmin
        .from('recipe_saves')
        .select('daily_plan_item_id')
        .eq('user_id', authReq.userId)
        .in('daily_plan_item_id', data.map((item) => item.id));

      if (savesError) {
        throw new BadRequestError('Failed to fetch saved suggestions');
      }

      for (const save of saves ?? []) {
        if (save.daily_plan_item_id) {
          savedItemIds.add(save.daily_plan_item_id);
        }
      }
    }

    const buckets: Record<MealType, PlanItemRow[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      dessert: [],
    };

    for (const row of data ?? []) {
      const item = row as PlanItemRow;
      if (savedItemIds.has(item.id)) {
        continue;
      }
      buckets[item.meal_type].push(item);
    }

    const selections = {
      breakfast: pickRandom(buckets.breakfast, countPerMeal),
      lunch: pickRandom(buckets.lunch, countPerMeal),
      dinner: pickRandom(buckets.dinner, countPerMeal),
      dessert: pickRandom(buckets.dessert, countPerMeal),
    };

    const selectedItems = [
      ...selections.breakfast,
      ...selections.lunch,
      ...selections.dinner,
      ...selections.dessert,
    ];

    const recipeIds = selectedItems.map((item) => item.recipe_id);
    const recipeDataById = await buildRecipeDataById(recipeIds);

    const planIds = Array.from(new Set(selectedItems.map((item) => item.plan_id)));
    const planById = new Map<string, { trigger_source: string; created_at: string }>();
    if (planIds.length > 0) {
      const { data: plans, error: planError } = await supabaseAdmin
        .from('daily_meal_plans')
        .select('id, trigger_source, created_at')
        .in('id', planIds);

      if (planError) {
        throw new BadRequestError('Failed to fetch plan metadata');
      }

      for (const plan of plans ?? []) {
        planById.set(plan.id, {
          trigger_source: plan.trigger_source,
          created_at: plan.created_at,
        });
      }
    }

    const toSuggestion = (item: PlanItemRow): SuggestionRow => {
      const recipeData = recipeDataById.get(item.recipe_id);
      if (!recipeData) {
        throw new BadRequestError('Failed to resolve suggestion recipes');
      }

      const planMeta = planById.get(item.plan_id);
      return {
        id: item.id,
        recipe_data: recipeData,
        generated_at: planMeta?.created_at ?? item.created_at,
        saved_recipe_id: null,
        run_id: item.plan_id,
        trigger_source: planMeta?.trigger_source,
        rank: item.rank,
      };
    };

    const suggestions = {
      breakfast: selections.breakfast.map(toSuggestion),
      lunch: selections.lunch.map(toSuggestion),
      dinner: selections.dinner.map(toSuggestion),
      dessert: selections.dessert.map(toSuggestion),
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

    const { data: plan, error: planError } = await supabaseAdmin
      .from('daily_meal_plans')
      .select('id, trigger_source, created_at')
      .eq('id', result.planId)
      .single();

    if (planError || !plan) {
      throw new BadRequestError('Failed to fetch generated plan');
    }

    const { data: planItems, error: itemsError } = await supabaseAdmin
      .from('daily_meal_plan_items')
      .select('id, recipe_id, meal_type, rank')
      .eq('plan_id', plan.id)
      .order('rank', { ascending: true });

    if (itemsError) {
      throw new BadRequestError('Failed to fetch generated suggestions');
    }

    const recipeIds = (planItems ?? []).map((item) => item.recipe_id);
    const recipeDataById = await buildRecipeDataById(recipeIds);

    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 999);

    const suggestions: SuggestionRow[] = [];
    for (const item of planItems ?? []) {
      const recipeData = recipeDataById.get(item.recipe_id);
      if (!recipeData) {
        throw new BadRequestError('Failed to resolve suggestion recipes');
      }

      suggestions.push({
        id: item.id,
        user_id: authReq.userId,
        recipe_data: recipeData,
        generated_at: plan.created_at,
        expires_at: expiresAt.toISOString(),
        saved_recipe_id: null,
        run_id: plan.id,
        trigger_source: plan.trigger_source,
        rank: item.rank,
      });
    }

    res.status(201).json({
      run_id: plan.id,
      suggestions,
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

    const { data: planItem, error: fetchError } = await supabaseAdmin
      .from('daily_meal_plan_items')
      .select('id, recipe_id')
      .eq('id', id)
      .single();

    if (fetchError || !planItem) {
      throw new NotFoundError('Suggestion');
    }

    const { data: existingSave, error: saveLookupError } = await supabaseAdmin
      .from('recipe_saves')
      .select('id, recipe_id')
      .eq('user_id', authReq.userId)
      .eq('daily_plan_item_id', planItem.id)
      .maybeSingle();

    if (saveLookupError) {
      throw new BadRequestError('Failed to fetch saved suggestions');
    }

    if (existingSave) {
      throw new BadRequestError('Suggestion already saved');
    }

    const recipe = await recipeService.copyRecipe(planItem.recipe_id, authReq.userId);

    const { error: saveError } = await supabaseAdmin
      .from('recipe_saves')
      .insert({
        user_id: authReq.userId,
        recipe_id: recipe.id,
        source_recipe_id: planItem.recipe_id,
        daily_plan_item_id: planItem.id,
      });

    if (saveError) {
      throw new BadRequestError('Failed to save suggestion');
    }

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
