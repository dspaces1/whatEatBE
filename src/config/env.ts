import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default('gpt-5'),
  DALLE_MODEL: z.string().default('dall-e-3'),

  // Storage
  SUPABASE_STORAGE_BUCKET: z.string().default('recipe-images'),

  // Rate limits
  DAILY_AI_GENERATION_LIMIT: z.string().default('10').transform(Number),
  DAILY_IMPORT_LIMIT: z.string().default('20').transform(Number),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
