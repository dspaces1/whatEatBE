import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';
import type { Database } from '../types/supabase.js';

// For user-context operations (respects RLS)
export const supabase = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY
);

// For admin operations (bypasses RLS) - use sparingly
export const supabaseAdmin = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
);



