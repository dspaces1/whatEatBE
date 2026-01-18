import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { aiService } from '../services/ai.service.js';
import { dbToEnvelope } from '../schemas/envelope.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { normalizeDietaryLabels } from '../utils/dietary-labels.js';
import { CANONICAL_CUISINES, normalizeCuisine } from '../utils/cuisines.js';
import { CANONICAL_RECIPE_TAGS, normalizeRecipeTags } from '../utils/recipe-tags.js';
import { withRecipeOwnership } from '../utils/recipe-payload.js';
import type { RecipeListItem, Recipe, RecipeIngredient, RecipeStep, RecipeMedia } from '../types/index.js';

const router = Router();

// Pagination schema
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Filter schema
const filterSchema = z.object({
  cuisine: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  dietary_labels: z.string().optional(), // comma-separated
});

/**
 * GET /feed
 * Get paginated feed of global AI recipes (public, user_id IS NULL)
 */
router.get('/', async (req: Request, res: Response, next) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const filters = filterSchema.parse(req.query);
    const offset = (page - 1) * limit;

    // Build query for global feed recipes (user_id IS NULL)
    let query = supabaseAdmin
      .from('recipes')
      .select('*', { count: 'exact' })
      .is('user_id', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (filters.cuisine) {
      const rawCuisine = filters.cuisine.trim();
      const normalizedCuisine = normalizeCuisine(rawCuisine);
      const cuisines = Array.from(new Set([rawCuisine, normalizedCuisine].filter(Boolean) as string[]));
      if (cuisines.length === 1) {
        query = query.eq('cuisine', cuisines[0]);
      } else if (cuisines.length > 1) {
        query = query.in('cuisine', cuisines);
      }
    }
    if (filters.tags) {
      const rawTags = filters.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const normalizedTags = normalizeRecipeTags(rawTags);
      const tags = Array.from(new Set([...rawTags, ...normalizedTags]));
      if (tags.length > 0) {
        query = query.overlaps('tags', tags);
      }
    }
    if (filters.dietary_labels) {
      const rawLabels = filters.dietary_labels.split(',').map((l) => l.trim()).filter(Boolean);
      const normalizedLabels = normalizeDietaryLabels(rawLabels);
      const labels = Array.from(new Set([...rawLabels, ...normalizedLabels]));
      if (labels.length > 0) {
        query = query.overlaps('dietary_labels', labels);
      }
    }

    const { data: recipes, error, count } = await query;

    if (error) {
      throw new Error(`Failed to fetch feed: ${error.message}`);
    }

    if (!recipes || recipes.length === 0) {
      return res.json({
        recipes: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      });
    }

    // Get media for all recipes
    const recipeIds = recipes.map((r) => r.id);
    const { data: media } = await supabaseAdmin
      .from('recipe_media')
      .select('recipe_id, media_type, url, name')
      .in('recipe_id', recipeIds)
      .order('position');

    // Map media to recipes
    const mediaByRecipeId = new Map<string, Array<{ media_type: string; url: string; name: string | null }>>();
    if (media) {
      for (const m of media) {
        const existing = mediaByRecipeId.get(m.recipe_id) || [];
        existing.push(m);
        mediaByRecipeId.set(m.recipe_id, existing);
      }
    }

    const recipesWithMedia: RecipeListItem[] = recipes.map((r) => {
      const baseItem = {
        id: r.id,
        title: r.title,
        description: r.description,
        calories: r.calories,
        prep_time_minutes: r.prep_time_minutes,
        cook_time_minutes: r.cook_time_minutes,
        servings: r.servings,
        tags: normalizeRecipeTags(r.tags ?? []),
        cuisine: normalizeCuisine(r.cuisine),
        source_type: r.source_type as 'manual' | 'url' | 'image' | 'ai',
        created_at: r.created_at,
        media: (mediaByRecipeId.get(r.id) || []).map((m) => ({
          media_type: m.media_type as 'image' | 'video',
          url: m.url,
          name: m.name,
        })),
      };

      return withRecipeOwnership(baseItem, { isUserOwned: false });
    });

    res.json({
      recipes: recipesWithMedia,
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

/**
 * GET /feed/:id
 * Get a single feed recipe with full details (returns envelope format)
 */
router.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;

    // Get recipe (must be global - user_id IS NULL)
    const { data: recipe, error } = await supabaseAdmin
      .from('recipes')
      .select('*')
      .eq('id', id)
      .is('user_id', null)
      .is('deleted_at', null)
      .single();

    if (error || !recipe) {
      throw new NotFoundError('Feed recipe');
    }

    // Get ingredients, steps, media
    const [
      { data: ingredients },
      { data: steps },
      { data: media },
    ] = await Promise.all([
      supabaseAdmin.from('recipe_ingredients').select('*').eq('recipe_id', id).order('position'),
      supabaseAdmin.from('recipe_steps').select('*').eq('recipe_id', id).order('position'),
      supabaseAdmin.from('recipe_media').select('*').eq('recipe_id', id).order('position'),
    ]);

    const envelope = dbToEnvelope(
      recipe as Recipe,
      (ingredients ?? []) as RecipeIngredient[],
      (steps ?? []) as RecipeStep[],
      (media ?? []) as RecipeMedia[]
    );

    res.json({ recipe_data: withRecipeOwnership(envelope.recipe, { isUserOwned: false }) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /feed/generate
 * Generate new AI recipes for the feed (admin/cron endpoint)
 * In production, this should be protected by an API key or admin auth
 */
router.post('/generate', async (req: Request, res: Response, next) => {
  try {
    const { count = 3 } = z.object({
      count: z.coerce.number().int().min(1).max(10).default(3),
    }).parse(req.body || {});

    logger.info({ count }, 'Generating feed recipes');

    const envelopes = await aiService.generateFeedRecipes(count);

    if (envelopes.length === 0) {
      throw new BadRequestError('Failed to generate recipes. Is OpenAI API key configured?');
    }

    // Save all generated recipes
    const savedRecipes = [];
    for (const envelope of envelopes) {
      const saved = await aiService.saveGeneratedRecipe(envelope);
      if (saved) {
        savedRecipes.push({
          id: saved.id,
          title: saved.title,
          created_at: saved.created_at,
        });
      }
    }

    res.status(201).json({
      generated: savedRecipes.length,
      recipes: savedRecipes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /feed/cuisines
 * Get list of available cuisines in the feed
 */
router.get('/meta/cuisines', async (_req: Request, res: Response, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('recipes')
      .select('cuisine')
      .is('user_id', null)
      .is('deleted_at', null)
      .not('cuisine', 'is', null);

    if (error) {
      throw new Error(`Failed to fetch cuisines: ${error.message}`);
    }

    const normalized = (data ?? [])
      .map((r) => normalizeCuisine(r.cuisine))
      .filter(Boolean) as string[];
    const cuisineSet = new Set(normalized);
    const cuisines = CANONICAL_CUISINES.filter((cuisine) => cuisineSet.has(cuisine));
    res.json({ cuisines });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /feed/tags
 * Get list of available tags in the feed
 */
router.get('/meta/tags', async (_req: Request, res: Response, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('recipes')
      .select('tags')
      .is('user_id', null)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to fetch tags: ${error.message}`);
    }

    const normalized = (data ?? [])
      .flatMap((r) => normalizeRecipeTags(r.tags ?? []));
    const tagSet = new Set(normalized);
    const tags = CANONICAL_RECIPE_TAGS.filter((tag) => tagSet.has(tag));
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

export default router;
