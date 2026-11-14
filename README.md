# Mizan - Personal Financial Plan & Goal Tracker

Replaces the Excel budget sheet: a versioned plan, monthly check-ins, plan vs actual,
goal tracking and gold holdings. Static Vite + TypeScript PWA on Vercel, Supabase
(Postgres) backend, own login (no Supabase Auth), same pattern as `skn-clinic`.

## Status

| Step | What | State |
|---|---|---|
| 1 | Schema, auth, RLS + SQL tests | done |
| 2 | Calculation engine + unit tests | done |
| 3 | Sign in/up, settings, Plan (grid + editor), Log actuals, Plan vs actual | done |
| 4 | Dashboard, statistics | |
| 5 | Excel template download + import (template or your own month-grid sheet) | done early |
| 5 | Gold screen: your price per gram, value, profit/loss; net worth uses it | done |
| 5 | Automatic gold price (Edge Function + API), Excel export | next |
| 6 | History timeline + months | done early |
| 6 | Polish, responsive checks | |

## Project layout

```
supabase/migrations/   numbered SQL files, run in order (001, 002, ...)
supabase/tests/        SQL tests (auth, lockout, RLS isolation, validation, history)
src/engine/            pure TS calculation engine (no DOM, no network, no floats)
src/engine/__tests__/  Vitest unit tests
src/data/seed.ts       the Excel sheet numbers, used to verify the engine
build-config.sh        maps SUPABASE_URL / SUPABASE_KEY to Vite env at build time
.github/workflows/     keep-alive ping so the free Supabase project never pauses
```

## Setup

### 1. Supabase

1. Create a project at supabase.com (free tier is fine).
2. SQL Editor: run every file in `supabase/migrations/` in number order. Each file is safe to run again.
3. Optional but recommended, so strangers can't sign up on your project:
   ```sql
   insert into private.settings (key, value) values ('signup_code', 'pick-a-secret')
   on conflict (key) do update set value = excluded.value;
   ```
4. Project Settings → API: copy the Project URL and the anon / publishable key.

### 2. Local development

```bash
npm install
cp .env.example .env.local      # paste the URL and anon key
npm run dev
npm test                        # engine unit tests (Vitest)
npm run test:sql                # SQL tests on a throwaway local Postgres (needs initdb/pg_ctl)
```

`npm run test:sql` with `DATABASE_URL=...` runs against an empty database you give it
(for example `supabase start`). Never point it at your real project: the tests create
and delete users.

### 3. Vercel

1. Import the GitHub repo in Vercel. `vercel.json` already sets the build command and the `dist` output.
2. Settings → Environment Variables: `SUPABASE_URL`, `SUPABASE_KEY` (same names as skn-clinic).
3. Deploy. The build fails on purpose if those variables are missing.

### 4. Keep-alive

GitHub repo → Settings → Secrets and variables → Actions → **Variables**: add `SUPABASE_URL`
and `SUPABASE_KEY`. The workflow calls `rpc/ping` every 3 days.

### 5. Gold price API key

Comes with step 5. It will be stored as a Supabase Edge Function secret, never in the frontend.

## Design decisions

**Auth (copied from skn-clinic, with four changes).** Header is `x-mizan-session`.
Changes: the failed-login counter restarts after a lock expires (in skn-clinic the first
wrong password after a lock re-locked immediately), minimum password 8, changing the
password signs out every other device, and an optional sign-up code.

**RLS everywhere.** Every user table has `user_id = (select app_uid())` policies.
The `(select ...)` wrapper makes Postgres evaluate it once per query instead of per row.
Child tables repeat `user_id` and use a composite foreign key `(parent_id, user_id)`, so a
row of user A can never hang under a parent of user B, and no policy needs a join.

**No supabase-js.** The app only calls Postgres functions through PostgREST with its own
session header; supabase-js's auth layer would go unused. `src/lib/api.ts` is a small typed
`fetch` wrapper with timeouts and friendly error messages, and the app has no runtime
dependencies at all.

**Reads and actuals go through RPCs** (`get_plan_versions`, `get_actuals`, `save_checkin`,
`add_unplanned`, `delete_unplanned`) so money always arrives as exact text and a whole month's
check-in is saved in one transaction.

**Excel import without a library.** An .xlsx file is a zip of XML. `src/lib/xlsx.ts` reads the
zip with the browser's own `DecompressionStream` and the XML with a few regular expressions, so
numbers arrive as their exact text and there is no extra dependency. `src/lib/importer.ts` reads
either the Mizan template (Settings, Lines, Actuals, Unplanned, Gold) or a month-grid sheet like
the original Excel (Income / Installments / Assets sections, months across). Every problem names
its sheet and row, nothing is saved until you confirm, and `import_workbook()` saves the whole
file in one transaction. Uploading the same file twice adds no duplicates and creates no new
plan version.

**Writes.** Simple tables (actuals, unplanned items, check-ins, gold holdings, goal) are
written directly by the browser; RLS, CHECK constraints and triggers validate them.
Plans are written only through `save_plan_version()`. History (`audit_events`) is written
only by triggers and RPCs.

**Plan versions are immutable snapshots.** Saving copies every line into a new version.
Each line has a stable `item_key` across versions, and actuals point at that key, so
renaming or changing a line in a new version keeps its history. A trigger blocks
UPDATE/DELETE on saved versions, even from the SQL editor (only account deletion may
remove them). Month *m* is compared with the version whose `effective_from` is the latest
one on or before *m*. A new version can't take effect before the current one.

**Money is exact.** `numeric(16,2)` in SQL. RPCs return money as text because PostgREST
sends numeric as a JSON number and JavaScript would make it a float. The engine uses a
small BigInt decimal (10 internal places, rounds to 2 only for display).

**Calculation rules** follow your sheet literally:
first month has no interest; interest is `previous balance x rate / 12`. One deliberate
difference from Excel: no interest while the balance is zero or negative (a savings account
doesn't charge its savings rate on an overdraft). Your seed plan never goes negative, so the
numbers still match the sheet.

**Actuals.** A month counts once it has a check-in. Inside a checked-in month, a planned
line with no entry counts as 0 (the Log screen will pre-fill planned amounts). Months
without a check-in between the start and the last check-in use planned values and are
marked `assumed`. A real bank balance entered in the check-in overrides the computed one.

**"On plan"** is judged on Net (cash flow), not net worth, so a gold price drop doesn't
count as missing your plan. Net worth gaps are still shown.

**Projected finish date** starts from your last real balance and walks the plan forward,
adding the average Net gap of your last 6 checked-in months to every future month. That
keeps planned raises and bonuses in the projection but carries forward how far off plan
you've actually been. Gold is kept at its last value plus planned changes (no price forecast).
