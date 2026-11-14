-- =====================================================================
--  add / update / delete gold pieces
-- =====================================================================
\ir helpers.sql
set role anon;
select test.act_as(null);
select public.app_signup('Laila L', '01500000001', 'password-l1') as tok_l \gset
select public.app_signup('Mona M', '01500000002', 'password-m1') as tok_m \gset
select test.throws($$select public.add_gold_holding('{}')$$, '%sign in%', 'add needs a session');

select test.act_as(:'tok_l');
select public.add_gold_holding('{"label": " BTC 2.5g ", "karat": 21, "grams": "2.5", "price": "12,510", "date": "2025-03-21"}') as gid \gset
select test.eq(public.get_gold_holdings()#>>'{0,label}', 'BTC 2.5g', 'piece added, name trimmed');
select test.throws($$select public.add_gold_holding('{"label": "x", "karat": 20, "grams": "1", "price": "1", "date": "2025-01-01"}')$$, '%24, 22, 21, 18, 14 or 12%', 'bad karat rejected');
select public.add_gold_holding('{"label": "Old chain", "karat": 14, "grams": "3", "price": "4000", "date": "2025-01-01"}');
select test.eq((select count(*) from public.gold_holdings where karat = 14)::text, '1', '14K accepted');
select public.delete_gold_holding((select id from public.gold_holdings where karat = 14));
select test.throws($$select public.add_gold_holding('{"label": "x", "karat": 24, "grams": "0", "price": "1", "date": "2025-01-01"}')$$, '%more than 0%', 'zero grams rejected');
select test.throws($$select public.add_gold_holding('{"label": "x", "karat": 24, "grams": "1", "price": "-1", "date": "2025-01-01"}')$$, '%negative%', 'negative price rejected');
select test.throws($$select public.add_gold_holding('{"label": "", "karat": 24, "grams": "1", "price": "1", "date": "2025-01-01"}')$$, '%Name is required%', 'empty name rejected');
select test.throws($$select public.add_gold_holding('{"label": "x", "karat": 24, "grams": "1", "price": "1", "date": "2099-01-01"}')$$, '%future%', 'future date rejected');

select public.update_gold_holding(:gid, '{"label": "BTC 2.5g", "karat": 24, "grams": "2.5", "price": "12510", "date": "2025-03-21"}');
select test.eq(public.get_gold_holdings()#>>'{0,karat}', '24', 'karat changed to 24');
select test.eq((select summary from public.audit_events where entity = 'gold_holdings' order by id desc limit 1),
               'Edited gold "BTC 2.5g": karat 21 -> 24', 'History says what changed');
select public.update_gold_holding(:gid, '{"label": "BTC 2.5g", "karat": 24, "grams": "2.5", "price": "12510", "date": "2025-03-21"}');
select test.eq((select count(*) from public.audit_events where entity = 'gold_holdings' and event_type = 'update')::text, '1', 'saving without changes adds no History entry');

select test.act_as(:'tok_m');
select test.throws(format('select public.update_gold_holding(%s, %L)', :gid, '{"label": "x", "karat": 18, "grams": "1", "price": "1", "date": "2025-01-01"}'),
                   '%not found%', 'M cannot edit L''s piece');
select test.throws(format('select public.delete_gold_holding(%s)', :gid), '%not found%', 'M cannot delete L''s piece');

select test.act_as(:'tok_l');
select public.delete_gold_holding(:gid);
select test.eq(public.get_gold_holdings()::text, '[]', 'owner deletes the piece');

select public.app_delete_account('password-l1');
select test.act_as(:'tok_m');
select public.app_delete_account('password-m1');
reset role;
drop schema test cascade;
