export type { Database, Json } from './supabase.js';
export type { AuthenticatedRequest } from './express.js';
import type { Json } from './supabase.js';

// ============================================================================
// Recipe Types (Unified Schema)
// ============================================================================

export interface Recipe {
  id: string;
  user_id: string | null; // null = global feed recipe
  title: string;
  description: string | null;
  servings: number | null;
  calories: number | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  tags: string[];
  cuisine: string | null;
  dietary_labels: string[];
  source_type: 'manual' | 'url' | 'image' | 'ai';
  source_url: string | null;
  source_recipe_id: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // Populated when fetching full recipe
  ingredients?: RecipeIngredient[];
  steps?: RecipeStep[];
  media?: RecipeMedia[];
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  position: number;
  raw_text: string;
  quantity: number | null;
  unit: string | null;
  ingredient_name: string | null;
  created_at: string;
}

export interface RecipeStep {
  id: string;
  recipe_id: string;
  position: number;
  instruction: string;
  created_at: string;
}

export interface RecipeMedia {
  id: string;
  recipe_id: string;
  position: number;
  media_type: 'image' | 'video';
  url: string;
  storage_path: string | null;
  name: string | null;
  is_generated: boolean;
  created_at: string;
}

// ============================================================================
// Recipe Shares
// ============================================================================

export interface RecipeShare {
  id: string;
  recipe_id: string;
  share_token: string;
  created_by: string | null;
  expires_at: string | null;
  view_count: number;
  created_at: string;
}

// ============================================================================
// Import Jobs
// ============================================================================

export interface ImportJob {
  id: string;
  user_id: string;
  type: 'url' | 'image';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  input_url: string | null;
  input_image_path: string | null;
  result_recipe_id: string | null;
  error_message: string | null;
  retries: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// User Preferences
// ============================================================================

export interface UserPreferences {
  user_id: string;
  dietary_restrictions: string[];
  preferred_cuisines: string[];
  excluded_ingredients: string[];
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Daily Suggestions
// ============================================================================

export interface DailySuggestion {
  id: string;
  user_id: string;
  recipe_data: SuggestedRecipeData;
  generated_at: string;
  expires_at: string;
  saved_recipe_id: string | null;
  run_id?: string | null;
  trigger_source?: 'manual' | 'scheduled';
  rank?: number | null;
}

export interface SuggestedRecipeData {
  title: string;
  description?: string;
  ingredients: Array<{
    raw_text: string;
    quantity?: number;
    unit?: string;
    ingredient_name?: string;
  }>;
  steps: Array<{
    instruction: string;
  }>;
  prep_time_minutes?: number;
  cook_time_minutes?: number;
  servings?: number;
  calories?: number;
  tags?: string[];
  cuisine?: string;
  dietary_labels?: string[];
  media?: Array<{
    media_type: 'image' | 'video';
    url: string;
    name?: string | null;
    is_generated?: boolean;
  }>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Usage Counters
// ============================================================================

export interface UsageCounter {
  id: string;
  user_id: string;
  date: string;
  imports_count: number;
  ai_generations_count: number;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

// ============================================================================
// Recipe List Item (for feed/list views)
// ============================================================================

export interface RecipeListItem {
  id: string;
  title: string;
  description: string | null;
  calories: number | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  servings: number | null;
  tags: string[];
  cuisine: string | null;
  source_type: 'manual' | 'url' | 'image' | 'ai';
  created_at: string;
  media: Array<{
    media_type: 'image' | 'video';
    url: string;
    name: string | null;
  }>;
}
