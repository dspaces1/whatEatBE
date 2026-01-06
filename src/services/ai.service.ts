import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { SuggestedRecipeData, UserPreferences } from '../types/index.js';

export class AIService {
  /**
   * Generate daily recipe suggestions for a user
   */
  async generateDailySuggestions(
    userId: string,
    preferences: UserPreferences,
    count: number = 3
  ): Promise<SuggestedRecipeData[]> {
    if (!env.OPENAI_API_KEY) {
      logger.warn('OpenAI API key not configured');
      return [];
    }

    // TODO: Implement actual OpenAI integration
    // 1. Build a prompt based on user preferences
    // 2. Call OpenAI API
    // 3. Parse and validate response with Zod
    // 4. Return structured recipe data

    logger.info({ userId, count }, 'Generating daily suggestions');

    // Placeholder - return empty array until implemented
    return [];
  }

  /**
   * Generate a single recipe based on a prompt
   */
  async generateRecipe(
    prompt: string,
    preferences?: Partial<UserPreferences>
  ): Promise<SuggestedRecipeData | null> {
    if (!env.OPENAI_API_KEY) {
      logger.warn('OpenAI API key not configured');
      return null;
    }

    // TODO: Implement actual OpenAI integration
    logger.info({ prompt }, 'Generating recipe from prompt');

    return null;
  }

  /**
   * Parse a recipe from raw text using AI
   */
  async parseRecipeText(text: string): Promise<SuggestedRecipeData | null> {
    if (!env.OPENAI_API_KEY) {
      logger.warn('OpenAI API key not configured');
      return null;
    }

    // TODO: Implement actual OpenAI integration
    logger.info('Parsing recipe from text');

    return null;
  }

  /**
   * Store generated suggestions in the database
   */
  async storeSuggestions(
    userId: string,
    suggestions: SuggestedRecipeData[]
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 999); // End of today

    const { error } = await supabaseAdmin
      .from('daily_suggestions')
      .insert(
        suggestions.map((recipe_data) => ({
          user_id: userId,
          recipe_data,
          expires_at: expiresAt.toISOString(),
        }))
      );

    if (error) {
      logger.error({ userId, error }, 'Failed to store suggestions');
      throw new Error('Failed to store suggestions');
    }
  }

  /**
   * Increment AI generation counter for rate limiting
   */
  async incrementUsageCounter(userId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0];

    // Upsert the counter
    const { data, error } = await supabaseAdmin
      .from('usage_counters')
      .upsert(
        {
          user_id: userId,
          date: today,
          ai_generations_count: 1,
        },
        {
          onConflict: 'user_id,date',
        }
      )
      .select()
      .single();

    if (error) {
      logger.error({ userId, error }, 'Failed to update usage counter');
      return 0;
    }

    // If it was an update, we need to increment
    if (data && data.ai_generations_count > 1) {
      const { data: updated } = await supabaseAdmin
        .from('usage_counters')
        .update({ ai_generations_count: data.ai_generations_count + 1 })
        .eq('user_id', userId)
        .eq('date', today)
        .select()
        .single();

      return updated?.ai_generations_count ?? 0;
    }

    return data?.ai_generations_count ?? 1;
  }

  /**
   * Check if user has exceeded daily AI generation limit
   */
  async checkDailyLimit(userId: string, limit: number = 5): Promise<boolean> {
    const today = new Date().toISOString().split('T')[0];

    const { data } = await supabaseAdmin
      .from('usage_counters')
      .select('ai_generations_count')
      .eq('user_id', userId)
      .eq('date', today)
      .single();

    return (data?.ai_generations_count ?? 0) < limit;
  }
}

export const aiService = new AIService();



