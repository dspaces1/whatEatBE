import OpenAI from 'openai';
import net from 'net';
import { promises as dns } from 'dns';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { recipeService } from './recipe.service.js';
import { logger } from '../utils/logger.js';
import { getOpenAIErrorDetails } from '../utils/openai-errors.js';
import { ImportError, RateLimitError } from '../utils/errors.js';
import { CANONICAL_DIETARY_LABELS, normalizeDietaryLabels } from '../utils/dietary-labels.js';
import { CANONICAL_CUISINES, normalizeCuisine } from '../utils/cuisines.js';
import { CANONICAL_RECIPE_TAGS, normalizeRecipeTags } from '../utils/recipe-tags.js';
import {
  aiRecipeOutputSchema,
  recipeEnvelopeSchema,
  type AIRecipeOutput,
  type RecipeEnvelope,
} from '../schemas/envelope.js';

const MAX_RETRIES = 3;
const MAX_HTML_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8000;
const MAX_AI_TEXT_CHARS = 20_000;
const USER_AGENT = 'whatEat-importer/1.0';

const IMPORT_RECIPE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    servings: { type: ['integer', 'null'] },
    calories: { type: ['integer', 'null'] },
    prep_time_minutes: { type: ['integer', 'null'] },
    cook_time_minutes: { type: ['integer', 'null'] },
    tags: { type: ['array', 'null'], items: { type: 'string', enum: CANONICAL_RECIPE_TAGS } },
    cuisine: { type: ['string', 'null'], enum: [...CANONICAL_CUISINES, null] },
    dietary_labels: { type: ['array', 'null'], items: { type: 'string', enum: CANONICAL_DIETARY_LABELS } },
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

type ExtractionSource = 'jsonld' | 'readability' | 'chatgpt' | 'heuristic' | 'ai';

type ImportPreviewResult = {
  envelope: RecipeEnvelope;
  extracted_from: ExtractionSource;
  warnings: string[];
};

type PartialRecipeData = {
  title: string | null;
  description: string | null;
  servings: number | null;
  calories: number | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  tags: string[];
  cuisine: string | null;
  dietary_labels: string[];
  ingredients: string[];
  steps: string[];
  media: Array<{ media_type: 'image' | 'video'; url: string; name?: string | null }>;
  author_name?: string | null;
  attribution?: string | null;
};

type ExtractionAttempt = {
  envelope?: RecipeEnvelope;
  missing_fields?: string[];
};

type AIFallbackAttempt = {
  envelope?: RecipeEnvelope;
  missing_fields?: string[];
  attempted: boolean;
  failed: boolean;
};

type ChatGptExtractionResult = {
  attempt: ExtractionAttempt;
  text?: string;
};

export class ImportService {
  private openai: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 2 });
    }
  }

  /**
   * Process a pending import job
   */
  async processJob(jobId: string): Promise<void> {
    const { data: job, error: fetchError } = await supabaseAdmin
      .from('import_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) {
      logger.error({ jobId, error: fetchError }, 'Failed to fetch import job');
      return;
    }

    await supabaseAdmin
      .from('import_jobs')
      .update({ status: 'processing' })
      .eq('id', jobId);

    try {
      let envelope: RecipeEnvelope;

      if (job.type === 'url' && job.input_url) {
        envelope = (await this.extractFromUrl(job.input_url)).envelope;
      } else if (job.type === 'image' && job.input_image_path) {
        envelope = await this.extractFromImage(job.input_image_path);
      } else {
        throw new Error('Invalid job type or missing input');
      }

      const recipe = await recipeService.createRecipe(envelope, job.user_id);

      await supabaseAdmin
        .from('import_jobs')
        .update({
          status: 'completed',
          result_recipe_id: recipe.id,
        })
        .eq('id', jobId);

      logger.info({ jobId, recipeId: recipe.id }, 'Import job completed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const retries = (job.retries ?? 0) + 1;

      if (retries < MAX_RETRIES) {
        await supabaseAdmin
          .from('import_jobs')
          .update({
            status: 'pending',
            retries,
            error_message: errorMessage,
          })
          .eq('id', jobId);

        logger.warn({ jobId, retries, error: errorMessage }, 'Import job failed, will retry');
      } else {
        await supabaseAdmin
          .from('import_jobs')
          .update({
            status: 'failed',
            retries,
            error_message: errorMessage,
          })
          .eq('id', jobId);

        logger.error({ jobId, error: errorMessage }, 'Import job failed permanently');
      }
    }
  }

  async previewFromUrl(url: string, userId: string): Promise<ImportPreviewResult> {
    const allowed = await this.checkDailyImportLimit(userId);
    if (!allowed) {
      throw new RateLimitError('Daily import limit reached');
    }

    await this.incrementImportCounter(userId);
    return this.extractFromUrl(url);
  }

  /**
   * Extract recipe data from a URL
   */
  async extractFromUrl(url: string): Promise<ImportPreviewResult> {
    logger.info({ url }, 'Extracting recipe from URL');

    const { body, finalUrl, contentType } = await fetchWithGuards(url);
    const sourceUrl = finalUrl ?? url;

    const warnings: string[] = [];
    const missingFields: Set<string> = new Set();
    let aiTextOverride: string | undefined;

    if (isChatGptShareUrl(sourceUrl)) {
      const chatGptResult = extractFromChatGptShare(body, sourceUrl);
      if (chatGptResult.text) {
        aiTextOverride = chatGptResult.text;
      }
      if (chatGptResult.attempt.envelope) {
        return {
          envelope: chatGptResult.attempt.envelope,
          extracted_from: 'chatgpt',
          warnings,
        };
      }
      if (chatGptResult.attempt.missing_fields) {
        chatGptResult.attempt.missing_fields.forEach((field) => missingFields.add(field));
      }
    }

    const jsonLdAttempt = extractFromJsonLd(body, sourceUrl, contentType);
    if (jsonLdAttempt.envelope) {
      return {
        envelope: jsonLdAttempt.envelope,
        extracted_from: 'jsonld',
        warnings,
      };
    }
    if (jsonLdAttempt.missing_fields) {
      jsonLdAttempt.missing_fields.forEach((field) => missingFields.add(field));
    }

    const readabilityAttempt = extractFromReadability(body, sourceUrl);
    if (readabilityAttempt.text && !aiTextOverride) {
      aiTextOverride = readabilityAttempt.text;
    }
    if (readabilityAttempt.attempt.envelope) {
      warnings.push('Used readability extraction');
      return {
        envelope: readabilityAttempt.attempt.envelope,
        extracted_from: 'readability',
        warnings,
      };
    }
    if (readabilityAttempt.attempt.missing_fields) {
      readabilityAttempt.attempt.missing_fields.forEach((field) => missingFields.add(field));
    }

    const heuristicAttempt = extractFromHeuristics(body, sourceUrl);
    if (heuristicAttempt.envelope) {
      warnings.push('Used heuristic extraction');
      return {
        envelope: heuristicAttempt.envelope,
        extracted_from: 'heuristic',
        warnings,
      };
    }
    if (heuristicAttempt.missing_fields) {
      heuristicAttempt.missing_fields.forEach((field) => missingFields.add(field));
    }

    const aiAttempt = await this.extractFromAI(body, sourceUrl, aiTextOverride);
    if (aiAttempt.envelope) {
      warnings.push('Used AI extraction');
      return {
        envelope: aiAttempt.envelope,
        extracted_from: 'ai',
        warnings,
      };
    }
    if (aiAttempt.missing_fields) {
      aiAttempt.missing_fields.forEach((field) => missingFields.add(field));
    }

    const aiFallbackDetails = aiAttempt.attempted
      ? { attempted: true, failed: aiAttempt.failed }
      : undefined;

    if (missingFields.size > 0) {
      throw new ImportError(
        'We could not find all required recipe fields on that page.',
        'IMPORT_MISSING_FIELDS',
        422,
        {
          missing_fields: Array.from(missingFields),
          ...(aiFallbackDetails ? { ai_fallback: aiFallbackDetails } : {}),
        }
      );
    }

    throw new ImportError(
      'We could not find a recipe on that page.',
      'IMPORT_NO_RECIPE_FOUND',
      422,
      aiFallbackDetails ? { ai_fallback: aiFallbackDetails } : undefined
    );
  }

  /**
   * Extract recipe data from an image
   */
  async extractFromImage(_imagePath: string): Promise<RecipeEnvelope> {
    throw new Error('Image extraction not yet implemented');
  }

  private async extractFromAI(
    html: string,
    sourceUrl: string,
    textOverride?: string
  ): Promise<AIFallbackAttempt> {
    if (!this.openai) {
      return { attempted: false, failed: false };
    }

    const text = textOverride ?? buildTextForAI(html);
    if (!text) {
      return { attempted: false, failed: false };
    }

    let rawContent: string | null = null;
    try {
      const response = await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You extract one recipe from provided webpage content and output JSON only.',
          },
          {
            role: 'user',
            content: `Hard requirements:\n- Title, ingredients, and steps MUST be grounded in the page content.\n- Do NOT invent ingredients or steps that are not present.\n\nSoft requirements (may estimate if missing):\n- description, servings, calories, prep_time_minutes, cook_time_minutes, tags, cuisine, dietary_labels.\n- tags must use this exact list: ${CANONICAL_RECIPE_TAGS.join(', ')}\n- dietary_labels must use this exact list: ${CANONICAL_DIETARY_LABELS.join(', ')}\n- cuisine must use this exact list: ${CANONICAL_CUISINES.join(', ')}\n- If unknown, estimate conservatively using typical values; if truly impossible, use null (or empty arrays for tags/dietary_labels).\n\nImage is optional and should NOT be output.\n\nNormalization:\n- Times -> integer minutes\n- Calories -> per-serving integer\n- Keep ingredient/step order from the page\n- Ignore ads/nav/comments\n- If no recipe exists, return empty ingredients/steps and title "Unknown Recipe"\n\nExtract a single recipe from this webpage.\n\nURL: ${sourceUrl}\n\nCONTENT:\n${text}`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'recipe',
            strict: true,
            schema: IMPORT_RECIPE_JSON_SCHEMA,
          },
        },
        max_completion_tokens: env.OPENAI_MAX_COMPLETION_TOKENS,
      });

      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';
      rawContent = content;
      if (!content) {
        logger.warn({ sourceUrl }, 'AI extractor returned empty response');
        return { attempted: true, failed: true };
      }

      logger.info({
        sourceUrl,
        ai_response_length: content.length,
        ai_response_preview: truncate(content, 2000),
      }, 'AI extractor response received');

      const parsed = JSON.parse(content);
      const validated = aiRecipeOutputSchema.parse(parsed);
      logger.info({
        sourceUrl,
        ai_ingredients: validated.ingredients.length,
        ai_steps: validated.steps.length,
      }, 'AI extractor parsed recipe');

      const attempt = buildEnvelopeAttempt(
        {
          title: validated.title,
          description: validated.description ?? null,
          servings: validated.servings ?? null,
          calories: validated.calories ?? null,
          prep_time_minutes: validated.prep_time_minutes ?? null,
          cook_time_minutes: validated.cook_time_minutes ?? null,
          tags: normalizeRecipeTags(validated.tags),
          cuisine: normalizeCuisine(validated.cuisine),
          dietary_labels: normalizeDietaryLabels(validated.dietary_labels),
          ingredients: validated.ingredients.map((ing) => ing.raw_text),
          steps: validated.steps.map((step) => step.instruction),
          media: [],
          attribution: new URL(sourceUrl).hostname,
        },
        sourceUrl
      );
      return {
        ...attempt,
        attempted: true,
        failed: !attempt.envelope,
      };
    } catch (error) {
      const openaiError = getOpenAIErrorDetails(error);
      logger.warn({
        error,
        openaiError,
        sourceUrl,
        model: env.OPENAI_MODEL,
        ai_response_preview: rawContent ? truncate(rawContent, 2000) : null,
      }, 'AI extraction failed');
      return { attempted: true, failed: true };
    }
  }

  private async checkDailyImportLimit(userId: string): Promise<boolean> {
    const today = new Date().toISOString().split('T')[0];

    const { data } = await supabaseAdmin
      .from('usage_counters')
      .select('imports_count')
      .eq('user_id', userId)
      .eq('date', today)
      .single();

    return (data?.imports_count ?? 0) < env.DAILY_IMPORT_LIMIT;
  }

  private async incrementImportCounter(userId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0];

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('usage_counters')
      .select('id, imports_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle();

    if (fetchError && fetchError.code !== 'PGRST116') {
      logger.error({ userId, error: fetchError }, 'Failed to read import counter');
      return 0;
    }

    if (!existing) {
      const { data, error } = await supabaseAdmin
        .from('usage_counters')
        .insert({
          user_id: userId,
          date: today,
          imports_count: 1,
        })
        .select()
        .single();

      if (error) {
        logger.error({ userId, error }, 'Failed to create import counter');
        return 0;
      }

      return data?.imports_count ?? 1;
    }

    const nextCount = (existing.imports_count ?? 0) + 1;
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('usage_counters')
      .update({ imports_count: nextCount })
      .eq('id', existing.id)
      .select()
      .single();

    if (updateError) {
      logger.error({ userId, error: updateError }, 'Failed to update import counter');
      return nextCount;
    }

    return updated?.imports_count ?? nextCount;
  }
}

function extractFromJsonLd(html: string, sourceUrl: string, contentType: string | null): ExtractionAttempt {
  const recipes: PartialRecipeData[] = [];

  if (contentType && contentType.includes('json')) {
    const parsed = safeJsonParse(html);
    if (parsed) {
      recipes.push(...extractRecipeDataFromJsonLd(parsed));
    }
  } else {
    const matches = html.matchAll(/<script[^>]*type=["'][^"']*application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of matches) {
      const raw = match[1].replace(/<!--|-->/g, '').trim();
      if (!raw) {
        continue;
      }
      const parsed = safeJsonParse(raw);
      if (!parsed) {
        continue;
      }
      recipes.push(...extractRecipeDataFromJsonLd(parsed));
    }
  }

  for (const recipe of recipes) {
    const attempt = buildEnvelopeAttempt(recipe, sourceUrl);
    if (attempt.envelope) {
      return attempt;
    }
  }

  if (recipes.length > 0) {
    const missing = buildMissingFields(recipes[0]);
    return { missing_fields: missing.length > 0 ? missing : undefined };
  }

  return {};
}

function extractFromChatGptShare(html: string, sourceUrl: string): ChatGptExtractionResult {
  const payloads = extractChatGptStreamPayloads(html);
  if (payloads.length === 0) {
    return { attempt: {} };
  }

  const strings: string[] = [];
  for (const payload of payloads) {
    const decoded = decodeJavascriptString(payload);
    if (!decoded) {
      continue;
    }
    const decodedStrings = extractStringsFromStream(decoded);
    strings.push(...decodedStrings);
  }

  const candidate = pickChatGptRecipeText(strings);
  if (!candidate) {
    return { attempt: {} };
  }

  const lines = candidate.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headingTitle = extractTitleFromLines(lines);
  const pageTitle = extractTitle(html);
  const titleHint = headingTitle ?? stripChatGptPrefix(pageTitle);

  const attempt = extractFromPlainText(candidate, sourceUrl, {
    titleHint,
    attribution: new URL(sourceUrl).hostname,
  });

  return { attempt, text: candidate };
}

function extractFromReadability(html: string, sourceUrl: string): { attempt: ExtractionAttempt; text?: string } {
  try {
    const dom = new JSDOM(html, { url: sourceUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const text = article?.textContent?.trim();

    if (!text) {
      return { attempt: {} };
    }

    const titleHint = article?.title?.trim() || extractTitle(html);
    const attempt = extractFromPlainText(text, sourceUrl, {
      titleHint,
      authorName: article?.byline?.trim() || null,
      attribution: new URL(sourceUrl).hostname,
    });

    return { attempt, text };
  } catch (error) {
    logger.warn({ error, sourceUrl }, 'Readability extraction failed');
    return { attempt: {} };
  }
}

type PlainTextOptions = {
  titleHint?: string | null;
  authorName?: string | null;
  attribution?: string | null;
};

function extractFromPlainText(
  text: string,
  sourceUrl: string,
  options: PlainTextOptions = {}
): ExtractionAttempt {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = options.titleHint ?? extractTitleFromLines(lines);
  const ingredients = extractSection(lines, ['ingredients']);
  const steps = extractSection(lines, ['instructions', 'directions', 'method', 'preparation', 'steps']);

  const data: PartialRecipeData = {
    title,
    description: null,
    servings: null,
    calories: null,
    prep_time_minutes: null,
    cook_time_minutes: null,
    tags: [],
    cuisine: null,
    dietary_labels: [],
    ingredients,
    steps,
    media: [],
    author_name: options.authorName ?? null,
    attribution: options.attribution ?? (title ? new URL(sourceUrl).hostname : null),
  };

  return buildEnvelopeAttempt(data, sourceUrl);
}

function extractFromHeuristics(html: string, sourceUrl: string): ExtractionAttempt {
  const title = extractTitle(html);
  const text = htmlToText(html);
  return extractFromPlainText(text, sourceUrl, { titleHint: title });
}

function extractRecipeDataFromJsonLd(payload: unknown): PartialRecipeData[] {
  const nodes = collectJsonLdNodes(payload);
  const recipes: PartialRecipeData[] = [];

  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }

    const types = asArray(node['@type']).map((value) => String(value));
    if (!types.some(isRecipeType)) {
      continue;
    }

    const recipe = normalizeJsonLdRecipe(node);
    if (recipe) {
      recipes.push(recipe);
    }
  }

  return recipes;
}

function normalizeJsonLdRecipe(node: Record<string, unknown>): PartialRecipeData | null {
  const title = pickFirstString(node.name, node.headline);
  const description = asString(node.description);
  const servings = parseServings(node.recipeYield);
  const calories = parseCalories((node.nutrition as Record<string, unknown> | undefined)?.calories);
  const prep = parseDurationToMinutes(node.prepTime);
  const cook = parseDurationToMinutes(node.cookTime);
  const ingredients = normalizeStringList(node.recipeIngredient ?? node.ingredients);
  const steps = extractInstructions(node.recipeInstructions);
  const cuisine = pickFirstString(node.recipeCuisine, node.cuisine);
  const tags = normalizeTags(node.keywords, node.recipeCategory);
  const dietaryLabels = normalizeDietaryLabels(node.suitableForDiet);
  const imageUrl = extractImageUrl(node.image ?? node.thumbnailUrl);
  const authorName = extractName(node.author);
  const publisherName = extractName(node.publisher);

  const media = imageUrl
    ? [{ media_type: 'image' as const, url: imageUrl, name: 'Imported image' }]
    : [];

  return {
    title,
    description,
    servings,
    calories,
    prep_time_minutes: prep,
    cook_time_minutes: cook,
    tags,
    cuisine,
    dietary_labels: dietaryLabels,
    ingredients,
    steps,
    media,
    author_name: authorName ?? null,
    attribution: publisherName ?? authorName ?? null,
  };
}

function buildEnvelopeAttempt(data: PartialRecipeData, sourceUrl: string): ExtractionAttempt {
  const missing_fields = buildMissingFields(data);
  if (missing_fields.length > 0) {
    return { missing_fields };
  }

  const sanitized = sanitizeRecipeData(data);
  const envelope: RecipeEnvelope = {
    format: 'whatEat-recipe',
    version: 1,
    recipe: {
      id: null,
      title: sanitized.title ?? 'Untitled recipe',
      description: sanitized.description,
      servings: sanitized.servings,
      calories: sanitized.calories,
      prep_time_minutes: sanitized.prep_time_minutes,
      cook_time_minutes: sanitized.cook_time_minutes,
      tags: sanitized.tags,
      cuisine: sanitized.cuisine,
      dietary_labels: sanitized.dietary_labels,
      source: {
        type: 'url',
        url: sourceUrl,
      },
      ingredients: sanitized.ingredients.map((raw_text) => ({ raw_text })),
      steps: sanitized.steps.map((instruction) => ({ instruction })),
      media: sanitized.media.map((item) => ({
        media_type: item.media_type,
        url: item.url,
        name: item.name ?? null,
        is_generated: false,
      })),
      metadata: {
        attribution: sanitized.attribution ?? new URL(sourceUrl).hostname,
        author_name: sanitized.author_name ?? undefined,
      },
    },
  };

  try {
    recipeEnvelopeSchema.parse(envelope);
  } catch (error) {
    logger.warn({ error, sourceUrl }, 'Extracted recipe failed schema validation');
    return { missing_fields: ['ingredients', 'steps'] };
  }

  return { envelope };
}

function buildMissingFields(data: PartialRecipeData): string[] {
  const missing: string[] = [];
  if (!data.title || data.title.trim().length === 0) {
    missing.push('title');
  }
  if (!data.ingredients || data.ingredients.length === 0) {
    missing.push('ingredients');
  }
  if (!data.steps || data.steps.length === 0) {
    missing.push('steps');
  }
  return missing;
}

async function fetchWithGuards(rawUrl: string): Promise<{ body: string; finalUrl: string | null; contentType: string | null }> {
  let currentUrl = await validateUrl(rawUrl);

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(currentUrl.toString(), {
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'text/html,application/xhtml+xml,application/json,application/ld+json',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new ImportError(
        'We could not reach that URL.',
        'IMPORT_FETCH_FAILED',
        502
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new ImportError('Redirect missing location header.', 'IMPORT_FETCH_FAILED', 502);
      }
      currentUrl = await validateUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw new ImportError(
        'We could not fetch that page.',
        'IMPORT_FETCH_FAILED',
        502,
        { status: response.status }
      );
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !isSupportedContentType(contentType)) {
      throw new ImportError(
        'That page does not contain readable recipe content.',
        'IMPORT_UNSUPPORTED_CONTENT',
        415,
        { content_type: contentType }
      );
    }

    const body = await readBodyWithLimit(response, MAX_HTML_BYTES);
    return { body, finalUrl: currentUrl.toString(), contentType };
  }

  throw new ImportError('Too many redirects.', 'IMPORT_TOO_MANY_REDIRECTS', 400);
}

async function validateUrl(rawUrl: string): Promise<URL> {
  if (rawUrl.length > 2048) {
    throw new ImportError('URL is too long.', 'IMPORT_INVALID_URL', 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ImportError('URL is invalid.', 'IMPORT_INVALID_URL', 400);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ImportError('Only http and https URLs are supported.', 'IMPORT_INVALID_URL', 400);
  }

  if (parsed.username || parsed.password) {
    throw new ImportError('URL credentials are not allowed.', 'IMPORT_URL_BLOCKED', 400);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new ImportError('That URL is not allowed.', 'IMPORT_URL_BLOCKED', 400);
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new ImportError('That URL is not allowed.', 'IMPORT_URL_BLOCKED', 400);
    }
    return parsed;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new ImportError('We could not resolve that host.', 'IMPORT_FETCH_FAILED', 502);
  }
  if (addresses.length === 0) {
    throw new ImportError('We could not resolve that host.', 'IMPORT_FETCH_FAILED', 502);
  }

  for (const address of addresses) {
    if (isPrivateIp(address.address)) {
      throw new ImportError('That URL is not allowed.', 'IMPORT_URL_BLOCKED', 400);
    }
  }

  return parsed;
}

function isSupportedContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml+xml') ||
    normalized.includes('application/ld+json') ||
    normalized.includes('application/json')
  );
}

async function readBodyWithLimit(response: Response, limit: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > limit) {
    throw new ImportError('Page is too large to import.', 'IMPORT_CONTENT_TOO_LARGE', 413, {
      limit_bytes: limit,
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.length;
      if (total > limit) {
        throw new ImportError('Page is too large to import.', 'IMPORT_CONTENT_TOO_LARGE', 413, {
          limit_bytes: limit,
        });
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks).toString('utf-8');
}

function isPrivateIp(address: string): boolean {
  const ipv4 = address.startsWith('::ffff:') ? address.replace('::ffff:', '') : address;
  if (net.isIP(ipv4) === 4) {
    const parts = ipv4.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return true;
    }
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }

  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return false;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collectJsonLdNodes(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload.flatMap(collectJsonLdNodes);
  }
  if (!isRecord(payload)) {
    return [];
  }
  const graph = payload['@graph'];
  if (graph) {
    return [payload, ...collectJsonLdNodes(graph)];
  }
  return [payload];
}

function isRecipeType(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === 'recipe' ||
    normalized.endsWith(':recipe') ||
    normalized.endsWith('/recipe')
  );
}

function extractInstructions(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    return splitInstructions(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractInstructions);
  }
  if (isRecord(value)) {
    if (value.text) {
      return splitInstructions(String(value.text));
    }
    if (value.name) {
      return splitInstructions(String(value.name));
    }
    if (value.itemListElement) {
      return extractInstructions(value.itemListElement);
    }
    if (value.steps) {
      return extractInstructions(value.steps);
    }
  }
  return [];
}

function splitInstructions(text: string): string[] {
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    return lines.map(stripLeadingNumber);
  }

  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    return sentences.map(stripLeadingNumber);
  }

  return text.trim() ? [stripLeadingNumber(text.trim())] : [];
}

function stripLeadingNumber(text: string): string {
  return text.replace(/^\s*\d+[\).:-]?\s*/, '').trim();
}

function normalizeStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : null))
      .filter((item): item is string => Boolean(item))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeTags(keywords: unknown, categories: unknown): string[] {
  const tags = new Set<string>();
  const keywordList = normalizeStringList(keywords);
  if (keywordList.length === 1 && keywordList[0].includes(',')) {
    keywordList[0].split(',').forEach((item) => tags.add(item.trim()));
  } else {
    keywordList.forEach((item) => tags.add(item));
  }

  normalizeStringList(categories).forEach((item) => tags.add(item));
  return Array.from(tags).filter(Boolean).map((item) => truncate(item, 50));
}

function parseServings(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const match = value.match(/(\d+)\s*/);
    if (match) return Number(match[1]);
  }
  if (Array.isArray(value) && value.length > 0) {
    return parseServings(value[0]);
  }
  return null;
}

function parseCalories(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const match = value.match(/(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseDurationToMinutes(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return null;
  const isoMatch = value.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (isoMatch) {
    const days = Number(isoMatch[1] ?? 0);
    const hours = Number(isoMatch[2] ?? 0);
    const minutes = Number(isoMatch[3] ?? 0);
    return days * 24 * 60 + hours * 60 + minutes;
  }
  const numberMatch = value.match(/(\d+)/);
  return numberMatch ? Number(numberMatch[1]) : null;
}

function extractImageUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string');
    if (first) return first;
    const firstObj = value.find((item) => isRecord(item));
    if (firstObj) return extractImageUrl(firstObj);
  }
  if (isRecord(value)) {
    if (value.url) return String(value.url);
    if (value['@id']) return String(value['@id']);
  }
  return null;
}

function extractName(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return extractName(value[0]);
  }
  if (isRecord(value) && value.name) {
    return String(value.name);
  }
  return null;
}

function pickFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    const str = asString(value);
    if (str) return str;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isChatGptShareUrl(sourceUrl: string): boolean {
  try {
    const parsed = new URL(sourceUrl);
    return parsed.hostname.endsWith('chatgpt.com') && parsed.pathname.startsWith('/share/');
  } catch {
    return false;
  }
}

function stripChatGptPrefix(title: string | null): string | null {
  if (!title) return null;
  const cleaned = title.replace(/^ChatGPT\s*[-:]\s*/i, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function extractTitleFromLines(lines: string[]): string | null {
  for (const line of lines) {
    const match = line.match(/^#+\s*(.+)$/);
    if (match) {
      const cleaned = cleanupTitleLine(match[1]);
      if (cleaned) {
        return cleaned;
      }
    }
  }

  for (const line of lines) {
    const cleaned = cleanupTitleLine(line);
    if (!cleaned) continue;
    const normalized = cleaned.toLowerCase();
    if (normalized === 'ingredients' || normalized === 'steps' || normalized === 'instructions') {
      continue;
    }
    return cleaned;
  }

  return null;
}

function cleanupTitleLine(line: string): string | null {
  const cleaned = line.replace(/\s*#+\s*$/, '').replace(/^[*-]\s*/, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function extractChatGptStreamPayloads(html: string): string[] {
  const matches = html.matchAll(/streamController\.enqueue\("((?:\\.|[^"\\])*)"\)/g);
  return Array.from(matches, (match) => match[1]);
}

function decodeJavascriptString(value: string): string | null {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return null;
  }
}

function extractStringsFromStream(decoded: string): string[] {
  const strings: string[] = [];
  const lines = decoded.split('\n').map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const cleanedLine = line.replace(/^P\d+:/, '');
    const parsed = safeJsonParse(cleanedLine);
    if (parsed !== null) {
      collectStringsFromJson(parsed, strings);
    }
  }

  if (strings.length === 0) {
    const parsed = safeJsonParse(decoded);
    if (parsed !== null) {
      collectStringsFromJson(parsed, strings);
    }
  }

  return strings;
}

function collectStringsFromJson(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringsFromJson(item, output));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => collectStringsFromJson(item, output));
  }
}

function pickChatGptRecipeText(strings: string[]): string | null {
  const cleaned = strings.map((value) => value.trim()).filter((value) => value.length > 80);
  const recipeCandidates = cleaned.filter((value) => {
    const lower = value.toLowerCase();
    return lower.includes('ingredients') && (
      lower.includes('steps') || lower.includes('instructions') || lower.includes('directions')
    );
  });

  const primary = pickLongest(recipeCandidates);
  if (primary) {
    return primary;
  }

  const fallbackCandidates = cleaned.filter((value) => {
    const lower = value.toLowerCase();
    return lower.includes('ingredients') || lower.includes('steps') || lower.includes('instructions');
  });

  return pickLongest(fallbackCandidates);
}

function pickLongest(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((longest, current) => (current.length > longest.length ? current : longest), values[0]);
}

function sanitizeRecipeData(data: PartialRecipeData): PartialRecipeData {
  return {
    ...data,
    title: data.title ? truncate(data.title, 200) : null,
    description: data.description ? truncate(data.description, 2000) : null,
    ingredients: data.ingredients.map((item) => truncate(stripBullet(item), 500)).filter(Boolean),
    steps: data.steps.map((item) => truncate(stripBullet(item), 2000)).filter(Boolean),
    tags: normalizeRecipeTags(data.tags).map((tag) => truncate(tag, 50)),
    cuisine: normalizeCuisine(data.cuisine),
    dietary_labels: normalizeDietaryLabels(data.dietary_labels).map((label) => truncate(label, 50)),
    media: data.media
      .map((item) => ({ ...item, url: item.url }))
      .filter((item) => item.url),
    author_name: data.author_name ? truncate(data.author_name, 200) : null,
    attribution: data.attribution ? truncate(data.attribution, 500) : null,
  };
}

function stripBullet(value: string): string {
  return value.replace(/^[-*\u2022]\s*/, '').trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max).trim();
}

function extractTitle(html: string): string | null {
  const ogTitle = extractMetaContent(html, 'property', 'og:title');
  if (ogTitle) return ogTitle;
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return titleMatch ? titleMatch[1].trim() : null;
}

function extractMetaContent(html: string, attribute: 'property' | 'name', value: string): string | null {
  const regex = new RegExp(`<meta[^>]*${attribute}=["']${value}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6|li|br|tr|td)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeSectionHeading(line: string): string {
  return line
    .toLowerCase()
    .replace(/^#+\s*/, '')
    .replace(/^[*-]\s*/, '')
    .replace(/:$/, '')
    .trim();
}

function extractSection(lines: string[], labels: string[]): string[] {
  const labelSet = new Set(labels.map((label) => label.toLowerCase()));
  const stopSet = new Set(['nutrition', 'notes', 'tips', 'storage', 'video']);

  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = normalizeSectionHeading(lines[i]);
    if (labelSet.has(line)) {
      startIndex = i + 1;
      break;
    }
    for (const label of labelSet) {
      if (line.startsWith(`${label} `)) {
        startIndex = i + 1;
        break;
      }
    }
    if (startIndex !== -1) {
      break;
    }
  }

  if (startIndex === -1) {
    return [];
  }

  const results: string[] = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const normalized = normalizeSectionHeading(line);
    if (labelSet.has(normalized) || stopSet.has(normalized)) {
      break;
    }
    if (normalized.length === 0) {
      if (results.length > 0) {
        break;
      }
      continue;
    }
    results.push(stripBullet(line));
  }

  return results;
}

function buildTextForAI(html: string): string {
  const text = htmlToText(html);
  if (!text) return '';
  return text.length > MAX_AI_TEXT_CHARS ? text.slice(0, MAX_AI_TEXT_CHARS) : text;
}

export const importService = new ImportService();
