-- =====================================================================
--  Mizan 006 - Excel import + reading gold holdings. Run after 005. Safe to run again.
--
--  import_workbook() saves everything from one uploaded file in ONE
--  transaction: if any row is wrong, nothing is saved.
--  * plan: a new version (only when the file's plan differs; the app decides)
--  * actuals: matched to plan lines by name; upserted per month
--  * unplanned items and gold pieces: added unless an identical one already
--    exists, so uploading the same file twice doesn't create duplicates
-- =====================================================================

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
    if coalesce(r->>'karat', '') not in ('24', '21', '18') then
      raise exception 'Gold row %: karat must be 24, 21 or 18.', coalesce(r->>'row', n::text);
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

create or replace function public.get_gold_holdings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'label', g.label, 'karat', g.karat, 'grams', g.grams::text,
           'purchase_price', g.purchase_price::text, 'purchase_date', g.purchase_date,
           'sold_date', g.sold_date) order by g.purchase_date, g.id), '[]')
    from public.gold_holdings g where g.user_id = public.app_uid()
$$;

revoke all on function public.import_workbook(jsonb, jsonb, jsonb, jsonb, text), public.get_gold_holdings() from public;
grant execute on function public.import_workbook(jsonb, jsonb, jsonb, jsonb, text), public.get_gold_holdings() to anon, authenticated;
