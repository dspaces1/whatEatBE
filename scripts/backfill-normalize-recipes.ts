import { createClient } from '@supabase/supabase-js';
import { logger } from '../src/utils/logger.js';
import { normalizeCuisine } from '../src/utils/cuisines.js';
import { normalizeDietaryLabels } from '../src/utils/dietary-labels.js';
import { normalizeRecipeTags } from '../src/utils/recipe-tags.js';
import type { Database } from '../src/types/supabase.js';

type RecipeRow = {
  id: string;
  cuisine: string | null;
  dietary_labels: string[] | null;
  tags: string[] | null;
};

const PAGE_SIZE = 500;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for backfill.');
}

const supabaseAdmin = createClient<Database>(supabaseUrl, supabaseServiceRoleKey);

const arraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

const normalizeRow = (row: RecipeRow): { changed: boolean; update: RecipeRow } => {
  const nextCuisine = normalizeCuisine(row.cuisine);
  const nextDietaryLabels = normalizeDietaryLabels(row.dietary_labels ?? []);
  const nextTags = normalizeRecipeTags(row.tags ?? []);

  const cuisineChanged = (row.cuisine ?? null) !== nextCuisine;
  const dietaryChanged = !arraysEqual(row.dietary_labels ?? [], nextDietaryLabels);
  const tagsChanged = !arraysEqual(row.tags ?? [], nextTags);

  return {
    changed: cuisineChanged || dietaryChanged || tagsChanged,
    update: {
      id: row.id,
      cuisine: nextCuisine,
      dietary_labels: nextDietaryLabels,
      tags: nextTags,
    },
  };
};

const run = async (): Promise<void> => {
  let page = 0;
  let totalUpdated = 0;

  while (true) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabaseAdmin
      .from('recipes')
      .select('id, cuisine, dietary_labels, tags')
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to);

    if (error) {
      const details = [error.code, error.details, error.hint].filter(Boolean).join(' | ');
      throw new Error(`Failed to fetch recipes: ${error.message}${details ? ` (${details})` : ''}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    const updates = data
      .map((row) => normalizeRow(row as RecipeRow))
      .filter((result) => result.changed)
      .map((result) => result.update);

    if (updates.length > 0) {
      let batchUpdated = 0;
      for (const update of updates) {
        const { error: updateError } = await supabaseAdmin
          .from('recipes')
          .update({
            cuisine: update.cuisine,
            dietary_labels: update.dietary_labels,
            tags: update.tags,
            updated_at: new Date().toISOString(),
          })
          .eq('id', update.id);

        if (updateError) {
          const details = [updateError.code, updateError.details, updateError.hint].filter(Boolean).join(' | ');
          throw new Error(
            `Failed to update recipe ${update.id}: ${updateError.message}${details ? ` (${details})` : ''}`
          );
        }
        batchUpdated += 1;
      }

      totalUpdated += batchUpdated;
      logger.info({ page, updates: batchUpdated, totalUpdated }, 'Normalized recipe batch');
    } else {
      logger.info({ page }, 'No recipe updates needed for batch');
    }

    if (data.length < PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  logger.info({ totalUpdated }, 'Completed cuisine/dietary label normalization backfill');
};

run().catch((error) => {
  const err = error as { message?: string; stack?: string };
  logger.error({
    message: err?.message ?? 'Unknown error',
    stack: err?.stack,
    error,
  }, 'Normalization backfill failed');
  process.exit(1);
});
