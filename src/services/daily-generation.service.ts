import { supabaseAdmin } from '../config/supabase.js';
import { aiService } from './ai.service.js';
import { logger } from '../utils/logger.js';
import type { RecipeEnvelope } from '../schemas/envelope.js';

type TriggerSource = 'manual' | 'scheduled';

interface SharedGenerateOptions {
  triggerSource?: TriggerSource;
  targetDate?: string;
  countPerMeal?: number;
}

interface SharedGenerationResult {
  planId: string;
  suggestions: RecipeEnvelope[];
}

const DEFAULT_COUNT_PER_MEAL = 1; // todo change back to 2
const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'dessert']);

export class DailyGenerationService {
  async generateSharedForAllUsers(options: SharedGenerateOptions = {}): Promise<SharedGenerationResult> {
    const triggerSource = options.triggerSource ?? 'scheduled';
    const countPerMeal = options.countPerMeal ?? DEFAULT_COUNT_PER_MEAL;
    const planDate = options.targetDate ?? new Date().toISOString().split('T')[0];

    const { data: plan, error: planError } = await supabaseAdmin
      .from('daily_meal_plans')
      .insert({
        plan_date: planDate,
        trigger_source: triggerSource,
        status: 'processing',
      })
      .select()
      .single();

    if (planError || !plan) {
      logger.error({ planError }, 'Failed to create daily meal plan');
      throw new Error('Failed to create daily meal plan');
    }

    try {
      const suggestions = await aiService.generateMealPlan(countPerMeal);
      if (suggestions.length === 0) {
        await this.markPlan(plan.id, 'failed');
        throw new Error('Failed to generate shared suggestions');
      }

      const planItems: Array<{
        plan_id: string;
        recipe_id: string;
        meal_type: string;
        rank: number;
      }> = [];

      for (let i = 0; i < suggestions.length; i++) {
        const envelope = suggestions[i];
        const recipe = await aiService.saveGeneratedRecipe(envelope);
        if (!recipe) {
          throw new Error('Failed to save generated recipe');
        }

        const mealType = this.getMealType(envelope);
        if (!mealType) {
          throw new Error('Missing meal type for generated recipe');
        }

        planItems.push({
          plan_id: plan.id,
          recipe_id: recipe.id,
          meal_type: mealType,
          rank: i + 1,
        });
      }

      const { error: planItemsError } = await supabaseAdmin
        .from('daily_meal_plan_items')
        .insert(planItems);

      if (planItemsError) {
        logger.error({ planItemsError }, 'Failed to store daily meal plan items');
        throw new Error('Failed to store daily meal plan items');
      }

      await this.markPlan(plan.id, 'completed');
      return { planId: plan.id, suggestions };
    } catch (error) {
      await this.markPlan(plan.id, 'failed');
      throw error;
    }
  }

  private getMealType(envelope: RecipeEnvelope): string | null {
    const metadataMealType = envelope.recipe.metadata?.meal_type;
    if (typeof metadataMealType === 'string') {
      const normalized = metadataMealType.trim().toLowerCase();
      if (MEAL_TYPES.has(normalized)) {
        return normalized;
      }
    }

    const tags = envelope.recipe.tags ?? [];
    for (const tag of tags) {
      const normalized = tag.trim().toLowerCase();
      if (MEAL_TYPES.has(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  private async markPlan(planId: string, status: 'completed' | 'failed'): Promise<void> {
    const { error } = await supabaseAdmin
      .from('daily_meal_plans')
      .update({
        status,
        completed_at: new Date().toISOString(),
      })
      .eq('id', planId);

    if (error) {
      logger.warn({ planId, error }, 'Failed to update daily meal plan status');
    }
  }
}

export const dailyGenerationService = new DailyGenerationService();
