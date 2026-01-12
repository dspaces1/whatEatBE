import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { recipeService } from '../services/recipe.service.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';

const router = Router();

// Pagination schema
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

/**
 * GET /recipes
 * List user's recipes with pagination
 */
router.get('/', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { page, limit, search } = paginationSchema.parse(req.query);

    const result = await recipeService.getUserRecipes(authReq.userId, page, limit, search);

    res.json({
      recipes: result.recipes,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /recipes/:id
 * Get a single recipe with full details (returns envelope format)
 */
router.get('/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    const envelope = await recipeService.getRecipeById(id, authReq.userId);
    if (!envelope) {
      throw new NotFoundError('Recipe');
    }

    res.json(envelope);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /recipes
 * Create a new recipe (accepts both envelope and legacy flat format)
 */
router.post('/', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;

    const recipe = await recipeService.createRecipe(req.body, authReq.userId);

    res.status(201).json({
      id: recipe.id,
      title: recipe.title,
      created_at: recipe.created_at,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new BadRequestError('Invalid recipe data'));
    }
    next(err);
  }
});

/**
 * PATCH /recipes/:id
 * Update an existing recipe
 */
router.patch('/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    const recipe = await recipeService.updateRecipe(id, authReq.userId, req.body);

    res.json({
      id: recipe.id,
      title: recipe.title,
      updated_at: recipe.updated_at,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'Recipe not found') {
      return next(new NotFoundError('Recipe'));
    }
    next(err);
  }
});

/**
 * DELETE /recipes/:id
 * Delete a recipe (soft delete)
 */
router.delete('/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    const success = await recipeService.deleteRecipe(id, authReq.userId);
    if (!success) {
      throw new NotFoundError('Recipe');
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /recipes/:id/copy
 * Copy a recipe to user's collection (fork from feed or shared recipe)
 */
router.post('/:id/copy', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    const recipe = await recipeService.copyRecipe(id, authReq.userId);

    res.status(201).json({
      id: recipe.id,
      title: recipe.title,
      source_recipe_id: recipe.source_recipe_id,
      created_at: recipe.created_at,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return next(new NotFoundError('Recipe'));
    }
    if (err instanceof Error && err.message.includes('Cannot copy')) {
      return next(new BadRequestError(err.message));
    }
    next(err);
  }
});

export default router;
