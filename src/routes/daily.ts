import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';

const router = Router();

// Get today's daily suggestions
router.get('/suggestions', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data: suggestions, error } = await supabaseAdmin
      .from('daily_suggestions')
      .select('*')
      .eq('user_id', authReq.userId)
      .gte('generated_at', today.toISOString())
      .is('saved_recipe_id', null)
      .order('generated_at', { ascending: false });

    if (error) {
      throw new BadRequestError('Failed to fetch suggestions');
    }

    res.json({ suggestions: suggestions ?? [] });
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
        daily_ai_enabled: false,
        dietary_restrictions: [],
        preferred_cuisines: [],
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
    const { daily_ai_enabled, dietary_restrictions, preferred_cuisines } = req.body;

    const { data: preferences, error } = await supabaseAdmin
      .from('user_preferences')
      .upsert({
        user_id: authReq.userId,
        daily_ai_enabled: daily_ai_enabled ?? false,
        dietary_restrictions: dietary_restrictions ?? [],
        preferred_cuisines: preferred_cuisines ?? [],
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



