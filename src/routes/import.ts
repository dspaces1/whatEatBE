import { Router, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { BadRequestError, NotFoundError } from '../utils/errors.js';
import { importService } from '../services/import.service.js';

const router = Router();

// Validation schemas
const importUrlSchema = z.object({
  url: z.string().url(),
});

const importImageSchema = z.object({
  image_path: z.string().min(1),
});

// Import recipe from URL
router.post('/url', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { url } = importUrlSchema.parse(req.body);

    const result = await importService.previewFromUrl(url, authReq.userId);

    res.json({
      extracted_from: result.extracted_from,
      warnings: result.warnings,
      recipe_data: result.envelope.recipe,
      save_payload: result.envelope,
    });
  } catch (err) {
    next(err);
  }
});

// Import recipe from image
router.post('/image', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { image_path: _imagePath } = importImageSchema.parse(req.body);

    throw new BadRequestError('Image import is not yet available');
  } catch (err) {
    next(err);
  }
});

// Get job status
router.get('/jobs/:id', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { id } = req.params;

    const { data: job, error } = await supabaseAdmin
      .from('import_jobs')
      .select('*')
      .eq('id', id)
      .eq('user_id', authReq.userId)
      .single();

    if (error || !job) {
      throw new NotFoundError('Import job');
    }

    res.json(job);
  } catch (err) {
    next(err);
  }
});

// List user's import jobs
router.get('/jobs', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;

    const { data: jobs, error } = await supabaseAdmin
      .from('import_jobs')
      .select('*')
      .eq('user_id', authReq.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw new BadRequestError('Failed to fetch import jobs');
    }

    res.json({ jobs: jobs ?? [] });
  } catch (err) {
    next(err);
  }
});

export default router;

