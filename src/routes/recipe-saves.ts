import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { recipeSavesService } from '../services/recipe-saves.service.js';
import { BadRequestError } from '../utils/errors.js';

const router = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createRecipeSaveSchema = z.discriminatedUnion('source_type', [
  z.object({
    source_type: z.literal('daily_plan_item'),
    source_id: z.string().uuid(),
  }),
  z.object({
    source_type: z.literal('recipe'),
    source_id: z.string().uuid(),
  }),
  z.object({
    source_type: z.literal('share'),
    source_id: z.string().min(1),
  }),
]);

/**
 * GET /recipe-saves
 * List user's saved recipes
 */
router.get('/', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { page, limit } = paginationSchema.parse(req.query);

    const result = await recipeSavesService.listRecipeSaves(authReq.userId, page, limit);

    res.json({
      recipe_saves: result.recipe_saves,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /recipe-saves
 * Save a recipe from a daily plan item, recipe id, or share token
 */
router.post('/', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const payload = createRecipeSaveSchema.parse(req.body);

    const result = await recipeSavesService.createRecipeSave(authReq.userId, payload);

    res.status(201).json({
      id: result.id,
      recipe_id: result.recipe_id,
      recipe_title: result.recipe_title,
      source_recipe_id: result.source_recipe_id,
      daily_plan_item_id: result.daily_plan_item_id,
      created_at: result.created_at,
      recipe: result.recipe,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new BadRequestError('Invalid recipe save payload'));
    }
    next(err);
  }
});

/**
 * DELETE /recipe-saves/:id
 * Unsave a recipe (removes save record + soft deletes the saved copy)
 */
router.delete('/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    await recipeSavesService.deleteRecipeSave(authReq.userId, id);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
