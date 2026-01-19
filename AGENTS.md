# Agents Notes

Short context for future work on daily AI recipes and cron jobs.

- Daily generation creates a shared meal plan: 2 breakfast, 2 lunch, 2 dinner, 2 dessert for all users; stored in `daily_meal_plans` + `daily_meal_plan_items` (`meal_type`, `rank`).
  - AI recipes for the plan are saved in `recipes` (global: `user_id = NULL`); user saves create copies with `source_recipe_id` and a `recipe_saves` row.
- Legacy: `daily_suggestions` is no longer written by the daily plan flow (kept for historical data only).
- Daily refresh uses historical `daily_meal_plan_items` and excludes items already saved by the requesting user.
- `GET /api/v1/daily/suggestions` falls back to refresh-style historical picks when no completed plan exists for the day.
- Backfill: `npm run backfill:daily-plans` migrates legacy `daily_suggestions` into `daily_meal_plans`/`daily_meal_plan_items` and `recipe_saves` (requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; uses `.env`).
- Backfill: `npm run backfill:normalize-recipes` rewrites `recipes.cuisine`, `recipes.dietary_labels`, and `recipes.tags` to canonical snake_case values (requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; uses `.env`).
- Backfill: `npm run backfill:recipe-saves` creates missing `recipe_saves` rows for user-owned recipes (uses recipe `created_at` for ordering; requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; uses `.env`).
- Manual generation endpoint `POST /api/v1/daily/generate` is admin-only (env: `DAILY_GENERATION_ADMIN_EMAILS` or `DAILY_GENERATION_ADMIN_USER_IDS`).
- User refresh is `GET /api/v1/daily/refresh?count_per_meal=2`, non-persistent, returns random historical suggestions per meal type.
- Recipe saves use `GET /api/v1/recipe-saves` (returns saved copies + user-owned recipes; `id` is the save id for saved copies or the recipe id for owned items, `is_saved` flags entries), `POST /api/v1/recipe-saves` (source_type: daily_plan_item | recipe | share, returns `recipe_data`), and `DELETE /api/v1/recipe-saves/:id`.
- Uploads: `POST /api/v1/uploads/recipe-images` (requires `content_type`, `file_size_bytes`, optional `file_name`, 10 MB max) returns a signed upload URL for Supabase public storage; client uploads binary, then uses `public_url` in recipe `media`.
- Recipe payloads now include `ownership` (is_user_owned/can_edit/can_delete) and `editable_recipe_id` to signal editability without exposing user ids.
- Import URL preview order: JSON-LD, ChatGPT share parser, Readability (jsdom), heuristics, then AI fallback (optionally using extracted text); returns a recipe envelope without persisting until `/recipes` is called.
- Dietary labels are normalized to this canonical snake_case list in AI generation, URL extraction, and DB writes/reads: vegan, vegetarian, gluten_free, dairy_free, nut_free, shellfish_free, keto_friendly, high_protein.
- Cuisine is normalized to this canonical snake_case list in AI generation, URL extraction, and DB writes/reads: american, mexican, italian, chinese, japanese, korean, thai, vietnamese, indian, mediterranean, middle_eastern, french, caribbean, soul_food.
- Tags are normalized to this canonical snake_case list in AI generation, URL extraction, and DB writes/reads: breakfast, meal, dessert, snack.
- Cron job entry: `npm run jobs:daily` runs `scripts/daily-generation.sh` -> `dist/jobs/daily-generation.js`.
  - Script loads `.env` if present; Render injects env vars directly (no `.env`).
- Auth: API auth uses Supabase access tokens verified via JWKS (RS256) against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` with `apikey: ${SUPABASE_ANON_KEY}`; requires `aud=authenticated` and matching issuer (`${SUPABASE_URL}/auth/v1`). `SUPABASE_JWT_SECRET` is no longer used.
- OpenAI: `OPENAI_MODEL` uses `max_completion_tokens` (env: `OPENAI_MAX_COMPLETION_TOKENS`).
  - JSON schema uses `additionalProperties: false` and requires all properties (nullable allowed).
- Image generation: `DALLE_MODEL` must be supported value (e.g., `gpt-image-1.5` or `dall-e-3`).
  - `style`/`quality` only sent for `dall-e-3`; base64 handling for non-DALL-E URL responses.
- Migrations: `002_daily_generation.sql` (runs + suggestion metadata), `003_remove_daily_ai_enabled.sql` (removed opt-out flag), `004_shared_daily_plans.sql` (shared plans + recipe saves).
- Project structure: `src/` app code, `scripts/` cron/ops, `dist/` build output, `supabase/` SQL/migrations, `docs/` notes.
- Build/run commands: `npm run dev`, `npm run build`, `npm run start`, `npm run typecheck`, `npm run jobs:daily`.
- TypeScript ESM project; avoid editing `dist/` directly—regenerate via `npm run build`.
- Config hygiene: local dev uses `.env` (tsx `--env-file`); production uses injected env vars—don’t commit secrets.
- Always update this markdown file if any changes effect the context found here
- After making any code changes always, run `npm run build`. If any issues appear try to fix them
