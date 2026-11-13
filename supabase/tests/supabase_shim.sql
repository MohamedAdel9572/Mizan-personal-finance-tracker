-- Only for plain Postgres test databases: creates what Supabase already has.
do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
