-- ============================================================================
-- Remove daily AI opt-out flag (always generate for all users)
-- ============================================================================

ALTER TABLE user_preferences
  DROP COLUMN IF EXISTS daily_ai_enabled;
