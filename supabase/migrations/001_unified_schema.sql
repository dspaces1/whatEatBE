-- ============================================================================
-- whatEat Unified Recipe Schema
-- ============================================================================
-- Single recipes table handles both user recipes and global AI feed recipes.
-- user_id = NULL means it's a global/AI-generated feed recipe.
-- Sharing is handled via recipe_shares tokens, not visibility flags.
-- ============================================================================

-- Recipes table (unified: user recipes + global feed recipes)
CREATE TABLE recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL = global feed recipe
  
  -- Core fields
  title text NOT NULL,
  description text,
  servings int,
  calories int,
  prep_time_minutes int,
  cook_time_minutes int,
  
  -- Categorization (free-form arrays)
  tags text[] DEFAULT '{}',
  cuisine text,
  dietary_labels text[] DEFAULT '{}',
  
  -- Source tracking
  source_type text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'url', 'image', 'ai')),
  source_url text,
  source_recipe_id uuid REFERENCES recipes(id),  -- for copies/forks
  
  -- Flexible metadata (attribution, author_name, share_notes, etc.)
  metadata jsonb DEFAULT '{}',
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

-- Recipe ingredients
CREATE TABLE recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position int NOT NULL,
  raw_text text NOT NULL,
  quantity numeric,
  unit text,
  ingredient_name text,
  created_at timestamptz DEFAULT now()
);

-- Recipe steps
CREATE TABLE recipe_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position int NOT NULL,
  instruction text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Recipe media (images, videos - both external URLs and storage paths)
CREATE TABLE recipe_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position int NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image', 'video')),
  url text NOT NULL,
  storage_path text,  -- Supabase storage path if uploaded
  name text,
  is_generated boolean DEFAULT false,  -- true if DALL-E generated
  created_at timestamptz DEFAULT now()
);

-- Recipe shares (for shareable public links)
CREATE TABLE recipe_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  share_token text NOT NULL UNIQUE,  -- short URL-safe token (e.g., "abc123xyz")
  created_by uuid REFERENCES auth.users(id),
  expires_at timestamptz,  -- NULL = never expires
  view_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Import jobs for async processing
CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('url', 'image')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  input_url text,
  input_image_path text,
  result_recipe_id uuid REFERENCES recipes(id),
  error_message text,
  retries int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- User preferences
CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_ai_enabled boolean DEFAULT false,
  dietary_restrictions text[] DEFAULT '{}',
  preferred_cuisines text[] DEFAULT '{}',
  excluded_ingredients text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Daily AI suggestions (personalized per user, stored as JSONB)
CREATE TABLE daily_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipe_data jsonb NOT NULL,
  generated_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  saved_recipe_id uuid REFERENCES recipes(id)
);

-- Usage tracking for rate limiting
CREATE TABLE usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date date NOT NULL DEFAULT current_date,
  imports_count int DEFAULT 0,
  ai_generations_count int DEFAULT 0,
  UNIQUE(user_id, date)
);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

-- Recipes: users see own + global (user_id IS NULL) + shared via token
CREATE POLICY "Users see own recipes" ON recipes
  FOR ALL USING (
    user_id = auth.uid() OR 
    user_id IS NULL  -- global feed recipes are public
  );

-- Recipe ingredients: follow recipe visibility
CREATE POLICY "Recipe ingredients follow recipe access" ON recipe_ingredients
  FOR ALL USING (
    recipe_id IN (
      SELECT id FROM recipes 
      WHERE user_id = auth.uid() OR user_id IS NULL
    )
  );

-- Recipe steps: follow recipe visibility
CREATE POLICY "Recipe steps follow recipe access" ON recipe_steps
  FOR ALL USING (
    recipe_id IN (
      SELECT id FROM recipes 
      WHERE user_id = auth.uid() OR user_id IS NULL
    )
  );

-- Recipe media: follow recipe visibility
CREATE POLICY "Recipe media follow recipe access" ON recipe_media
  FOR ALL USING (
    recipe_id IN (
      SELECT id FROM recipes 
      WHERE user_id = auth.uid() OR user_id IS NULL
    )
  );

-- Recipe shares: users manage own shares
CREATE POLICY "Users manage own recipe shares" ON recipe_shares
  FOR ALL USING (created_by = auth.uid());

-- Import jobs: users see own
CREATE POLICY "Users see own jobs" ON import_jobs
  FOR ALL USING (user_id = auth.uid());

-- User preferences: users see own
CREATE POLICY "Users see own preferences" ON user_preferences
  FOR ALL USING (user_id = auth.uid());

-- Daily suggestions: users see own
CREATE POLICY "Users see own suggestions" ON daily_suggestions
  FOR ALL USING (user_id = auth.uid());

-- Usage counters: users see own
CREATE POLICY "Users see own usage" ON usage_counters
  FOR ALL USING (user_id = auth.uid());

-- ============================================================================
-- Indexes
-- ============================================================================

-- Recipes
CREATE INDEX idx_recipes_user_id ON recipes(user_id);
CREATE INDEX idx_recipes_user_id_null ON recipes(id) WHERE user_id IS NULL;  -- fast feed queries
CREATE INDEX idx_recipes_created_at ON recipes(created_at DESC);
CREATE INDEX idx_recipes_deleted_at ON recipes(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_recipes_source_type ON recipes(source_type);
CREATE INDEX idx_recipes_tags ON recipes USING GIN(tags);
CREATE INDEX idx_recipes_dietary_labels ON recipes USING GIN(dietary_labels);
CREATE INDEX idx_recipes_cuisine ON recipes(cuisine);

-- Recipe ingredients
CREATE INDEX idx_recipe_ingredients_recipe_id ON recipe_ingredients(recipe_id);

-- Recipe steps
CREATE INDEX idx_recipe_steps_recipe_id ON recipe_steps(recipe_id);

-- Recipe media
CREATE INDEX idx_recipe_media_recipe_id ON recipe_media(recipe_id);

-- Recipe shares
CREATE INDEX idx_recipe_shares_recipe_id ON recipe_shares(recipe_id);
CREATE INDEX idx_recipe_shares_token ON recipe_shares(share_token);

-- Import jobs
CREATE INDEX idx_import_jobs_user_status ON import_jobs(user_id, status);

-- Daily suggestions
CREATE INDEX idx_daily_suggestions_user_date ON daily_suggestions(user_id, generated_at DESC);

-- Usage counters
CREATE INDEX idx_usage_counters_user_date ON usage_counters(user_id, date);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_recipes_updated_at
  BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_import_jobs_updated_at
  BEFORE UPDATE ON import_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
