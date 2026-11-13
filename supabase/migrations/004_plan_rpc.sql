-- =====================================================================
--  Mizan 004 - Plan RPCs. Run after 003. Safe to run again.
--
--  save_plan_version(jsonb) is the only way to write a plan. It validates
--  everything, writes the version + items + amounts + rates in one
--  transaction, and logs what changed compared with the previous version.
--
--  get_plan_versions() returns every version with money as TEXT, because
--  PostgREST sends numeric as a JSON number and JavaScript would turn it
--  into a float. The TS engine parses the strings exactly.
-- =====================================================================

-- 'YYYY-MM' (or a first-of-month date) -> date; friendly error otherwise
create or replace function private.parse_month(p text, p_field text)
returns date language plpgsql immutable set search_path = '' as $$
declare
  d date;
begin
  if p is null or p !~ '^\d{4}-(0[1-9]|1[0-2])(-01)?$' then
    raise exception '%: "%" is not a valid month. Use YYYY-MM.', p_field, coalesce(p, '');
  end if;
  d := (left(p, 7) || '-01')::date;
  if d < date '2000-01-01' or d > date '2100-12-01' then
    raise exception '%: % is out of range.', p_field, left(p, 7);
  end if;
  return d;
end $$;

create or replace function private.parse_amount(p jsonb, p_field text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare
  t text := case jsonb_typeof(p) when 'string' then p #>> '{}' when 'number' then p::text end;
  n numeric;
begin
  if t is null or t !~ '^-?\d{1,14}(\.\d{1,2})?$' then
    raise exception '%: "%" is not a valid amount.', p_field, coalesce(p #>> '{}', '');
  end if;
  n := t::numeric;
  if n < 0 then
    raise exception '%: amount can''t be negative.', p_field;
  end if;
  return n;
end $$;

create or replace function public.save_plan_version(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me         uuid := public.app_uid();
  prev       public.plan_versions;
  v_id       bigint;
  v_no       int;
  v_start    date;
  v_eff      date;
  v_horizon  int;
  v_opening  numeric;
  it         jsonb;
  am         jsonb;
  rt         jsonb;
  i_id       bigint;
  i_key      uuid;
  i_kind     text;
  i_name     text;
  i_rec      text;
  i_start    date;
  i_end      date;
  i_label    text;
  a_month    date;
  first_rate date;
  n_items    int := 0;
  added      text[];
  removed    text[];
  edited     text[];
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if jsonb_typeof(p_plan) is distinct from 'object' then raise exception 'Invalid plan.'; end if;

  perform pg_advisory_xact_lock(hashtext('plan:' || me::text));

  select * into prev from public.plan_versions
   where user_id = me order by version_no desc limit 1;

  v_start := private.parse_month(p_plan->>'start_month', 'Start month');
  v_horizon := coalesce(nullif(p_plan->>'horizon_months', '')::int, 24);
  if v_horizon < 1 or v_horizon > 240 then
    raise exception 'Horizon must be between 1 and 240 months.';
  end if;
  v_opening := private.parse_amount(coalesce(p_plan->'opening_balance', '"0"'), 'Opening balance');

  if prev.id is null then
    v_eff := v_start;   -- the first version covers the whole plan
  else
    v_eff := private.parse_month(p_plan->>'effective_from', 'Effective from');
    if v_eff < prev.effective_from then
      raise exception 'A new version can''t start before the current one (%).', to_char(prev.effective_from, 'YYYY-MM');
    end if;
  end if;
  if v_eff < v_start then
    raise exception 'Effective month can''t be before the plan start month.';
  end if;

  v_no := coalesce(prev.version_no, 0) + 1;
  insert into public.plan_versions (user_id, version_no, effective_from, start_month, horizon_months,
                                    opening_balance, note)
  values (me, v_no, v_eff, v_start, v_horizon, v_opening, left(coalesce(p_plan->>'note', ''), 500))
  returning id into v_id;

  -- savings rate changes
  if jsonb_typeof(p_plan->'rates') is distinct from 'array' or jsonb_array_length(p_plan->'rates') = 0 then
    raise exception 'Add the savings account interest rate.';
  end if;
  for rt in select * from jsonb_array_elements(p_plan->'rates') loop
    a_month := private.parse_month(rt->>'from', 'Rate month');
    if a_month < v_start then
      raise exception 'Rate change % is before the plan start.', to_char(a_month, 'YYYY-MM');
    end if;
    if coalesce(rt->>'annual_rate_pct', '') !~ '^\d{1,3}(\.\d{1,4})?$'
       or (rt->>'annual_rate_pct')::numeric > 100 then
      raise exception 'Interest rate "%" must be a percentage between 0 and 100.', coalesce(rt->>'annual_rate_pct', '');
    end if;
    begin
      insert into public.plan_rates (version_id, user_id, from_month, annual_rate_pct)
      values (v_id, me, a_month, (rt->>'annual_rate_pct')::numeric);
    exception when unique_violation then
      raise exception 'Two interest rates start in %.', to_char(a_month, 'YYYY-MM');
    end;
  end loop;
  select min(from_month) into first_rate from public.plan_rates where version_id = v_id;
  if first_rate <> v_start then
    raise exception 'The first interest rate must start in the plan start month (%).', to_char(v_start, 'YYYY-MM');
  end if;

  -- items
  if p_plan ? 'items' and jsonb_typeof(p_plan->'items') <> 'array' then
    raise exception 'Invalid plan items.';
  end if;
  for it in select * from jsonb_array_elements(coalesce(p_plan->'items', '[]')) loop
    n_items := n_items + 1;
    if n_items > 300 then raise exception 'A plan can have at most 300 lines.'; end if;

    i_name := trim(coalesce(it->>'name', ''));
    i_label := 'Line ' || n_items || coalesce(' "' || nullif(i_name, '') || '"', '');
    if i_name = '' or length(i_name) > 80 then
      raise exception '%: name is required (max 80 characters).', i_label;
    end if;
    i_kind := it->>'kind';
    if i_kind is null or i_kind not in ('income', 'expense', 'asset') then
      raise exception '%: unknown type "%". Use income, expense or asset.', i_label, coalesce(i_kind, '');
    end if;
    i_rec := coalesce(it->>'recurrence', 'recurring');
    if i_rec not in ('recurring', 'one_off') then
      raise exception '%: unknown recurrence "%".', i_label, i_rec;
    end if;
    if i_kind = 'asset' and i_rec <> 'recurring' then
      raise exception '%: assets must be recurring (value holds until changed).', i_label;
    end if;
    if jsonb_typeof(it->'amounts') is distinct from 'array' or jsonb_array_length(it->'amounts') = 0 then
      raise exception '%: add at least one amount.', i_label;
    end if;

    -- stable identity across versions
    begin
      i_key := coalesce(nullif(it->>'item_key', '')::uuid, gen_random_uuid());
    exception when invalid_text_representation then
      raise exception '%: invalid item key.', i_label;
    end;
    if exists (select 1 from public.plan_items x where x.item_key = i_key and x.user_id <> me) then
      raise exception '%: invalid item key.', i_label;
    end if;
    if exists (select 1 from public.plan_items x where x.item_key = i_key and x.user_id = me and x.kind <> i_kind) then
      raise exception '%: a line can''t change between income, expense and asset. Add a new line instead.', i_label;
    end if;

    if i_rec = 'recurring' then
      i_start := private.parse_month(it->>'start', i_label || ' start');
      i_end := case when nullif(it->>'end', '') is null then null
                    else private.parse_month(it->>'end', i_label || ' end') end;
      if i_end is not null and i_end < i_start then
        raise exception '%: end month is before the start month.', i_label;
      end if;
    else
      select min(private.parse_month(x->>'month', i_label || ' month')),
             max(private.parse_month(x->>'month', i_label || ' month'))
        into i_start, i_end
        from jsonb_array_elements(it->'amounts') x;
    end if;
    if i_start < v_start then
      raise exception '%: starts before the plan start month.', i_label;
    end if;

    begin
      insert into public.plan_items (version_id, user_id, item_key, kind, name, recurrence,
                                     start_month, end_month, sort_order)
      values (v_id, me, i_key, i_kind, i_name, i_rec, i_start, i_end, n_items)
      returning id into i_id;
    exception when unique_violation then
      raise exception '%: the same line appears twice.', i_label;
    end;

    for am in select * from jsonb_array_elements(it->'amounts') loop
      a_month := private.parse_month(am->>'month', i_label || ' month');
      if a_month < i_start or (i_end is not null and a_month > i_end) then
        raise exception '%: amount month % is outside the line''s months.', i_label, to_char(a_month, 'YYYY-MM');
      end if;
      begin
        insert into public.plan_item_amounts (item_id, user_id, month, amount)
        values (i_id, me, a_month, private.parse_amount(am->'amount', i_label));
      exception when unique_violation then
        raise exception '%: two amounts for %.', i_label, to_char(a_month, 'YYYY-MM');
      end;
    end loop;

    if i_rec = 'recurring' and not exists (
         select 1 from public.plan_item_amounts where item_id = i_id and month = i_start) then
      raise exception '%: the first amount must be in the start month (%).', i_label, to_char(i_start, 'YYYY-MM');
    end if;
  end loop;

  -- what changed vs the previous version (for History)
  if prev.id is not null then
    with
      cur as (select i.item_key, i.name, private.item_fingerprint(i.id) fp
                from public.plan_items i where i.version_id = v_id),
      old as (select i.item_key, i.name, private.item_fingerprint(i.id) fp
                from public.plan_items i where i.version_id = prev.id)
    select
      (select array_agg(c.name order by c.name) from cur c where not exists (select 1 from old o where o.item_key = c.item_key)),
      (select array_agg(o.name order by o.name) from old o where not exists (select 1 from cur c where c.item_key = o.item_key)),
      (select array_agg(c.name order by c.name) from cur c join old o using (item_key) where c.fp <> o.fp)
    into added, removed, edited;
  end if;

  insert into public.audit_events (user_id, event_type, entity, entity_id, month, summary, details)
  values (me, 'plan_version', 'plan_versions', v_id::text, v_eff,
          'Saved plan version ' || v_no || ' (effective ' || to_char(v_eff, 'YYYY-MM') || ')'
            || case when prev.id is null then ', ' || n_items || ' lines'
                    else coalesce(', added: ' || array_to_string(added, ', '), '')
                      || coalesce(', removed: ' || array_to_string(removed, ', '), '')
                      || coalesce(', edited: ' || array_to_string(edited, ', '), '') end,
          jsonb_strip_nulls(jsonb_build_object('version_no', v_no, 'previous_version_id', prev.id,
                             'added', added, 'removed', removed, 'edited', edited)));

  return jsonb_build_object('id', v_id, 'version_no', v_no);
end $$;

-- Everything that defines one line, as text, to detect edits between versions
create or replace function private.item_fingerprint(p_item bigint)
returns text language sql stable set search_path = '' as $$
  select concat_ws('|', i.kind, i.name, i.recurrence, i.start_month, i.end_month,
           (select string_agg(a.month || '=' || a.amount, ',' order by a.month)
              from public.plan_item_amounts a where a.item_id = i.id))
    from public.plan_items i where i.id = p_item
$$;

-- All versions, newest first, with money as text
create or replace function public.get_plan_versions()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(v.doc order by v.version_no desc), '[]'::jsonb)
  from (
    select pv.version_no, jsonb_build_object(
      'id', pv.id,
      'version_no', pv.version_no,
      'effective_from', to_char(pv.effective_from, 'YYYY-MM'),
      'start_month', to_char(pv.start_month, 'YYYY-MM'),
      'horizon_months', pv.horizon_months,
      'opening_balance', pv.opening_balance::text,
      'note', pv.note,
      'created_at', pv.created_at,
      'rates', (select coalesce(jsonb_agg(jsonb_build_object(
                  'from', to_char(r.from_month, 'YYYY-MM'),
                  'annual_rate_pct', r.annual_rate_pct::text) order by r.from_month), '[]')
                from public.plan_rates r where r.version_id = pv.id),
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
                  'item_key', i.item_key,
                  'kind', i.kind,
                  'name', i.name,
                  'recurrence', i.recurrence,
                  'start', to_char(i.start_month, 'YYYY-MM'),
                  'end', to_char(i.end_month, 'YYYY-MM'),
                  'amounts', (select jsonb_agg(jsonb_build_object(
                                'month', to_char(a.month, 'YYYY-MM'), 'amount', a.amount::text) order by a.month)
                              from public.plan_item_amounts a where a.item_id = i.id))
                  order by i.sort_order), '[]')
                from public.plan_items i where i.version_id = pv.id)
    ) as doc
    from public.plan_versions pv
    where pv.user_id = public.app_uid()
  ) v
$$;

revoke all on function public.save_plan_version(jsonb), public.get_plan_versions() from public;
grant execute on function public.save_plan_version(jsonb), public.get_plan_versions() to anon, authenticated;
