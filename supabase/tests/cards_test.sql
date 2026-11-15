-- =====================================================================
--  016: cards and their history
-- =====================================================================
\ir helpers.sql
set role anon;
select test.act_as(null);
select test.throws($$select public.save_card(null, '{"name":"X","kind":"debit"}')$$, '%sign in%', 'cards need a session');
select public.app_signup('Karim K', '01577700001', 'password-k1') as tok_k \gset
select public.app_signup('Laila L', '01577700002', 'password-l1') as tok_l \gset
select test.act_as(:'tok_k');

select public.save_card(null, '{"name":"CIB Visa","bank":"CIB","kind":"credit","last4":"4417","color":"indigo","credit_limit":"50,000","opening_balance":"2000","due_day":"25"}') as cc \gset
select public.save_card(null, '{"name":"Payroll","kind":"debit","opening_balance":"10000"}') as dc \gset
select test.throws($$select public.save_card(null, '{"name":"Bad","kind":"credit","credit_limit":"0"}')$$, '%more than 0%', 'credit card needs a limit');
select test.throws($$select public.save_card(null, '{"name":"Bad","kind":"debit","last4":"12a4"}')$$, '%4 numbers%', 'last 4 digits checked');

select public.save_card_txn(null, jsonb_build_object('card_id', :'cc', 'kind', 'spend', 'amount', '1,250.50', 'date', '2026-11-01', 'note', 'Carrefour'));
select public.save_card_txn(null, jsonb_build_object('card_id', :'cc', 'kind', 'payment', 'amount', '1000', 'date', '2026-11-05'));
select public.save_card_txn(null, jsonb_build_object('card_id', :'dc', 'kind', 'spend', 'amount', '300', 'date', '2026-11-02')) as dt \gset
select test.throws(format($$select public.save_card_txn(null, '{"card_id":%s,"kind":"spend","amount":"5","date":"2999-01-01"}')$$, :'cc'), '%future%', 'no future dates');

select test.eq(jsonb_array_length(public.get_cards()->'cards')::text, '2', 'two cards');
select test.eq(jsonb_array_length(public.get_cards()->'txns')::text, '3', 'three entries');
select test.eq(public.get_cards()#>>'{cards,0,credit_limit}', '50000.00', 'limit stored without commas');
select test.eq((select summary from public.audit_events where entity = 'card_txns' order by id limit 1),
               'Spent 1,250.50 on "CIB Visa" (Carrefour)', 'spend written to History');

select public.save_card(:'cc', '{"name":"CIB Visa","bank":"CIB","kind":"credit","last4":"4417","color":"indigo","credit_limit":"60000","opening_balance":"2000","due_day":"25"}');
select test.eq((select summary from public.audit_events where entity = 'cards' order by id desc limit 1),
               'Changed limit of "CIB Visa": 50,000 -> 60,000', 'limit change written to History');
select test.throws(format($$select public.save_card(%s, '{"name":"CIB Visa","kind":"debit"}')$$, :'cc'), '%can''t change between%', 'kind is fixed');

select test.act_as(:'tok_l');
select test.eq(jsonb_array_length(public.get_cards()->'cards')::text, '0', 'L sees none of K''s cards');
select test.throws(format('select public.delete_card_txn(%s)', :'dt'), '%not found%', 'L cannot delete K''s entry');
select test.throws(format($$select public.save_card_txn(null, '{"card_id":%s,"kind":"spend","amount":"5","date":"2026-11-01"}')$$, :'cc'), '%not found%', 'L cannot add to K''s card');

select test.act_as(:'tok_k');
select public.delete_card_txn(:'dt');
select public.delete_card(:'cc');
select test.eq(jsonb_array_length(public.get_cards()->'txns')::text, '0', 'deleting a card deletes its history');
