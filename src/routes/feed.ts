import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { feedService } from '../services/feed.service.js';
import { requireAuth, optionalAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { NotFoundError } from '../utils/errors.js';

const router = Router();

// Validation schemas
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /feed
 * List feed recipes (public, paginated)
 */
router.get('/', optionalAuth, async (req: Request, res: Response, next) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);

    const result = await feedService.getFeedRecipes(page, limit);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /feed/:id
 * Get single feed recipe details (public)
 */
router.get('/:id', optionalAuth, async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;

    const recipe = await feedService.getFeedRecipeById(id);

    if (!recipe) {
      throw new NotFoundError('Feed recipe');
    }

    res.json(recipe);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /feed/:id/save
 * Save a feed recipe to user's collection (creates a copy)
 */
router.post('/:id/save', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    const recipe = await feedService.saveFeedRecipeToUser(id, authReq.userId);

    res.status(201).json(recipe);
  } catch (err) {
    next(err);
  }
});

export default router;
