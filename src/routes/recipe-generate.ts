import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { aiService } from '../services/ai.service.js';
import { BadRequestError, RateLimitError } from '../utils/errors.js';
import { withRecipeOwnership } from '../utils/recipe-payload.js';

const router = Router();

const generateSchema = z.object({
  text: z.string().min(5).max(2000),
});

/**
 * POST /recipe/generate
 * Generate a recipe from user text (preview-only)
 */
router.post('/generate', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { text } = generateSchema.parse(req.body ?? {});

    const allowed = await aiService.checkDailyLimit(authReq.userId);
    if (!allowed) {
      throw new RateLimitError('Daily AI generation limit reached');
    }

    await aiService.incrementUsageCounter(authReq.userId);

    const result = await aiService.generateRecipeFromText(text);

    if (!result) {
      throw new BadRequestError('Failed to generate recipe. Is OpenAI API key configured?');
    }

    if (!result.isMealRequest) {
      throw new BadRequestError('That does not look like a meal request.', {
        reason: result.nonMealReason ?? null,
      });
    }

    if (!result.envelope) {
      throw new BadRequestError('Failed to generate recipe.');
    }

    res.json({
      extracted_from: 'ai',
      warnings: [],
      recipe_data: withRecipeOwnership(result.envelope.recipe, { isUserOwned: false }),
      save_payload: result.envelope,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
