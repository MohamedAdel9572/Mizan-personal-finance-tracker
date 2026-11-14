-- =====================================================================
--  Mizan 014 - Clear one logged month (Plan > Actual). Run after 013.
--  Removes that month's logged amounts, unplanned items and check-in
--  (bank balance, note, saved gold value). The plan is not touched.
--  History gets one line ("Cleared Nov 2026 ...") instead of one per row.
-- =====================================================================

create or replace function public.clear_month(p_month text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := public.app_uid();
  m      date;
  n_line integer;
  n_unp  integer;
  n_chk  integer;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  m := private.parse_month(p_month, 'Month');

  -- one History line for the whole month (same switch the plan delete uses)
  perform set_config('mizan.deleting_plan', me::text, true);
  delete from public.actual_entries   where user_id = me and month = m;
  get diagnostics n_line = row_count;
  delete from public.unplanned_items  where user_id = me and month = m;
  get diagnostics n_unp = row_count;
  delete from public.monthly_checkins where user_id = me and month = m;
  get diagnostics n_chk = row_count;
  perform set_config('mizan.deleting_plan', '', true);

  if n_line + n_unp + n_chk = 0 then
    raise exception '% is not logged, so there is nothing to clear.', to_char(m, 'Mon YYYY');
  end if;

  insert into public.audit_events (user_id, event_type, entity, month, summary, details)
  values (me, 'delete', 'monthly_checkins', m,
          'Cleared ' || to_char(m, 'Mon YYYY') || ': ' || n_line || ' logged line' || case when n_line = 1 then '' else 's' end
            || case when n_unp > 0 then ', ' || n_unp || ' unplanned item' || case when n_unp = 1 then '' else 's' end else '' end,
          jsonb_build_object('lines', n_line, 'unplanned', n_unp, 'checkin', n_chk));

  return jsonb_build_object('lines', n_line, 'unplanned', n_unp, 'checkin', n_chk);
end $$;

revoke all on function public.clear_month(text) from public;
grant execute on function public.clear_month(text) to anon, authenticated;
