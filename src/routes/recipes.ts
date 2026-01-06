import { Router, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';

const router = Router();

// Validation schemas
const createRecipeSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  source_type: z.enum(['manual', 'url', 'image', 'ai']).default('manual'),
  source_url: z.string().url().optional(),
  image_path: z.string().optional(),
  prep_time_minutes: z.number().int().positive().optional(),
  cook_time_minutes: z.number().int().positive().optional(),
  servings: z.number().int().positive().optional(),
  ingredients: z.array(z.object({
    raw_text: z.string().min(1),
    quantity: z.number().optional(),
    unit: z.string().optional(),
    ingredient_name: z.string().optional(),
  })).optional(),
  steps: z.array(z.object({
    instruction: z.string().min(1),
  })).optional(),
});

const updateRecipeSchema = createRecipeSchema.partial();

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

// List recipes
router.get('/', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { page, limit, search } = paginationSchema.parse(req.query);
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('recipes')
      .select('*', { count: 'exact' })
      .eq('user_id', authReq.userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike('title', `%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    res.json({
      recipes: data,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// Get single recipe
router.get('/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    // Get recipe
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .select('*')
      .eq('id', id)
      .eq('user_id', authReq.userId)
      .is('deleted_at', null)
      .single();

    if (recipeError || !recipe) {
      throw new NotFoundError('Recipe');
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

    res.json({
      ...recipe,
      ingredients: ingredients ?? [],
      steps: steps ?? [],
    });
  } catch (err) {
    next(err);
  }
});

// Create recipe
router.post('/', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const validatedData = createRecipeSchema.parse(req.body);
    const { ingredients, steps, ...recipeData } = validatedData;

    // Create recipe
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .insert({
        ...recipeData,
        user_id: authReq.userId,
      })
      .select()
      .single();

    if (recipeError || !recipe) {
      throw new BadRequestError('Failed to create recipe');
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
        throw new BadRequestError('Failed to create ingredients');
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
        throw new BadRequestError('Failed to create steps');
      }
    }

    res.status(201).json(recipe);
  } catch (err) {
    next(err);
  }
});

// Update recipe
router.patch('/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;
    const validatedData = updateRecipeSchema.parse(req.body);
    const { ingredients, steps, ...recipeData } = validatedData;

    // Verify ownership
    const { data: existing } = await supabaseAdmin
      .from('recipes')
      .select('id')
      .eq('id', id)
      .eq('user_id', authReq.userId)
      .is('deleted_at', null)
      .single();

    if (!existing) {
      throw new NotFoundError('Recipe');
    }

    // Update recipe
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from('recipes')
      .update({
        ...recipeData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (recipeError) {
      throw new BadRequestError('Failed to update recipe');
    }

    // Update ingredients if provided
    if (ingredients !== undefined) {
      // Delete existing ingredients
      await supabaseAdmin
        .from('recipe_ingredients')
        .delete()
        .eq('recipe_id', id);

      // Insert new ingredients
      if (ingredients.length > 0) {
        await supabaseAdmin
          .from('recipe_ingredients')
          .insert(
            ingredients.map((ing, index) => ({
              recipe_id: id,
              position: index + 1,
              ...ing,
            }))
          );
      }
    }

    // Update steps if provided
    if (steps !== undefined) {
      // Delete existing steps
      await supabaseAdmin
        .from('recipe_steps')
        .delete()
        .eq('recipe_id', id);

      // Insert new steps
      if (steps.length > 0) {
        await supabaseAdmin
          .from('recipe_steps')
          .insert(
            steps.map((step, index) => ({
              recipe_id: id,
              position: index + 1,
              ...step,
            }))
          );
      }
    }

    res.json(recipe);
  } catch (err) {
    next(err);
  }
});

// Delete recipe (soft delete)
router.delete('/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('recipes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', authReq.userId)
      .is('deleted_at', null);

    if (error) {
      throw new NotFoundError('Recipe');
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;



