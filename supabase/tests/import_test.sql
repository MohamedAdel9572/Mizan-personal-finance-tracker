-- =====================================================================
--  import_workbook + get_gold_holdings
-- =====================================================================
\ir helpers.sql
set role anon;
select test.act_as(null);
select public.app_signup('Fady F', '01200000001', 'password-f1') as tok_f \gset
select public.app_signup('Gina G', '01200000002', 'password-g1') as tok_g \gset

select test.throws($$select public.import_workbook(null, '[]', '[]', '[]')$$, '%sign in%', 'import needs a session');

select test.act_as(:'tok_f');
select test.throws($$select public.import_workbook(null, '[{"row": 2, "month": "2026-07", "line": "Salary", "amount": "1"}]', '[]', '[]')$$,
                   '%Create your plan%', 'actuals without a plan rejected');

select test.eq(public.import_workbook(test.base_plan(),
  '[{"row": 2, "month": "2026-07", "line": "salary", "amount": "27000"}, {"row": 3, "month": "2026-07", "line": "Car", "amount": "5300"}]',
  '[{"row": 2, "month": "2026-07", "kind": "expense", "name": "Car repair", "amount": "1800"}]',
  '[{"row": 11, "label": "BTC 2.5g", "karat": 21, "grams": "2.5", "price": "12510", "date": "2025-03-21"},
    {"row": 12, "label": "BTC 5g", "karat": 21, "grams": "5", "price": "26920", "date": "2025-06-26"}]',
  'Book1.xlsx')::text,
  '{"gold": 2, "actuals": 2, "unplanned": 1, "version_no": 1, "gold_skipped": 0, "unplanned_skipped": 0}', 'import saves plan, actuals, unplanned and gold');
select test.eq((select amount::text from public.actual_entries where month = '2026-07-01' and item_key = '11111111-1111-4111-8111-111111111111'),
               '27000.00', 'actual matched to the line by name (case-insensitive)');
select test.eq((select count(*) from public.monthly_checkins where month = '2026-07-01')::text, '1', 'imported month is checked in');
select test.eq(jsonb_array_length(public.get_gold_holdings())::text, '2', 'gold holdings readable');
select test.eq(public.get_gold_holdings()#>>'{0,grams}', '2.500', 'grams returned as exact text');

select test.eq(public.import_workbook(null, '[]',
  '[{"row": 2, "month": "2026-07", "kind": "expense", "name": "car repair", "amount": "1800"}]',
  '[{"row": 11, "label": "BTC 2.5g", "karat": 21, "grams": "2.5", "price": "12510", "date": "2025-03-21"}]', '')->>'gold_skipped',
  '1', 'same file twice: no duplicate gold');
select test.eq((select count(*) from public.unplanned_items)::text, '1', 'same file twice: no duplicate unplanned item');
select test.eq((select summary from public.audit_events where event_type = 'upload' order by id desc limit 1),
               'Imported Excel file: plan unchanged, 0 actuals, 0 unplanned, 0 gold pieces', 'upload logged in History');

select test.throws($$select public.import_workbook(null, '[]', '[]',
  '[{"row": 11, "label": "x", "karat": 21, "grams": "1", "price": "1", "date": "2025-01-01"},
    {"row": 12, "label": "y", "karat": 20, "grams": "1", "price": "1", "date": "2025-01-01"}]')$$,
  '%Gold row 12: karat%', 'bad karat names the row');
select test.eq((select count(*) from public.gold_holdings where label = 'x')::text, '0', 'a bad row saves nothing from the file (atomic)');
select test.throws($$select public.import_workbook(null, '[{"row": 5, "month": "2026-07", "line": "Nope", "amount": "1"}]', '[]', '[]')$$,
                   '%Actuals row 5: "Nope"%', 'unknown line names the row');
select test.throws($$select public.import_workbook(null, '[]', '[]', '[{"row": 11, "label": "z", "karat": 21, "grams": "1", "price": "1", "date": "2099-01-01"}]')$$,
                   '%future%', 'future gold purchase rejected');

select test.act_as(:'tok_g');
select test.eq(public.get_gold_holdings()::text, '[]', 'G cannot see F''s gold');

-- clean up so other test files can reuse the fixed line keys
select public.app_delete_account('password-g1');
select test.act_as(:'tok_f');
select public.app_delete_account('password-f1');
reset role;
drop schema test cascade;
