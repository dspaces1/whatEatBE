-- Add calories to existing recipes table
ALTER TABLE recipes ADD COLUMN calories int;

-- Add source tracking for feed recipes saved by users
ALTER TABLE recipes ADD COLUMN source_feed_recipe_id uuid;

-- Create feed_recipes table (global AI recipes, no user ownership)
CREATE TABLE feed_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  calories int,
  prep_time_minutes int,
  cook_time_minutes int,
  servings int,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

-- Create feed_recipe_media table
CREATE TABLE feed_recipe_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_recipe_id uuid NOT NULL REFERENCES feed_recipes(id) ON DELETE CASCADE,
  position int NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image', 'video')),
  url text NOT NULL,
  name text,
  created_at timestamptz DEFAULT now()
);

-- Create feed_recipe_ingredients table
CREATE TABLE feed_recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_recipe_id uuid NOT NULL REFERENCES feed_recipes(id) ON DELETE CASCADE,
  position int NOT NULL,
  raw_text text NOT NULL,
  quantity numeric,
  unit text,
  ingredient_name text,
  created_at timestamptz DEFAULT now()
);

-- Create feed_recipe_steps table
CREATE TABLE feed_recipe_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_recipe_id uuid NOT NULL REFERENCES feed_recipes(id) ON DELETE CASCADE,
  position int NOT NULL,
  instruction text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Create recipe_media table (for user recipes)
CREATE TABLE recipe_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position int NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image', 'video')),
  url text NOT NULL,
  name text,
  created_at timestamptz DEFAULT now()
);

-- Add foreign key constraint for source_feed_recipe_id after feed_recipes table exists
ALTER TABLE recipes 
  ADD CONSTRAINT fk_recipes_source_feed_recipe 
  FOREIGN KEY (source_feed_recipe_id) REFERENCES feed_recipes(id);

-- RLS Policies for feed_recipes (public read)
ALTER TABLE feed_recipes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Feed recipes are publicly readable" ON feed_recipes
  FOR SELECT USING (deleted_at IS NULL);

-- RLS Policies for feed_recipe_media (public read)
ALTER TABLE feed_recipe_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Feed recipe media is publicly readable" ON feed_recipe_media
  FOR SELECT USING (feed_recipe_id IN (SELECT id FROM feed_recipes WHERE deleted_at IS NULL));

-- RLS Policies for feed_recipe_ingredients (public read)
ALTER TABLE feed_recipe_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Feed recipe ingredients are publicly readable" ON feed_recipe_ingredients
  FOR SELECT USING (feed_recipe_id IN (SELECT id FROM feed_recipes WHERE deleted_at IS NULL));

-- RLS Policies for feed_recipe_steps (public read)
ALTER TABLE feed_recipe_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Feed recipe steps are publicly readable" ON feed_recipe_steps
  FOR SELECT USING (feed_recipe_id IN (SELECT id FROM feed_recipes WHERE deleted_at IS NULL));

-- RLS Policies for recipe_media (follows recipe ownership)
ALTER TABLE recipe_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own recipe media" ON recipe_media
  FOR ALL USING (recipe_id IN (SELECT id FROM recipes WHERE user_id = auth.uid()));

-- Indexes for feed_recipes
CREATE INDEX idx_feed_recipes_created_at ON feed_recipes(created_at DESC);
CREATE INDEX idx_feed_recipes_deleted_at ON feed_recipes(deleted_at) WHERE deleted_at IS NULL;

-- Indexes for feed_recipe_media
CREATE INDEX idx_feed_recipe_media_feed_recipe_id ON feed_recipe_media(feed_recipe_id);

-- Indexes for feed_recipe_ingredients
CREATE INDEX idx_feed_recipe_ingredients_feed_recipe_id ON feed_recipe_ingredients(feed_recipe_id);

-- Indexes for feed_recipe_steps
CREATE INDEX idx_feed_recipe_steps_feed_recipe_id ON feed_recipe_steps(feed_recipe_id);

-- Indexes for recipe_media
CREATE INDEX idx_recipe_media_recipe_id ON recipe_media(recipe_id);

-- Updated_at trigger for feed_recipes
CREATE TRIGGER update_feed_recipes_updated_at
  BEFORE UPDATE ON feed_recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
