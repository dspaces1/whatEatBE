import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../src/utils/logger.js';
import { normalizeDietaryLabels } from '../src/utils/dietary-labels.js';
import { normalizeCuisine } from '../src/utils/cuisines.js';
import { normalizeRecipeTags } from '../src/utils/recipe-tags.js';
import type { Database } from '../src/types/supabase.js';

type SuggestionRow = {
  id: string;
  user_id: string;
  recipe_data: unknown;
  generated_at: string;
  saved_recipe_id: string | null;
  run_id: string | null;
  trigger_source: string | null;
  rank: number | null;
};

type RunRow = {
  id: string;
  target_date: string;
  trigger_source: string;
  status: string;
  created_at: string;
  completed_at: string | null;
};

type PlanInfo = {
  id: string;
  plan_date: string;
  trigger_source: string;
  status: 'processing' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
};

const PAGE_SIZE = 500;
const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'dessert']);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for backfill.');
}

const supabaseAdmin = createClient<Database>(supabaseUrl, supabaseServiceRoleKey);

const normalizeMealType = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return MEAL_TYPES.has(normalized) ? normalized : null;
};

const getMealType = (recipeData: Record<string, unknown>): string | null => {
  const metadata = recipeData.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const fromMetadata = normalizeMealType((metadata as Record<string, unknown>).meal_type);
    if (fromMetadata) {
      return fromMetadata;
    }
  }

  const tags = Array.isArray(recipeData.tags) ? recipeData.tags : [];
  for (const tag of tags) {
    const fromTag = normalizeMealType(tag);
    if (fromTag) {
      return fromTag;
    }
  }

  return null;
};

const toDateString = (value: string): string => value.split('T')[0];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];

const toNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const mapRunStatus = (status: string): PlanInfo['status'] => {
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'processing') return 'processing';
  return 'completed';
};

const fetchAllRuns = async (): Promise<Map<string, RunRow>> => {
  const runsById = new Map<string, RunRow>();
  let offset = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('daily_recipe_runs')
      .select('*')
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch daily_recipe_runs: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      runsById.set(row.id, row as RunRow);
    }

    if (data.length < PAGE_SIZE) {
      break;
    }

    offset += data.length;
  }

  return runsById;
};

const scanSuggestions = async (
  handler: (row: SuggestionRow) => Promise<void>
): Promise<void> => {
  let offset = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('daily_suggestions')
      .select(
        'id, user_id, recipe_data, generated_at, saved_recipe_id, run_id, trigger_source, rank'
      )
      .order('generated_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch daily_suggestions: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      await handler(row as SuggestionRow);
    }

    if (data.length < PAGE_SIZE) {
      break;
    }

    offset += data.length;
  }
};

const upsertPlans = async (plans: PlanInfo[]): Promise<void> => {
  if (plans.length === 0) return;

  const chunks: PlanInfo[][] = [];
  for (let i = 0; i < plans.length; i += PAGE_SIZE) {
    chunks.push(plans.slice(i, i + PAGE_SIZE));
  }

  for (const chunk of chunks) {
    const { error } = await supabaseAdmin.from('daily_meal_plans').upsert(chunk);
    if (error) {
      throw new Error(`Failed to upsert daily_meal_plans: ${error.message}`);
    }
  }
};

const getPlanId = (
  row: SuggestionRow,
  runsById: Map<string, RunRow>,
  plansById: Map<string, PlanInfo>,
  fallbackPlans: Map<string, PlanInfo>
): string => {
  if (row.run_id) {
    const run = runsById.get(row.run_id);
    if (!plansById.has(row.run_id)) {
      const planDate = run?.target_date ?? toDateString(row.generated_at);
      plansById.set(row.run_id, {
        id: row.run_id,
        plan_date: planDate,
        trigger_source: run?.trigger_source ?? row.trigger_source ?? 'scheduled',
        status: run ? mapRunStatus(run.status) : 'completed',
        created_at: run?.created_at ?? row.generated_at,
        completed_at: run?.completed_at ?? row.generated_at,
      });
    }
    return row.run_id;
  }

  const planDate = toDateString(row.generated_at);
  const triggerSource = row.trigger_source ?? 'scheduled';
  const key = `${planDate}:${triggerSource}`;
  const existing = fallbackPlans.get(key);
  if (existing) {
    return existing.id;
  }

  const planId = crypto.randomUUID();
  fallbackPlans.set(key, {
    id: planId,
    plan_date: planDate,
    trigger_source: triggerSource,
    status: 'completed',
    created_at: row.generated_at,
    completed_at: row.generated_at,
  });
  return planId;
};

const nextAvailableRank = (used: Set<number>): number => {
  let candidate = 1;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
};

const buildRecipeInsert = (recipeData: Record<string, unknown>) => {
  const metadata = isObject(recipeData.metadata) ? recipeData.metadata : {};

  return {
    user_id: null,
    title: typeof recipeData.title === 'string' ? recipeData.title : 'Untitled Recipe',
    description: typeof recipeData.description === 'string' ? recipeData.description : null,
    servings: toNumberOrNull(recipeData.servings),
    calories: toNumberOrNull(recipeData.calories),
    prep_time_minutes: toNumberOrNull(recipeData.prep_time_minutes),
    cook_time_minutes: toNumberOrNull(recipeData.cook_time_minutes),
    tags: normalizeRecipeTags(recipeData.tags),
    cuisine: normalizeCuisine(recipeData.cuisine),
    dietary_labels: normalizeDietaryLabels(recipeData.dietary_labels),
    source_type: 'ai',
    source_url: null,
    source_recipe_id: null,
    metadata,
  };
};

const buildIngredientsInsert = (recipeId: string, recipeData: Record<string, unknown>) => {
  const ingredients = Array.isArray(recipeData.ingredients) ? recipeData.ingredients : [];
  return ingredients
    .filter((ing) => isObject(ing) && typeof ing.raw_text === 'string')
    .map((ing, index) => ({
      recipe_id: recipeId,
      position: index + 1,
      raw_text: ing.raw_text,
      quantity: toNumberOrNull(ing.quantity),
      unit: typeof ing.unit === 'string' ? ing.unit : null,
      ingredient_name: typeof ing.ingredient_name === 'string' ? ing.ingredient_name : null,
    }));
};

const buildStepsInsert = (recipeId: string, recipeData: Record<string, unknown>) => {
  const steps = Array.isArray(recipeData.steps) ? recipeData.steps : [];
  return steps
    .filter((step) => isObject(step) && typeof step.instruction === 'string')
    .map((step, index) => ({
      recipe_id: recipeId,
      position: index + 1,
      instruction: step.instruction,
    }));
};

const buildMediaInsert = (recipeId: string, recipeData: Record<string, unknown>) => {
  const media = Array.isArray(recipeData.media) ? recipeData.media : [];
  return media
    .filter((item) => isObject(item) && typeof item.url === 'string' && typeof item.media_type === 'string')
    .map((item, index) => ({
      recipe_id: recipeId,
      position: index + 1,
      media_type: item.media_type === 'video' ? 'video' : 'image',
      url: item.url,
      name: typeof item.name === 'string' ? item.name : null,
      is_generated: typeof item.is_generated === 'boolean' ? item.is_generated : false,
    }));
};

const insertRecipeFromSuggestion = async (recipeData: Record<string, unknown>): Promise<string> => {
  const { data: recipe, error } = await supabaseAdmin
    .from('recipes')
    .insert(buildRecipeInsert(recipeData))
    .select('id')
    .single();

  if (error || !recipe) {
    throw new Error(`Failed to insert recipe: ${error?.message ?? 'unknown error'}`);
  }

  const ingredients = buildIngredientsInsert(recipe.id, recipeData);
  if (ingredients.length > 0) {
    const { error: ingError } = await supabaseAdmin.from('recipe_ingredients').insert(ingredients);
    if (ingError) {
      throw new Error(`Failed to insert ingredients: ${ingError.message}`);
    }
  }

  const steps = buildStepsInsert(recipe.id, recipeData);
  if (steps.length > 0) {
    const { error: stepError } = await supabaseAdmin.from('recipe_steps').insert(steps);
    if (stepError) {
      throw new Error(`Failed to insert steps: ${stepError.message}`);
    }
  }

  const media = buildMediaInsert(recipe.id, recipeData);
  if (media.length > 0) {
    const { error: mediaError } = await supabaseAdmin.from('recipe_media').insert(media);
    if (mediaError) {
      throw new Error(`Failed to insert media: ${mediaError.message}`);
    }
  }

  return recipe.id;
};

async function main(): Promise<void> {
  logger.info('Loading daily recipe runs');
  const runsById = await fetchAllRuns();

  const plansById = new Map<string, PlanInfo>();
  const fallbackPlans = new Map<string, PlanInfo>();
  const usedRanksByPlan = new Map<string, Set<number>>();

  logger.info('Scanning daily suggestions for plan metadata');
  await scanSuggestions(async (row) => {
    const planId = getPlanId(row, runsById, plansById, fallbackPlans);
    if (typeof row.rank === 'number') {
      const used = usedRanksByPlan.get(planId) ?? new Set<number>();
      used.add(row.rank);
      usedRanksByPlan.set(planId, used);
    }
  });

  await upsertPlans([...plansById.values(), ...fallbackPlans.values()]);
  logger.info({ count: plansById.size + fallbackPlans.size }, 'Upserted daily meal plans');

  let processed = 0;
  let createdItems = 0;
  let createdSaves = 0;

  logger.info('Backfilling daily meal plan items and recipe saves');
  await scanSuggestions(async (row) => {
    processed += 1;

    const planId = getPlanId(row, runsById, plansById, fallbackPlans);
    const used = usedRanksByPlan.get(planId) ?? new Set<number>();

    let rank = row.rank;
    if (typeof rank !== 'number') {
      rank = nextAvailableRank(used);
    }
    used.add(rank);
    usedRanksByPlan.set(planId, used);

    const existingItem = await supabaseAdmin
      .from('daily_meal_plan_items')
      .select('id, recipe_id, plan_id')
      .eq('id', row.id)
      .maybeSingle();

    let recipeId = existingItem.data?.recipe_id ?? null;
    let planItemId = existingItem.data?.id ?? null;

    if (!recipeId) {
      if (!isObject(row.recipe_data)) {
        throw new Error(`Invalid recipe_data for suggestion ${row.id}`);
      }

      const mealType = getMealType(row.recipe_data) ?? 'dinner';
      recipeId = await insertRecipeFromSuggestion(row.recipe_data);

      const { error: insertError } = await supabaseAdmin
        .from('daily_meal_plan_items')
        .insert({
          id: row.id,
          plan_id: planId,
          recipe_id: recipeId,
          meal_type: mealType,
          rank,
          created_at: row.generated_at,
        });

      if (insertError) {
        throw new Error(`Failed to insert daily meal plan item: ${insertError.message}`);
      }

      planItemId = row.id;
      createdItems += 1;
    }

    if (row.saved_recipe_id && planItemId) {
      const { error: updateError } = await supabaseAdmin
        .from('recipes')
        .update({ source_recipe_id: recipeId })
        .eq('id', row.saved_recipe_id)
        .is('source_recipe_id', null);

      if (updateError) {
        throw new Error(`Failed to update saved recipe source: ${updateError.message}`);
      }

      const { error: saveError } = await supabaseAdmin
        .from('recipe_saves')
        .upsert(
          {
            user_id: row.user_id,
            recipe_id: row.saved_recipe_id,
            source_recipe_id: recipeId,
            daily_plan_item_id: planItemId,
          },
          { onConflict: 'user_id,daily_plan_item_id' }
        );

      if (saveError) {
        throw new Error(`Failed to insert recipe save: ${saveError.message}`);
      }

      createdSaves += 1;
    }

    if (processed % 100 === 0) {
      logger.info({ processed, createdItems, createdSaves }, 'Backfill progress');
    }
  });

  logger.info({ processed, createdItems, createdSaves }, 'Backfill completed');
}

main().catch((error) => {
  logger.error({ error }, 'Backfill failed');
  process.exit(1);
});
