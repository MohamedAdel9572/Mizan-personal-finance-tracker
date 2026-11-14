-- =====================================================================
--  Mizan 011 - All gold karats: 24, 22, 21, 18, 14, 12. Run after 010. Safe to run again.
--  Widens the table checks and the functions that validate a karat.
-- =====================================================================

alter table public.gold_holdings drop constraint if exists gold_holdings_karat_check;
alter table public.gold_holdings add constraint gold_holdings_karat_check check (karat in (24, 22, 21, 18, 14, 12));
alter table public.gold_prices drop constraint if exists gold_prices_karat_check;
alter table public.gold_prices add constraint gold_prices_karat_check check (karat in (24, 22, 21, 18, 14, 12));
alter table public.gold_price_overrides drop constraint if exists gold_price_overrides_karat_check;
alter table public.gold_price_overrides add constraint gold_price_overrides_karat_check check (karat in (24, 22, 21, 18, 14, 12));

create or replace function public.import_workbook(p_plan jsonb, p_actuals jsonb, p_unplanned jsonb,
                                                  p_gold jsonb, p_file_name text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me        uuid := public.app_uid();
  saved     jsonb;
  latest_id bigint;
  r         jsonb;
  n         int := 0;
  k         uuid;
  m         date;
  amt       numeric;
  v_grams   numeric;
  ins       int;
  n_act     int := 0;
  n_unp     int := 0;
  n_unp_dup int := 0;
  n_gold    int := 0;
  n_gold_dup int := 0;
  months    date[] := '{}';
begin
  if me is null then raise exception 'Please sign in first.'; end if;

  if p_plan is not null and jsonb_typeof(p_plan) = 'object' then
    saved := public.save_plan_version(p_plan);
  end if;

  -- actuals: line name -> stable key, from the newest plan version
  if jsonb_array_length(coalesce(p_actuals, '[]')) > 0 then
    select id into latest_id from public.plan_versions where user_id = me order by version_no desc limit 1;
    if latest_id is null then raise exception 'Create your plan before importing actuals.'; end if;
    for r in select * from jsonb_array_elements(p_actuals) loop
      n := n + 1;
      select i.item_key into k from public.plan_items i
       where i.version_id = latest_id and lower(i.name) = lower(trim(r->>'line')) and i.kind <> 'asset';
      if k is null then
        raise exception 'Actuals row %: "%" is not an income or expense line in your plan.', coalesce(r->>'row', n::text), r->>'line';
      end if;
      m := private.parse_month(r->>'month', 'Actuals row ' || coalesce(r->>'row', n::text));
      amt := private.parse_amount(r->'amount', 'Actuals row ' || coalesce(r->>'row', n::text));
      insert into public.actual_entries (user_id, month, item_key, amount, note)
      values (me, m, k, amt, left(coalesce(r->>'note', ''), 500))
      on conflict (user_id, month, item_key) do update set amount = excluded.amount, note = excluded.note
        where public.actual_entries.amount is distinct from excluded.amount
           or public.actual_entries.note is distinct from excluded.note;
      n_act := n_act + 1;
      if not m = any(months) then months := months || m; end if;
    end loop;
    insert into public.monthly_checkins (user_id, month)
    select me, x from unnest(months) x
    on conflict (user_id, month) do nothing;
  end if;

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p_unplanned, '[]')) loop
    n := n + 1;
    m := private.parse_month(r->>'month', 'Unplanned row ' || coalesce(r->>'row', n::text));
    amt := private.parse_amount(r->'amount', 'Unplanned row ' || coalesce(r->>'row', n::text));
    if r->>'kind' not in ('income', 'expense') then
      raise exception 'Unplanned row %: type must be income or expense.', coalesce(r->>'row', n::text);
    end if;
    insert into public.unplanned_items (user_id, month, kind, name, amount, note)
    select me, m, r->>'kind', trim(r->>'name'), amt, left(coalesce(r->>'note', ''), 500)
     where not exists (select 1 from public.unplanned_items u
                        where u.user_id = me and u.month = m and u.kind = r->>'kind'
                          and lower(u.name) = lower(trim(r->>'name')) and u.amount = amt);
    get diagnostics ins = row_count;
    n_unp := n_unp + ins;
    n_unp_dup := n_unp_dup + (1 - ins);
  end loop;

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p_gold, '[]')) loop
    n := n + 1;
    if coalesce(r->>'karat', '') not in ('24', '22', '21', '18', '14', '12') then
      raise exception 'Gold row %: karat must be 24, 22, 21, 18, 14 or 12.', coalesce(r->>'row', n::text);
    end if;
    if coalesce(r->>'grams', '') !~ '^\d{1,7}(\.\d{1,3})?$' or (r->>'grams')::numeric = 0 then
      raise exception 'Gold row %: grams must be more than 0 (max 3 decimals).', coalesce(r->>'row', n::text);
    end if;
    v_grams := (r->>'grams')::numeric;
    amt := private.parse_amount(r->'price', 'Gold row ' || coalesce(r->>'row', n::text));
    if coalesce(r->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Gold row %: purchase date is not valid.', coalesce(r->>'row', n::text);
    end if;
    insert into public.gold_holdings (user_id, label, karat, grams, purchase_price, purchase_date)
    select me, trim(r->>'label'), (r->>'karat')::smallint, v_grams, amt, (r->>'date')::date
     where not exists (select 1 from public.gold_holdings g
                        where g.user_id = me and lower(g.label) = lower(trim(r->>'label'))
                          and g.karat = (r->>'karat')::smallint and g.grams = v_grams
                          and g.purchase_price = amt and g.purchase_date = (r->>'date')::date);
    get diagnostics ins = row_count;
    n_gold := n_gold + ins;
    n_gold_dup := n_gold_dup + (1 - ins);
  end loop;

  insert into public.audit_events (user_id, event_type, entity, summary, details)
  values (me, 'upload', 'import',
          'Imported ' || coalesce(nullif(trim(p_file_name), ''), 'Excel file')
            || coalesce(': plan version ' || (saved->>'version_no'), ': plan unchanged')
            || ', ' || n_act || ' actuals, ' || n_unp || ' unplanned, ' || n_gold || ' gold pieces',
          jsonb_build_object('file', left(coalesce(p_file_name, ''), 200), 'version_no', saved->'version_no',
                             'actuals', n_act, 'unplanned', n_unp, 'unplanned_skipped', n_unp_dup,
                             'gold', n_gold, 'gold_skipped', n_gold_dup));

  return jsonb_build_object('version_no', saved->'version_no', 'actuals', n_act,
                            'unplanned', n_unp, 'unplanned_skipped', n_unp_dup,
                            'gold', n_gold, 'gold_skipped', n_gold_dup);
end $$;

create or replace function public.set_gold_price(p_karat int, p_price text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me  uuid := public.app_uid();
  amt numeric;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if p_karat is null or p_karat not in (24, 22, 21, 18, 14, 12) then raise exception 'Karat must be 24, 22, 21, 18, 14 or 12.'; end if;
  if nullif(trim(coalesce(p_price, '')), '') is null then
    insert into public.gold_price_overrides (user_id, karat, price_per_gram_egp, cleared) values (me, p_karat, null, true);
    return;
  end if;
  amt := private.parse_amount(to_jsonb(replace(replace(trim(p_price), ',', ''), ' ', '')), 'Price per gram');
  if amt = 0 then raise exception 'Price per gram must be more than 0.'; end if;
  insert into public.gold_price_overrides (user_id, karat, price_per_gram_egp) values (me, p_karat, amt);
end $$;

create or replace function public.get_gold_prices()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'karat', k.karat,
           'my_price', o.price_per_gram_egp::text, 'my_price_at', o.set_at,
           'fetched_price', p.price_per_gram_egp::text, 'fetched_at', p.fetched_at, 'source', p.source)
           order by k.karat desc), '[]')
    from (values (24), (22), (21), (18), (14), (12)) k(karat)
    left join lateral (select x.price_per_gram_egp, x.set_at from public.gold_price_overrides x
                        where x.user_id = public.app_uid() and x.karat = k.karat
                        order by x.set_at desc, x.id desc limit 1) o on true
    left join lateral (select y.price_per_gram_egp, y.fetched_at, y.source from public.gold_prices y
                        where y.karat = k.karat order by y.fetched_at desc limit 1) p on true
   where public.app_uid() is not null
$$;

create or replace function private.gold_values(p jsonb, out label text, out karat smallint, out grams numeric,
                                               out price numeric, out bought date)
language plpgsql stable set search_path = '' as $$
begin
  label := trim(coalesce(p->>'label', ''));
  if label = '' or length(label) > 80 then raise exception 'Name is required (max 80 characters).'; end if;
  if coalesce(p->>'karat', '') not in ('24', '22', '21', '18', '14', '12') then raise exception 'Karat must be 24, 22, 21, 18, 14 or 12.'; end if;
  karat := (p->>'karat')::smallint;
  if coalesce(p->>'grams', '') !~ '^\d{1,7}(\.\d{1,3})?$' or (p->>'grams')::numeric = 0 then
    raise exception 'Grams must be more than 0 (max 3 decimals).';
  end if;
  grams := (p->>'grams')::numeric;
  price := private.parse_amount(to_jsonb(replace(coalesce(p->>'price', ''), ',', '')), 'Purchase price');
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Purchase date is not valid.'; end if;
  bought := (p->>'date')::date;
end $$;
