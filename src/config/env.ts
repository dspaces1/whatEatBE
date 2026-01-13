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
  OPENAI_MODEL: z.string(),
  OPENAI_MAX_COMPLETION_TOKENS: z.string().transform(Number),
  DALLE_MODEL: z.string(),

  // Storage
  SUPABASE_STORAGE_BUCKET: z.string(),

  // Rate limits
  DAILY_AI_GENERATION_LIMIT: z.string().transform(Number),
  DAILY_IMPORT_LIMIT: z.string().transform(Number),

  // Admin controls
  DAILY_GENERATION_ADMIN_EMAILS: z.string().optional(),
  DAILY_GENERATION_ADMIN_USER_IDS: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
