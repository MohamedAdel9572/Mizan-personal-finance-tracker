-- =====================================================================
--  Mizan 009 - Add, edit and delete gold pieces. Run after 008. Safe to run again.
--  Every change is checked here (karat 24/21/18, grams > 0, price >= 0,
--  no future dates) and written to History by the existing triggers.
-- =====================================================================

create or replace function private.gold_values(p jsonb, out label text, out karat smallint, out grams numeric,
                                               out price numeric, out bought date)
language plpgsql stable set search_path = '' as $$
begin
  label := trim(coalesce(p->>'label', ''));
  if label = '' or length(label) > 80 then raise exception 'Name is required (max 80 characters).'; end if;
  if coalesce(p->>'karat', '') not in ('24', '21', '18') then raise exception 'Karat must be 24, 21 or 18.'; end if;
  karat := (p->>'karat')::smallint;
  if coalesce(p->>'grams', '') !~ '^\d{1,7}(\.\d{1,3})?$' or (p->>'grams')::numeric = 0 then
    raise exception 'Grams must be more than 0 (max 3 decimals).';
  end if;
  grams := (p->>'grams')::numeric;
  price := private.parse_amount(to_jsonb(replace(coalesce(p->>'price', ''), ',', '')), 'Purchase price');
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Purchase date is not valid.'; end if;
  bought := (p->>'date')::date;
end $$;

create or replace function public.add_gold_holding(p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  v  record;
  id bigint;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select * into v from private.gold_values(p);
  insert into public.gold_holdings (user_id, label, karat, grams, purchase_price, purchase_date)
  values (me, v.label, v.karat, v.grams, v.price, v.bought)
  returning gold_holdings.id into id;
  return id;
end $$;

create or replace function public.update_gold_holding(p_id bigint, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  v  record;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select * into v from private.gold_values(p);
  update public.gold_holdings
     set label = v.label, karat = v.karat, grams = v.grams, purchase_price = v.price, purchase_date = v.bought
   where id = p_id and user_id = me
     and (label, karat, grams, purchase_price, purchase_date) is distinct from (v.label, v.karat, v.grams, v.price, v.bought);
  if not found and not exists (select 1 from public.gold_holdings where id = p_id and user_id = me) then
    raise exception 'Gold piece not found.';
  end if;
end $$;

create or replace function public.delete_gold_holding(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.app_uid() is null then raise exception 'Please sign in first.'; end if;
  delete from public.gold_holdings where id = p_id and user_id = public.app_uid();
  if not found then raise exception 'Gold piece not found.'; end if;
end $$;

-- History text for an edit names what changed, e.g. "Edited gold "BTC 2.5g #1": karat 21 -> 24"
create or replace function private.gold_edit_summary()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  parts text[] := '{}';
begin
  if private.deleting_account() then return null; end if;
  if new.karat is distinct from old.karat then parts := parts || ('karat ' || old.karat || ' -> ' || new.karat); end if;
  if new.grams is distinct from old.grams then parts := parts || ('grams ' || old.grams || ' -> ' || new.grams); end if;
  if new.purchase_price is distinct from old.purchase_price then parts := parts || ('paid ' || old.purchase_price || ' -> ' || new.purchase_price); end if;
  if new.purchase_date is distinct from old.purchase_date then parts := parts || ('date ' || old.purchase_date || ' -> ' || new.purchase_date); end if;
  if new.label is distinct from old.label then parts := parts || ('name "' || old.label || '" -> "' || new.label || '"'); end if;
  update public.audit_events
     set summary = 'Edited gold "' || new.label || '": ' || array_to_string(parts, ', ')
   where id = (select max(id) from public.audit_events
                where user_id = new.user_id and entity = 'gold_holdings' and event_type = 'update' and entity_id = new.id::text);
  return null;
end $$;
drop trigger if exists gold_holdings_zz_edit_summary on public.gold_holdings;
-- "zz" so it runs after the generic audit trigger (triggers fire in name order)
create trigger gold_holdings_zz_edit_summary after update on public.gold_holdings
  for each row execute function private.gold_edit_summary();

revoke all on function public.add_gold_holding(jsonb), public.update_gold_holding(bigint, jsonb), public.delete_gold_holding(bigint) from public;
grant execute on function public.add_gold_holding(jsonb), public.update_gold_holding(bigint, jsonb), public.delete_gold_holding(bigint) to anon, authenticated;
