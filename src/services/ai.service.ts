import OpenAI from 'openai';
import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { imageService } from './image.service.js';
import {
  aiRecipeOutputSchema,
  wrapAIOutput,
  envelopeToDbRecipe,
  envelopeToDbIngredients,
  envelopeToDbSteps,
  envelopeToDbMedia,
  type AIRecipeOutput,
  type RecipeEnvelope,
} from '../schemas/envelope.js';
import type { UserPreferences, Json, Recipe } from '../types/index.js';

// JSON schema for AI recipe output (for structured outputs)
const AI_RECIPE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    servings: { type: ['integer', 'null'] },
    calories: { type: ['integer', 'null'] },
    prep_time_minutes: { type: ['integer', 'null'] },
    cook_time_minutes: { type: ['integer', 'null'] },
    tags: { type: ['array', 'null'], items: { type: 'string' } },
    cuisine: { type: ['string', 'null'] },
    dietary_labels: { type: ['array', 'null'], items: { type: 'string' } },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: { raw_text: { type: 'string' } },
        required: ['raw_text'],
        additionalProperties: false,
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { instruction: { type: 'string' } },
        required: ['instruction'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'title',
    'description',
    'servings',
    'calories',
    'prep_time_minutes',
    'cook_time_minutes',
    'tags',
    'cuisine',
    'dietary_labels',
    'ingredients',
    'steps',
  ],
  additionalProperties: false,
} as const;

export class AIService {
  private openai: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 3 });
    }
  }

  /**
   * Generate a recipe based on user preferences
   */
  async generateRecipe(
    preferences?: Partial<UserPreferences>,
    theme?: string
  ): Promise<RecipeEnvelope | null> {
    if (!this.openai) {
      logger.warn('OpenAI API key not configured');
      return null;
    }

    try {
      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(preferences, theme);

      logger.info({ preferences }, 'Generating recipe with AI');

      const response = await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'recipe',
            strict: true,
            schema: AI_RECIPE_JSON_SCHEMA,
          },
        },
        temperature: 1,
        max_completion_tokens: env.OPENAI_MAX_COMPLETION_TOKENS,
      });

      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';
      if (!content) {
        logger.error({
          finishReason: choice?.finish_reason,
          refusal: choice?.message?.refusal,
        }, 'AI returned empty response');
        return null;
      }

      // Parse and validate the AI output
      const parsed = JSON.parse(content);
      const validated = aiRecipeOutputSchema.parse(parsed);

      // Generate a hero image
      const image = await imageService.generateRecipeImage(
        validated.title,
        validated.description ?? undefined,
        validated.cuisine ?? undefined
      );

      // Wrap in envelope format
      const envelope = wrapAIOutput(validated, image?.url);

      logger.info({ title: validated.title }, 'Successfully generated recipe');
      return envelope;
    } catch (error) {
      logger.error({ error }, 'Failed to generate recipe');
      return null;
    }
  }

  /**
   * Generate multiple recipes for the daily feed
   */
  async generateFeedRecipes(count: number = 3): Promise<RecipeEnvelope[]> {
    const recipes: RecipeEnvelope[] = [];
    const themes = this.getDailyThemes();

    for (let i = 0; i < count; i++) {
      const theme = themes[i % themes.length];
      const recipe = await this.generateRecipeWithTheme(theme);
      if (recipe) {
        recipes.push(recipe);
      }

      // Small delay between generations to avoid rate limits
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return recipes;
  }

  /**
   * Generate multiple personalized recipes for daily suggestions
   */
  async generateDailySuggestions(
    preferences: Partial<UserPreferences>,
    count: number = 3
  ): Promise<RecipeEnvelope[]> {
    const recipes: RecipeEnvelope[] = [];
    const themes = this.getDailyThemes();

    for (let i = 0; i < count; i++) {
      const theme = themes[i % themes.length];
      const recipe = await this.generateRecipe(preferences, theme);
      if (recipe) {
        recipes.push(recipe);
      }

      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return recipes;
  }

  /**
   * Generate a shared daily meal plan (2 breakfast, 2 lunch, 2 dinner, 2 dessert)
   */
  async generateMealPlan(countPerMeal: number = 2): Promise<RecipeEnvelope[]> {
    const recipes: RecipeEnvelope[] = [];
    const mealTypes = ['breakfast', 'lunch', 'dinner', 'dessert'] as const;
    const plan: string[] = [];

    for (const mealType of mealTypes) {
      for (let i = 0; i < countPerMeal; i++) {
        plan.push(mealType);
      }
    }

    for (let i = 0; i < plan.length; i++) {
      const mealType = plan[i];
      const recipe = await this.generateRecipe(undefined, mealType);
      if (recipe) {
        this.applyMealType(recipe, mealType);
        recipes.push(recipe);
      }

      if (i < plan.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return recipes;
  }

  /**
   * Generate a recipe with a specific theme/style
   */
  private async generateRecipeWithTheme(theme: string): Promise<RecipeEnvelope | null> {
    if (!this.openai) {
      return null;
    }

    try {
      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = `Generate a creative ${theme} recipe. Make it unique and interesting, with a catchy title.`;

      const response = await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'recipe',
            strict: true,
            schema: AI_RECIPE_JSON_SCHEMA,
          },
        },
        temperature: 0.9,
        max_completion_tokens: env.OPENAI_MAX_COMPLETION_TOKENS,
      });

      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';
      if (!content) {
        logger.error({
          finishReason: choice?.finish_reason,
          refusal: choice?.message?.refusal,
        }, 'AI returned empty response');
        return null;
      }

      const parsed = JSON.parse(content);
      const validated = aiRecipeOutputSchema.parse(parsed);

      const image = await imageService.generateRecipeImage(
        validated.title,
        validated.description ?? undefined,
        validated.cuisine ?? undefined
      );

      return wrapAIOutput(validated, image?.url);
    } catch (error) {
      logger.error({ error, theme }, 'Failed to generate themed recipe');
      return null;
    }
  }

  /**
   * Get rotating daily themes for variety
   */
  private getDailyThemes(): string[] {
    const dayOfWeek = new Date().getDay();
    const themes = [
      ['quick weeknight dinner', 'healthy salad', 'comfort food'],
      ['one-pot meal', 'vegetarian dish', 'Asian-inspired'],
      ['Mediterranean cuisine', 'protein-rich', 'kid-friendly'],
      ['meal prep friendly', 'low-carb', 'spicy dish'],
      ['date night dinner', 'gourmet appetizer', 'fusion cuisine'],
      ['brunch recipe', 'grilled dish', 'fresh seafood'],
      ['slow cooker recipe', 'batch cooking', 'seasonal ingredients'],
    ];
    return themes[dayOfWeek] || themes[0];
  }

  /**
   * Build the system prompt for recipe generation
   */
  private buildSystemPrompt(): string {
    return `You are a creative chef and recipe developer for whatEat, a recipe app. Generate unique, practical, and delicious recipes.

Guidelines:
- Create recipes that are achievable for home cooks
- Include accurate prep and cook times
- Estimate calories reasonably (not too precise)
- Use common ingredients when possible, with occasional specialty items
- Write clear, concise instructions
- Include relevant tags for dietary info (vegan, gluten-free, etc.)
- Specify the cuisine type when applicable
- Keep ingredient lists between 5-15 items
- Keep steps between 4-10 instructions

Output a JSON object with the recipe details.`;
  }

  /**
   * Build the user prompt based on preferences
   */
  private buildUserPrompt(preferences?: Partial<UserPreferences>, theme?: string): string {
    const parts: string[] = ['Generate a recipe'];

    if (preferences?.dietary_restrictions?.length) {
      parts.push(`that is ${preferences.dietary_restrictions.join(', ')}`);
    }

    if (preferences?.preferred_cuisines?.length) {
      const cuisine = preferences.preferred_cuisines[Math.floor(Math.random() * preferences.preferred_cuisines.length)];
      parts.push(`in ${cuisine} style`);
    }

    if (preferences?.excluded_ingredients?.length) {
      parts.push(`without ${preferences.excluded_ingredients.join(', ')}`);
    }

    if (theme) {
      const normalized = theme.toLowerCase();
      if (['breakfast', 'lunch', 'dinner', 'dessert'].includes(normalized)) {
        parts.push(`for ${normalized}`);
      } else {
        parts.push(`with a ${theme} theme`);
      }
    }

    parts.push('. Make it unique and interesting with a creative title.');

    return parts.join(' ');
  }

  private applyMealType(envelope: RecipeEnvelope, mealType: string): void {
    const normalized = mealType.toLowerCase();
    const tags = new Set(envelope.recipe.tags ?? []);
    tags.add(normalized);
    envelope.recipe.tags = Array.from(tags);
    envelope.recipe.metadata = {
      ...(envelope.recipe.metadata ?? {}),
      meal_type: normalized,
    };
  }

  /**
   * Save a generated recipe to the database (as a global feed recipe)
   */
  async saveGeneratedRecipe(envelope: RecipeEnvelope): Promise<Recipe | null> {
    try {
      // Insert recipe (user_id = null for global feed)
      const recipeData = envelopeToDbRecipe(envelope, null);
      const { data: recipe, error: recipeError } = await supabaseAdmin
        .from('recipes')
        .insert(recipeData)
        .select()
        .single();

      if (recipeError || !recipe) {
        logger.error({ recipeError }, 'Failed to insert recipe');
        return null;
      }

      // Insert ingredients
      if (envelope.recipe.ingredients.length > 0) {
        const ingredientsData = envelopeToDbIngredients(envelope, recipe.id);
        const { error: ingError } = await supabaseAdmin
          .from('recipe_ingredients')
          .insert(ingredientsData);

        if (ingError) {
          logger.error({ ingError }, 'Failed to insert ingredients');
        }
      }

      // Insert steps
      if (envelope.recipe.steps.length > 0) {
        const stepsData = envelopeToDbSteps(envelope, recipe.id);
        const { error: stepsError } = await supabaseAdmin
          .from('recipe_steps')
          .insert(stepsData);

        if (stepsError) {
          logger.error({ stepsError }, 'Failed to insert steps');
        }
      }

      // Insert media
      if (envelope.recipe.media.length > 0) {
        const mediaData = envelopeToDbMedia(envelope, recipe.id);
        const { error: mediaError } = await supabaseAdmin
          .from('recipe_media')
          .insert(mediaData);

        if (mediaError) {
          logger.error({ mediaError }, 'Failed to insert media');
        }
      }

      logger.info({ recipeId: recipe.id, title: recipe.title }, 'Saved generated recipe');
      return recipe as Recipe;
    } catch (error) {
      logger.error({ error }, 'Failed to save generated recipe');
      return null;
    }
  }

  /**
   * Store personalized suggestions for a user
   */
  async storeSuggestions(
    userId: string,
    suggestions: RecipeEnvelope[],
    options?: { runId?: string | null; triggerSource?: 'manual' | 'scheduled' }
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 999);
    const runId = options?.runId ?? null;
    const triggerSource = options?.triggerSource ?? 'scheduled';

    const { error } = await supabaseAdmin
      .from('daily_suggestions')
      .insert(
        suggestions.map((envelope, index) => ({
          user_id: userId,
          recipe_data: envelope.recipe as unknown as Json,
          expires_at: expiresAt.toISOString(),
          run_id: runId,
          trigger_source: triggerSource,
          rank: index + 1,
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

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('usage_counters')
      .select('id, ai_generations_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle();

    if (fetchError && fetchError.code !== 'PGRST116') {
      logger.error({ userId, error: fetchError }, 'Failed to read usage counter');
      return 0;
    }

    if (!existing) {
      const { data, error } = await supabaseAdmin
        .from('usage_counters')
        .insert({
          user_id: userId,
          date: today,
          ai_generations_count: 1,
        })
        .select()
        .single();

      if (error) {
        logger.error({ userId, error }, 'Failed to create usage counter');
        return 0;
      }

      return data?.ai_generations_count ?? 1;
    }

    const nextCount = (existing.ai_generations_count ?? 0) + 1;
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('usage_counters')
      .update({ ai_generations_count: nextCount })
      .eq('id', existing.id)
      .select()
      .single();

    if (updateError) {
      logger.error({ userId, error: updateError }, 'Failed to update usage counter');
      return nextCount;
    }

    return updated?.ai_generations_count ?? nextCount;
  }

  /**
   * Check if user has exceeded daily AI generation limit
   */
  async checkDailyLimit(userId: string): Promise<boolean> {
    const today = new Date().toISOString().split('T')[0];

    const { data } = await supabaseAdmin
      .from('usage_counters')
      .select('ai_generations_count')
      .eq('user_id', userId)
      .eq('date', today)
      .single();

    return (data?.ai_generations_count ?? 0) < env.DAILY_AI_GENERATION_LIMIT;
  }
}

export const aiService = new AIService();
