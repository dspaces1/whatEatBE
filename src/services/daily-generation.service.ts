import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { aiService } from './ai.service.js';
import { logger } from '../utils/logger.js';
import { BadRequestError } from '../utils/errors.js';
import type { UserPreferences } from '../types/index.js';
import type { RecipeEnvelope } from '../schemas/envelope.js';

type TriggerSource = 'manual' | 'scheduled';

interface GenerateOptions {
  count?: number;
  triggerSource?: TriggerSource;
  targetDate?: string;
}

interface GenerationResult {
  runId: string;
  suggestions: RecipeEnvelope[];
}

interface SharedGenerateOptions {
  triggerSource?: TriggerSource;
  targetDate?: string;
  countPerMeal?: number;
}

interface SharedGenerationResult {
  runIdsByUser: Record<string, string>;
  suggestions: RecipeEnvelope[];
}

const DEFAULT_COUNT = 1; // todo change back to 3
const DEFAULT_COUNT_PER_MEAL = 1; // todo change back to 2

export class DailyGenerationService {
  async generateForUser(userId: string, options: GenerateOptions = {}): Promise<GenerationResult> {
    const triggerSource = options.triggerSource ?? 'manual';
    const count = options.count ?? DEFAULT_COUNT;
    const targetDate = options.targetDate ?? new Date().toISOString().split('T')[0];

    const { data: run, error: runError } = await supabaseAdmin
      .from('daily_recipe_runs')
      .insert({
        user_id: userId,
        trigger_source: triggerSource,
        target_date: targetDate,
        status: 'processing',
      })
      .select()
      .single();

    if (runError || !run) {
      logger.error({ userId, runError }, 'Failed to create daily recipe run');
      throw new Error('Failed to create daily run');
    }

    try {
      const remaining = await this.getRemainingGenerations(userId);
      if (remaining <= 0) {
        await this.markRun(run.id, 'failed');
        throw new BadRequestError('Daily AI limit reached');
      }

      const targetCount = Math.min(count, remaining);
      const preferences = await this.loadPreferences(userId);
      const suggestions = await aiService.generateDailySuggestions(preferences, targetCount);

      if (suggestions.length === 0) {
        await this.markRun(run.id, 'failed');
        throw new Error('Failed to generate suggestions');
      }

      await aiService.storeSuggestions(userId, suggestions, {
        runId: run.id,
        triggerSource,
      });

      for (let i = 0; i < suggestions.length; i++) {
        await aiService.incrementUsageCounter(userId);
      }

      await this.markRun(run.id, 'completed');
      await this.supersedePreviousRuns(userId, targetDate, run.id);

      return { runId: run.id, suggestions };
    } catch (error) {
      await this.markRun(run.id, 'failed');
      throw error;
    }
  }

  async generateSharedForAllUsers(options: SharedGenerateOptions = {}): Promise<SharedGenerationResult> {
    const triggerSource = options.triggerSource ?? 'scheduled';
    const countPerMeal = options.countPerMeal ?? DEFAULT_COUNT_PER_MEAL;
    const targetDate = options.targetDate ?? new Date().toISOString().split('T')[0];

    const userIds = await this.listAllUserIds();
    if (userIds.length === 0) {
      logger.info('No users available for daily generation');
      return { runIdsByUser: {}, suggestions: [] };
    }

    const suggestions = await aiService.generateMealPlan(countPerMeal);
    if (suggestions.length === 0) {
      throw new Error('Failed to generate shared suggestions');
    }

    const runIdsByUser: Record<string, string> = {};

    for (const userId of userIds) {
      const { data: run, error: runError } = await supabaseAdmin
        .from('daily_recipe_runs')
        .insert({
          user_id: userId,
          trigger_source: triggerSource,
          target_date: targetDate,
          status: 'processing',
        })
        .select()
        .single();

      if (runError || !run) {
        logger.error({ userId, runError }, 'Failed to create daily recipe run');
        continue;
      }

      runIdsByUser[userId] = run.id;

      try {
        await aiService.storeSuggestions(userId, suggestions, {
          runId: run.id,
          triggerSource,
        });

        await this.markRun(run.id, 'completed');
        await this.supersedePreviousRuns(userId, targetDate, run.id);
      } catch (error) {
        await this.markRun(run.id, 'failed');
        logger.error({ userId, error }, 'Failed to store shared suggestions');
      }
    }

    return { runIdsByUser, suggestions };
  }

  private async listAllUserIds(): Promise<string[]> {
    const userIds: string[] = [];
    const perPage = 1000;
    let page = 1;

    while (true) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      });

      if (error) {
        logger.error({ error }, 'Failed to list users');
        throw new Error('Failed to list users');
      }

      const users = data?.users ?? [];
      userIds.push(...users.map((user) => user.id));

      if (users.length < perPage) {
        break;
      }

      page += 1;
    }

    return userIds;
  }

  private async loadPreferences(userId: string): Promise<Partial<UserPreferences>> {
    const { data, error } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error({ userId, error }, 'Failed to fetch user preferences');
      throw new Error('Failed to fetch preferences');
    }

    return (
      data ?? {
        user_id: userId,
        dietary_restrictions: [],
        preferred_cuisines: [],
        excluded_ingredients: [],
      }
    );
  }

  private async getRemainingGenerations(userId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabaseAdmin
      .from('usage_counters')
      .select('ai_generations_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      logger.error({ userId, error }, 'Failed to read usage counter');
      return 0;
    }

    const used = data?.ai_generations_count ?? 0;
    return Math.max(0, env.DAILY_AI_GENERATION_LIMIT - used);
  }

  private async supersedePreviousRuns(userId: string, targetDate: string, runId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('daily_recipe_runs')
      .update({ status: 'superseded', superseded_by: runId })
      .eq('user_id', userId)
      .eq('target_date', targetDate)
      .neq('id', runId)
      .is('superseded_by', null);

    if (error) {
      logger.warn({ userId, error }, 'Failed to supersede previous daily runs');
    }
  }

  private async markRun(runId: string, status: 'completed' | 'failed'): Promise<void> {
    const { error } = await supabaseAdmin
      .from('daily_recipe_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);

    if (error) {
      logger.warn({ runId, error }, 'Failed to update daily run status');
    }
  }
}

export const dailyGenerationService = new DailyGenerationService();
