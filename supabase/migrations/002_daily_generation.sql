-- ============================================================================
-- Daily generation runs + suggestion metadata
-- ============================================================================

CREATE TABLE daily_recipe_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger_source text NOT NULL CHECK (trigger_source IN ('manual', 'scheduled')),
  target_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'superseded')),
  batch_id text,
  superseded_by uuid REFERENCES daily_recipe_runs(id),
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE daily_suggestions
  ADD COLUMN run_id uuid REFERENCES daily_recipe_runs(id) ON DELETE SET NULL,
  ADD COLUMN trigger_source text NOT NULL DEFAULT 'scheduled',
  ADD COLUMN rank int;

ALTER TABLE daily_suggestions
  ADD CONSTRAINT daily_suggestions_trigger_source_check
  CHECK (trigger_source IN ('manual', 'scheduled'));

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_type_check;
ALTER TABLE import_jobs
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN target_date date;
ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_type_check
  CHECK (type IN ('url', 'image', 'daily_generation'));

ALTER TABLE daily_recipe_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own daily runs" ON daily_recipe_runs
  FOR ALL USING (user_id = auth.uid());

CREATE INDEX idx_daily_recipe_runs_user_date_created
  ON daily_recipe_runs(user_id, target_date, created_at DESC);

CREATE INDEX idx_daily_suggestions_user_run_rank
  ON daily_suggestions(user_id, run_id, rank);
