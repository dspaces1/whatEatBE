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
    description: { type: 'string' },
    servings: { type: 'integer' },
    calories: { type: 'integer' },
    prep_time_minutes: { type: 'integer' },
    cook_time_minutes: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    cuisine: { type: 'string' },
    dietary_labels: { type: 'array', items: { type: 'string' } },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: { raw_text: { type: 'string' } },
        required: ['raw_text'],
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { instruction: { type: 'string' } },
        required: ['instruction'],
      },
    },
  },
  required: ['title', 'ingredients', 'steps'],
  additionalProperties: false,
} as const;

export class AIService {
  private openai: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  /**
   * Generate a recipe based on user preferences
   */
  async generateRecipe(preferences?: Partial<UserPreferences>): Promise<RecipeEnvelope | null> {
    if (!this.openai) {
      logger.warn('OpenAI API key not configured');
      return null;
    }

    try {
      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(preferences);

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
        temperature: 0.8,
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        logger.error('AI returned empty response');
        return null;
      }

      // Parse and validate the AI output
      const parsed = JSON.parse(content);
      const validated = aiRecipeOutputSchema.parse(parsed);

      // Generate a hero image
      const image = await imageService.generateRecipeImage(
        validated.title,
        validated.description,
        validated.cuisine
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
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content);
      const validated = aiRecipeOutputSchema.parse(parsed);

      const image = await imageService.generateRecipeImage(
        validated.title,
        validated.description,
        validated.cuisine
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
  private buildUserPrompt(preferences?: Partial<UserPreferences>): string {
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

    parts.push('. Make it unique and interesting with a creative title.');

    return parts.join(' ');
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
    suggestions: RecipeEnvelope[]
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 999);

    const { error } = await supabaseAdmin
      .from('daily_suggestions')
      .insert(
        suggestions.map((envelope) => ({
          user_id: userId,
          recipe_data: envelope.recipe as unknown as Json,
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

    // If it was an update (count > 1), increment
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
