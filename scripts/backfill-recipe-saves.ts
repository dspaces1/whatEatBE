import { createClient } from '@supabase/supabase-js';
import { logger } from '../src/utils/logger.js';
import type { Database } from '../src/types/supabase.js';

type RecipeRow = {
  id: string;
  user_id: string | null;
  created_at: string;
  source_recipe_id: string | null;
};

type RecipeSaveRow = {
  user_id: string;
  recipe_id: string;
};

const PAGE_SIZE = 500;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for backfill.');
}

const supabaseAdmin = createClient<Database>(supabaseUrl, supabaseServiceRoleKey);

const loadExistingSaveKeys = async (): Promise<Set<string>> => {
  const keys = new Set<string>();
  let offset = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('recipe_saves')
      .select('user_id, recipe_id')
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch recipe_saves: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      const save = row as RecipeSaveRow;
      keys.add(`${save.user_id}:${save.recipe_id}`);
    }

    if (data.length < PAGE_SIZE) {
      break;
    }

    offset += data.length;
  }

  return keys;
};

const insertRecipeSaves = async (
  rows: Array<{
    user_id: string;
    recipe_id: string;
    source_recipe_id: string | null;
    daily_plan_item_id: string | null;
    created_at: string;
  }>
): Promise<void> => {
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE);
    const { error } = await supabaseAdmin.from('recipe_saves').insert(chunk);
    if (error) {
      throw new Error(`Failed to insert recipe_saves: ${error.message}`);
    }
  }
};

const run = async (): Promise<void> => {
  logger.info('Backfilling recipe_saves for user-owned recipes');

  const existingKeys = await loadExistingSaveKeys();

  let offset = 0;
  let processed = 0;
  let created = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('recipes')
      .select('id, user_id, created_at, source_recipe_id')
      .not('user_id', 'is', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch recipes: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    const inserts: Array<{
      user_id: string;
      recipe_id: string;
      source_recipe_id: string | null;
      daily_plan_item_id: string | null;
      created_at: string;
    }> = [];

    for (const row of data) {
      const recipe = row as RecipeRow;
      processed += 1;

      if (!recipe.user_id) {
        continue;
      }

      const key = `${recipe.user_id}:${recipe.id}`;
      if (existingKeys.has(key)) {
        continue;
      }

      existingKeys.add(key);
      inserts.push({
        user_id: recipe.user_id,
        recipe_id: recipe.id,
        source_recipe_id: recipe.source_recipe_id ?? null,
        daily_plan_item_id: null,
        created_at: recipe.created_at,
      });
    }

    if (inserts.length > 0) {
      await insertRecipeSaves(inserts);
      created += inserts.length;
    }

    if (processed % 1000 === 0) {
      logger.info({ processed, created }, 'Backfill progress');
    }

    if (data.length < PAGE_SIZE) {
      break;
    }

    offset += data.length;
  }

  logger.info({ processed, created }, 'Backfill completed');
};

run().catch((error) => {
  logger.error({ error }, 'Backfill failed');
  process.exitCode = 1;
});
