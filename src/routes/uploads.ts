import crypto from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { BadRequestError } from '../utils/errors.js';

const router = Router();

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const createRecipeImageUploadSchema = z.object({
  content_type: z.string().min(1),
  file_name: z.string().max(200).optional(),
  file_size_bytes: z.number().int().positive(),
});

const contentTypeToExtension: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const sanitizeBaseName = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'recipe-image';
};

/**
 * POST /uploads/recipe-images
 * Create a signed upload URL for recipe images.
 */
router.post('/recipe-images', requireAuth, async (req, res: Response, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { content_type, file_name, file_size_bytes } = createRecipeImageUploadSchema.parse(req.body);

    const extension = contentTypeToExtension[content_type];
    if (!extension) {
      throw new BadRequestError('Unsupported content_type');
    }

    if (file_size_bytes > MAX_IMAGE_BYTES) {
      throw new BadRequestError('Image exceeds 10 MB max upload size');
    }

    const baseName = file_name ? sanitizeBaseName(file_name) : 'recipe-image';
    const fileName = `${baseName}-${crypto.randomUUID()}.${extension}`;
    const path = `recipe-images/${authReq.userId}/${fileName}`;

    const { data, error } = await supabaseAdmin.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data?.signedUrl) {
      throw new BadRequestError('Failed to create upload URL');
    }

    const { data: publicData } = supabaseAdmin.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(path);

    res.status(201).json({
      upload_url: data.signedUrl,
      token: data.token ?? null,
      path,
      public_url: publicData.publicUrl,
      method: 'PUT',
      headers: {
        'Content-Type': content_type,
      },
      max_size_bytes: MAX_IMAGE_BYTES,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new BadRequestError('Invalid upload payload'));
    }
    next(err);
  }
});

export default router;
