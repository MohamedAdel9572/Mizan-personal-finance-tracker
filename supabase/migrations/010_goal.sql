-- =====================================================================
--  Mizan 010 - Your goal (target amount + date, optional monthly savings
--  target) for the Dashboard. Run after 009. Safe to run again.
-- =====================================================================

create or replace function public.get_goal()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('target_amount', g.target_amount::text, 'target_month', to_char(g.target_month, 'YYYY-MM'),
                            'monthly_savings_target', g.monthly_savings_target::text)
    from public.goals g where g.user_id = public.app_uid()
$$;

create or replace function public.set_goal(p_target_amount text, p_target_month text, p_monthly_savings_target text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me  uuid := public.app_uid();
  amt numeric;
  mon date;
  sav numeric;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  amt := private.parse_amount(to_jsonb(replace(coalesce(p_target_amount, ''), ',', '')), 'Target amount');
  if amt = 0 then raise exception 'Target amount must be more than 0.'; end if;
  mon := private.parse_month(p_target_month, 'Target month');
  if nullif(trim(coalesce(p_monthly_savings_target, '')), '') is not null then
    sav := private.parse_amount(to_jsonb(replace(trim(p_monthly_savings_target), ',', '')), 'Monthly savings target');
  end if;
  insert into public.goals (user_id, target_amount, target_month, monthly_savings_target)
  values (me, amt, mon, sav)
  on conflict (user_id) do update
    set target_amount = excluded.target_amount, target_month = excluded.target_month,
        monthly_savings_target = excluded.monthly_savings_target
    where (public.goals.target_amount, public.goals.target_month, public.goals.monthly_savings_target)
          is distinct from (excluded.target_amount, excluded.target_month, excluded.monthly_savings_target);
end $$;

revoke all on function public.get_goal(), public.set_goal(text, text, text) from public;
grant execute on function public.get_goal(), public.set_goal(text, text, text) to anon, authenticated;
