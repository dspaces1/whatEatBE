import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { shareService } from '../services/share.service.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';

const router = Router();

// Validation schemas
const createShareSchema = z.object({
  expires_in_days: z.number().int().positive().max(365).optional(),
});

// ============================================================================
// Public Routes (no auth required)
// ============================================================================

/**
 * GET /share/:token
 * View a shared recipe (public access)
 */
router.get('/:token', async (req: Request, res: Response, next) => {
  try {
    const { token } = req.params;

    const envelope = await shareService.getSharedRecipe(token);
    if (!envelope) {
      throw new NotFoundError('Shared recipe');
    }

    res.json(envelope);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Protected Routes (auth required)
// ============================================================================

/**
 * POST /share/recipe/:recipeId
 * Create a share link for a recipe
 */
router.post('/recipe/:recipeId', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { recipeId } = req.params;
    const { expires_in_days } = createShareSchema.parse(req.body || {});

    const share = await shareService.createShareLink(recipeId, authReq.userId, expires_in_days);
    if (!share) {
      throw new BadRequestError('Could not create share link. You may not own this recipe.');
    }

    res.status(201).json({
      share_id: share.id,
      share_token: share.share_token,
      share_url: `/share/${share.share_token}`,
      expires_at: share.expires_at,
      created_at: share.created_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /share/recipe/:recipeId/links
 * Get all share links for a recipe
 */
router.get('/recipe/:recipeId/links', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { recipeId } = req.params;

    const shares = await shareService.getSharesForRecipe(recipeId, authReq.userId);

    res.json({
      shares: shares.map((s) => ({
        id: s.id,
        share_token: s.share_token,
        share_url: `/share/${s.share_token}`,
        expires_at: s.expires_at,
        view_count: s.view_count,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /share/:shareId
 * Revoke a share link
 */
router.delete('/:shareId', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { shareId } = req.params;

    const success = await shareService.revokeShare(shareId, authReq.userId);
    if (!success) {
      throw new NotFoundError('Share link');
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /share/:shareId/stats
 * Get statistics for a share link
 */
router.get('/:shareId/stats', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { shareId } = req.params;

    const share = await shareService.getShareStats(shareId, authReq.userId);
    if (!share) {
      throw new NotFoundError('Share link');
    }

    res.json({
      id: share.id,
      recipe_id: share.recipe_id,
      share_token: share.share_token,
      view_count: share.view_count,
      expires_at: share.expires_at,
      created_at: share.created_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
