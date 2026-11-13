-- =====================================================================
--  Mizan 002 - Tables. Run after 001_auth.sql. Safe to run again.
--
--  Design notes (the non-obvious ones):
--  * Months are stored as a DATE on the 1st of the month (domain month_date),
--    so SQL can compare and sort them and nobody can store "2026-11-15".
--  * Money is numeric(16,2). Never float.
--  * Every user-owned table has user_id with default app_uid(). Child tables
--    repeat user_id and use a composite FK (parent_id, user_id) to the
--    parent's (id, user_id). That makes it impossible for a child row of
--    user A to hang under a parent row of user B, and lets every RLS policy
--    be a simple "user_id = app_uid()" without joins.
--  * Plan versions are immutable snapshots (copy on write). A new version
--    copies all items. Items carry a stable item_key (uuid) across versions,
--    so actuals point at item_key and stay attached when the plan changes.
-- =====================================================================

do $$ begin
  create domain public.month_date as date
    check (value = date_trunc('month', value)::date);
exception when duplicate_object then null; end $$;

do $$ begin
  create domain public.money as numeric(16,2);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
--  Settings and goal (one row per user)
-- ---------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id              uuid primary key default public.app_uid()
                       references public.profiles(id) on delete cascade,
  gold_sell_spread_pct numeric(5,2) not null default 3.00 check (gold_sell_spread_pct between 0 and 50),
  updated_at           timestamptz not null default now()
);

create table if not exists public.goals (
  user_id                uuid primary key default public.app_uid()
                         references public.profiles(id) on delete cascade,
  target_amount          public.money not null check (target_amount > 0),
  target_month           public.month_date not null,
  monthly_savings_target public.money check (monthly_savings_target is null or monthly_savings_target >= 0),
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Plan versions (immutable). Written only through save_plan_version().
-- ---------------------------------------------------------------------
create table if not exists public.plan_versions (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  version_no      int not null check (version_no >= 1),
  effective_from  public.month_date not null,     -- months >= this are compared against this version
  start_month     public.month_date not null,
  horizon_months  int not null default 24 check (horizon_months between 1 and 240),
  opening_balance public.money not null check (opening_balance >= 0),
  note            text not null default '' check (length(note) <= 500),
  created_at      timestamptz not null default now(),
  unique (user_id, version_no),
  unique (id, user_id),
  check (effective_from >= start_month)
);

create table if not exists public.plan_items (
  id          bigint generated always as identity primary key,
  version_id  bigint not null,
  user_id     uuid not null default public.app_uid(),
  item_key    uuid not null,
  kind        text not null check (kind in ('income', 'expense', 'asset')),
  name        text not null check (length(trim(name)) between 1 and 80),
  recurrence  text not null check (recurrence in ('recurring', 'one_off')),
  start_month public.month_date not null,
  end_month   public.month_date,
  sort_order  int not null default 0,
  unique (version_id, item_key),
  unique (id, user_id),
  foreign key (version_id, user_id) references public.plan_versions (id, user_id) on delete cascade,
  check (end_month is null or end_month >= start_month),
  check (kind <> 'asset' or recurrence = 'recurring')
);
create index if not exists plan_items_user_idx on public.plan_items (user_id);

-- recurring: amount applies from "month" until the next change (step function)
-- one_off:   amount happens exactly in "month"
create table if not exists public.plan_item_amounts (
  id      bigint generated always as identity primary key,
  item_id bigint not null,
  user_id uuid not null default public.app_uid(),
  month   public.month_date not null,
  amount  public.money not null check (amount >= 0),
  unique (item_id, month),
  foreign key (item_id, user_id) references public.plan_items (id, user_id) on delete cascade
);
create index if not exists plan_item_amounts_user_idx on public.plan_item_amounts (user_id);

create table if not exists public.plan_rates (
  id              bigint generated always as identity primary key,
  version_id      bigint not null,
  user_id         uuid not null default public.app_uid(),
  from_month      public.month_date not null,
  annual_rate_pct numeric(7,4) not null check (annual_rate_pct between 0 and 100),
  unique (version_id, from_month),
  foreign key (version_id, user_id) references public.plan_versions (id, user_id) on delete cascade
);
create index if not exists plan_rates_user_idx on public.plan_rates (user_id);

-- ---------------------------------------------------------------------
--  Actuals
-- ---------------------------------------------------------------------
-- A month you have checked in. Optional real bank balance overrides the computed one.
create table if not exists public.monthly_checkins (
  user_id         uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  month           public.month_date not null,
  savings_balance public.money check (savings_balance is null or savings_balance >= 0),
  note            text not null default '' check (length(note) <= 500),
  updated_at      timestamptz not null default now(),
  primary key (user_id, month)
);

-- Real amount for a planned line (identified by its stable item_key)
create table if not exists public.actual_entries (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  month      public.month_date not null,
  item_key   uuid not null,
  amount     public.money not null check (amount >= 0),
  note       text not null default '' check (length(note) <= 500),
  updated_at timestamptz not null default now(),
  unique (user_id, month, item_key)
);

-- Things that were not in the plan (car repair, a gift received ...)
create table if not exists public.unplanned_items (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  month      public.month_date not null,
  kind       text not null check (kind in ('income', 'expense')),
  name       text not null check (length(trim(name)) between 1 and 80),
  amount     public.money not null check (amount > 0),
  note       text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists unplanned_items_user_month_idx on public.unplanned_items (user_id, month);

-- ---------------------------------------------------------------------
--  Gold
-- ---------------------------------------------------------------------
create table if not exists public.gold_holdings (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  label          text not null check (length(trim(label)) between 1 and 80),
  karat          smallint not null check (karat in (24, 21, 18)),
  grams          numeric(10,3) not null check (grams > 0),
  purchase_price public.money not null check (purchase_price >= 0),   -- total paid, EGP
  purchase_date  date not null,
  sold_date      date,
  created_at     timestamptz not null default now(),
  check (sold_date is null or sold_date >= purchase_date)
);
create index if not exists gold_holdings_user_idx on public.gold_holdings (user_id);

-- Shared price history, written only by the Edge Function (service role).
create table if not exists public.gold_prices (
  id                 bigint generated always as identity primary key,
  fetched_at         timestamptz not null default now(),
  karat              smallint not null check (karat in (24, 21, 18)),
  price_per_gram_egp numeric(12,2) not null check (price_per_gram_egp > 0),
  source             text not null,
  unique (fetched_at, karat, source)
);
create index if not exists gold_prices_karat_time_idx on public.gold_prices (karat, fetched_at desc);

-- Your own shop price. Latest row per karat wins until you add a newer API-only row (cleared = true).
create table if not exists public.gold_price_overrides (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  karat              smallint not null check (karat in (24, 21, 18)),
  price_per_gram_egp numeric(12,2) check (price_per_gram_egp is null or price_per_gram_egp > 0),
  cleared            boolean not null default false,
  set_at             timestamptz not null default now(),
  check (cleared = (price_per_gram_egp is null))
);
create index if not exists gold_overrides_user_idx on public.gold_price_overrides (user_id, karat, set_at desc);

-- ---------------------------------------------------------------------
--  History (append-only). Written by triggers and RPCs, never by the client.
-- ---------------------------------------------------------------------
create table if not exists public.audit_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  at         timestamptz not null default now(),
  event_type text not null check (event_type in ('insert', 'update', 'delete', 'plan_version', 'upload')),
  entity     text not null,
  entity_id  text,
  month      date,
  summary    text not null,
  details    jsonb not null default '{}'
);
create index if not exists audit_events_user_time_idx on public.audit_events (user_id, at desc);
