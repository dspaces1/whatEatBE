# Agents Notes

Short context for future work on daily AI recipes and cron jobs.

- Daily generation creates a shared meal plan: 2 breakfast, 2 lunch, 2 dinner, 2 dessert for all users; stored in `daily_meal_plans` + `daily_meal_plan_items` (`meal_type`, `rank`).
  - AI recipes for the plan are saved in `recipes` (global: `user_id = NULL`); user saves create copies with `source_recipe_id` and a `recipe_saves` row.
- Legacy: `daily_suggestions` is no longer written by the daily plan flow (kept for historical data only).
- Daily refresh uses historical `daily_meal_plan_items` and excludes items already saved by the requesting user.
- Backfill: `npm run backfill:daily-plans` migrates legacy `daily_suggestions` into `daily_meal_plans`/`daily_meal_plan_items` and `recipe_saves` (requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; uses `.env`).
- Manual generation endpoint `POST /api/v1/daily/generate` is admin-only (env: `DAILY_GENERATION_ADMIN_EMAILS` or `DAILY_GENERATION_ADMIN_USER_IDS`).
- User refresh is `GET /api/v1/daily/refresh?count_per_meal=2`, non-persistent, returns random historical suggestions per meal type.
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
