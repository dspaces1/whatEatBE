-- ============================================================================
-- Shared daily meal plans + recipe saves
-- ============================================================================

CREATE TABLE daily_meal_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_date date NOT NULL,
  trigger_source text NOT NULL CHECK (trigger_source IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE daily_meal_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES daily_meal_plans(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  meal_type text NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'dessert')),
  rank int NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE recipe_saves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  source_recipe_id uuid REFERENCES recipes(id),
  daily_plan_item_id uuid REFERENCES daily_meal_plan_items(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE daily_meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_meal_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_saves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see daily meal plans" ON daily_meal_plans
  FOR SELECT USING (true);

CREATE POLICY "Users see daily meal plan items" ON daily_meal_plan_items
  FOR SELECT USING (true);

CREATE POLICY "Users manage own recipe saves" ON recipe_saves
  FOR ALL USING (user_id = auth.uid());

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX idx_daily_meal_plans_date_created
  ON daily_meal_plans(plan_date, created_at DESC);

CREATE UNIQUE INDEX idx_daily_meal_plan_items_plan_rank
  ON daily_meal_plan_items(plan_id, rank);

CREATE INDEX idx_daily_meal_plan_items_plan_id
  ON daily_meal_plan_items(plan_id);

CREATE INDEX idx_daily_meal_plan_items_recipe_id
  ON daily_meal_plan_items(recipe_id);

CREATE UNIQUE INDEX idx_recipe_saves_user_recipe
  ON recipe_saves(user_id, recipe_id);

CREATE UNIQUE INDEX idx_recipe_saves_user_plan_item
  ON recipe_saves(user_id, daily_plan_item_id)
  WHERE daily_plan_item_id IS NOT NULL;

CREATE INDEX idx_recipe_saves_user_id
  ON recipe_saves(user_id);
