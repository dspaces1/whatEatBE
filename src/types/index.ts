export type { Database, Json } from './supabase.js';
export type { AuthenticatedRequest } from './express.js';

// Recipe types for API responses
export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  position: number;
  raw_text: string;
  quantity: number | null;
  unit: string | null;
  ingredient_name: string | null;
}

export interface RecipeStep {
  id: string;
  recipe_id: string;
  position: number;
  instruction: string;
}

export interface Recipe {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  source_type: 'manual' | 'url' | 'image' | 'ai';
  source_url: string | null;
  image_path: string | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  servings: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  ingredients?: RecipeIngredient[];
  steps?: RecipeStep[];
}

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

export interface UserPreferences {
  user_id: string;
  daily_ai_enabled: boolean;
  dietary_restrictions: string[];
  preferred_cuisines: string[];
  created_at: string;
  updated_at: string;
}

export interface DailySuggestion {
  id: string;
  user_id: string;
  recipe_data: SuggestedRecipeData;
  generated_at: string;
  expires_at: string;
  saved_recipe_id: string | null;
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
}

// API response types
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





