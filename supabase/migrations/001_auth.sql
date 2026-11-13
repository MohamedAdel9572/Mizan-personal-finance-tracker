-- =====================================================================
--  Mizan 001 - Own login (copied from skn-clinic/supabase/own-login.sql)
--  Mobile number + password. No Supabase Auth. Run first. Safe to run again.
--
--  * Passwords: bcrypt via pgcrypto, never stored readable.
--  * Session tokens: random 32 bytes, only the sha256 hash is stored.
--    The browser sends the token in the "x-mizan-session" header and
--    public.app_uid() turns it into the user id for RLS.
--  * 5 wrong passwords -> account locked for 15 minutes.
--
--  Changes vs skn-clinic (on purpose):
--  * Lock counter restarts after a lock expires. In skn-clinic the counter
--    stayed at 5, so the first wrong password after a lock re-locked at once.
--  * Minimum password length 8 (finance data) instead of 6.
--  * Changing the password signs out every other device.
--  * Optional sign-up code (private.settings 'signup_code') so strangers
--    can't create accounts on your free Supabase project.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.settings (
  key   text primary key,
  value text not null
);

create or replace function private.setting(p_key text)
returns text language sql stable security definer set search_path = '' as $$
  select value from private.settings where key = p_key
$$;

-- 01xxxxxxxxx / +20 1xx... / 20 1xx... -> 01xxxxxxxxx  (same as skn-clinic)
create or replace function private.norm_mobile(p text)
returns text language sql immutable set search_path = '' as $$
  select case
           when x.d ~ '^201[0-9]{9}$' then '0' || substr(x.d, 3)
           when x.d ~ '^1[0-9]{9}$'   then '0' || x.d
           else x.d
         end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

-- ---------------------------------------------------------------------
--  Users = public.profiles + private.accounts (password) + private.sessions
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key default gen_random_uuid(),
  full_name  text not null check (length(full_name) between 1 and 80),
  mobile     text not null unique check (mobile ~ '^[0-9]{8,15}$'),
  created_at timestamptz not null default now()
);

create table if not exists private.accounts (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  password_hash   text not null,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists private.sessions (
  token_hash text primary key,                -- sha256 of the token; the token itself is never stored
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on private.sessions (user_id);

create or replace function private.request_token()
returns text language plpgsql stable set search_path = '' as $$
declare
  tok text;
begin
  begin
    tok := nullif(current_setting('request.headers', true), '')::json ->> 'x-mizan-session';
  exception when others then
    return null;
  end;
  return tok;
end $$;

create or replace function private.token_hash(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

-- Who is calling? null when signed out / expired / unknown token.
create or replace function public.app_uid()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  tok text := private.request_token();
  uid uuid;
begin
  if tok is null or length(tok) < 32 then
    return null;
  end if;
  select s.user_id into uid
    from private.sessions s
   where s.token_hash = private.token_hash(tok)
     and s.expires_at > now();
  return uid;
end $$;

create or replace function private.new_session(p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  tok text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from private.sessions where expires_at < now();
  insert into private.sessions (token_hash, user_id, expires_at)
  values (private.token_hash(tok), p_user, now() + interval '60 days');
  return tok;
end $$;

create or replace function private.check_password_rules(p_password text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'Password must be at least 8 characters.' using errcode = 'P0001';
  end if;
  if length(p_password) > 72 then   -- bcrypt ignores anything after 72 bytes
    raise exception 'Password must be at most 72 characters.' using errcode = 'P0001';
  end if;
end $$;

-- Sign up -> returns a session token
create or replace function public.app_signup(p_full_name text, p_mobile text, p_password text,
                                             p_signup_code text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  m    text := private.norm_mobile(p_mobile);
  code text := private.setting('signup_code');
  uid  uuid;
begin
  if code is not null and code <> '' and coalesce(p_signup_code, '') <> code then
    raise exception 'Sign-up is closed. Ask the owner for the sign-up code.';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'Please enter your name.';
  end if;
  if length(m) < 8 or length(m) > 15 then
    raise exception 'Please enter a valid mobile number.';
  end if;
  perform private.check_password_rules(p_password);

  if exists (select 1 from public.profiles p where p.mobile = m) then
    raise exception 'This mobile number is already registered. Please sign in.';
  end if;

  insert into public.profiles (full_name, mobile)
  values (left(trim(p_full_name), 80), m)
  returning id into uid;

  insert into private.accounts (user_id, password_hash)
  values (uid, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));

  insert into public.user_settings (user_id) values (uid);

  return private.new_session(uid);
end $$;

-- Sign in -> {"token": "..."} or {"error": "..."}
-- Returns errors instead of raising so the failed-attempt counter is saved
-- (a raised exception would roll the counter update back).
create or replace function public.app_login(p_mobile text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m   text := private.norm_mobile(p_mobile);
  uid uuid;
  a   private.accounts;
begin
  select p.id into uid from public.profiles p where p.mobile = m;
  if uid is not null then
    select * into a from private.accounts where user_id = uid for update;
  end if;
  if uid is null or a.user_id is null then
    perform pg_sleep(0.3);
    return jsonb_build_object('error', 'Wrong mobile number or password.');
  end if;

  if a.locked_until is not null and a.locked_until > now() then
    return jsonb_build_object('error', 'Too many wrong attempts. Please try again in 15 minutes.');
  end if;

  if a.locked_until is not null then   -- lock has expired: start counting again
    a.failed_attempts := 0;
  end if;

  if a.password_hash <> extensions.crypt(coalesce(p_password, ''), a.password_hash) then
    update private.accounts
       set failed_attempts = a.failed_attempts + 1,
           locked_until = case when a.failed_attempts + 1 >= 5 then now() + interval '15 minutes' end
     where user_id = uid;
    if a.failed_attempts + 1 >= 5 then
      return jsonb_build_object('error', 'Too many wrong attempts. Please try again in 15 minutes.');
    end if;
    return jsonb_build_object('error', 'Wrong mobile number or password.');
  end if;

  update private.accounts set failed_attempts = 0, locked_until = null where user_id = uid;
  return jsonb_build_object('token', private.new_session(uid));
end $$;

create or replace function public.app_logout()
returns void language plpgsql security definer set search_path = '' as $$
declare
  tok text := private.request_token();
begin
  if tok is not null then
    delete from private.sessions where token_hash = private.token_hash(tok);
  end if;
end $$;

create or replace function public.app_me()
returns setof public.profiles language sql stable security definer set search_path = '' as $$
  select * from public.profiles where id = public.app_uid()
$$;

-- Change your own password. Every other device is signed out; this one stays signed in.
create or replace function public.app_change_password(p_old text, p_new text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a private.accounts;
begin
  select * into a from private.accounts where user_id = public.app_uid();
  if not found then raise exception 'Please sign in first.'; end if;
  if a.password_hash <> extensions.crypt(coalesce(p_old, ''), a.password_hash) then
    raise exception 'Current password is wrong.';
  end if;
  perform private.check_password_rules(p_new);
  update private.accounts
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10))
   where user_id = a.user_id;
  delete from private.sessions
   where user_id = a.user_id
     and token_hash <> private.token_hash(private.request_token());
end $$;

-- Delete your account and every row you own (FKs cascade from profiles).
create or replace function public.app_delete_account(p_password text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  a  private.accounts;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select * into a from private.accounts where user_id = me;
  if not found or a.password_hash <> extensions.crypt(coalesce(p_password, ''), a.password_hash) then
    raise exception 'Wrong password.';
  end if;
  perform set_config('mizan.deleting_user', me::text, true);  -- lets the immutability triggers allow the cascade
  delete from public.profiles where id = me;
end $$;

-- Used by the GitHub keep-alive workflow. Touches the database, reveals nothing.
create or replace function public.ping()
returns boolean language sql stable set search_path = '' as $$
  select true
$$;

-- profiles: you can only ever see your own row
alter table public.profiles enable row level security;
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select using (id = (select public.app_uid()));
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update using (id = (select public.app_uid())) with check (id = (select public.app_uid()));

grant usage on schema public to anon, authenticated;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update (full_name) on public.profiles to anon, authenticated;
