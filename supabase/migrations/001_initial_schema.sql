-- Recipes table
create table recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  source_type text not null check (source_type in ('manual', 'url', 'image', 'ai')),
  source_url text,
  image_path text,
  prep_time_minutes int,
  cook_time_minutes int,
  servings int,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

-- Recipe ingredients
create table recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  position int not null,
  raw_text text not null,
  quantity numeric,
  unit text,
  ingredient_name text,
  created_at timestamptz default now()
);

-- Recipe steps
create table recipe_steps (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  position int not null,
  instruction text not null,
  created_at timestamptz default now()
);

-- Import jobs for async processing
create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('url', 'image')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  input_url text,
  input_image_path text,
  result_recipe_id uuid references recipes(id),
  error_message text,
  retries int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- User preferences
create table user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_ai_enabled boolean default false,
  dietary_restrictions text[] default '{}',
  preferred_cuisines text[] default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Daily AI suggestions
create table daily_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_data jsonb not null,
  generated_at timestamptz default now(),
  expires_at timestamptz not null,
  saved_recipe_id uuid references recipes(id)
);

-- Usage tracking for rate limiting
create table usage_counters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null default current_date,
  imports_count int default 0,
  ai_generations_count int default 0,
  unique(user_id, date)
);

-- RLS Policies
alter table recipes enable row level security;
alter table recipe_ingredients enable row level security;
alter table recipe_steps enable row level security;
alter table import_jobs enable row level security;
alter table user_preferences enable row level security;
alter table daily_suggestions enable row level security;
alter table usage_counters enable row level security;

-- Users can only see their own data
create policy "Users see own recipes" on recipes
  for all using (auth.uid() = user_id);

create policy "Users see own ingredients" on recipe_ingredients
  for all using (recipe_id in (select id from recipes where user_id = auth.uid()));

create policy "Users see own steps" on recipe_steps
  for all using (recipe_id in (select id from recipes where user_id = auth.uid()));

create policy "Users see own jobs" on import_jobs
  for all using (auth.uid() = user_id);

create policy "Users see own preferences" on user_preferences
  for all using (auth.uid() = user_id);

create policy "Users see own suggestions" on daily_suggestions
  for all using (auth.uid() = user_id);

create policy "Users see own usage" on usage_counters
  for all using (auth.uid() = user_id);

-- Indexes
create index idx_recipes_user_id on recipes(user_id);
create index idx_recipes_created_at on recipes(created_at desc);
create index idx_recipes_deleted_at on recipes(deleted_at) where deleted_at is null;
create index idx_import_jobs_user_status on import_jobs(user_id, status);
create index idx_daily_suggestions_user_date on daily_suggestions(user_id, generated_at desc);
create index idx_usage_counters_user_date on usage_counters(user_id, date);

-- Updated_at trigger function
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Apply updated_at triggers
create trigger update_recipes_updated_at
  before update on recipes
  for each row execute function update_updated_at_column();

create trigger update_import_jobs_updated_at
  before update on import_jobs
  for each row execute function update_updated_at_column();

create trigger update_user_preferences_updated_at
  before update on user_preferences
  for each row execute function update_updated_at_column();


