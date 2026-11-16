// Investments: where your savings sit. Log each investment's profit or loss per month
// (as an amount, or from that month's rate); the total is your plan's actual Interest.
import { Dec } from "../engine/decimal.ts";
import { addMonths, currentMonth, isMonth, type Month } from "../engine/month.ts";
import { ApiError } from "../lib/api.ts";
import { busy, emptyState, esc, formError, formValues, openDialog, toast } from "../lib/dom.ts";
import { money, monthLabel, signed } from "../lib/format.ts";
import { ledger, profitFromRate, type InvestAccount, type LedgerRow, type RateUnit } from "../lib/invest.ts";
import { compact, lineChart } from "./charts.ts";
import type { Ctx } from "./context.ts";

const AMOUNT_RE = /^\d{1,14}(\.\d{1,2})?$/;
const SIGNED_RE = /^-?\d{1,14}(\.\d{1,2})?$/;
const RATE_RE = /^\d{1,4}(\.\d{1,4})?$/;
const UNIT_LABEL: Record<RateUnit, string> = { yearly: "% a year", monthly: "% a month", daily: "% a day" };
const clean = (v: string | undefined) => (v ?? "").replace(/[,\s]/g, "");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const n2 = (d: Dec) => money(d, d.round(0).eq(d) ? 0 : 2);

const HEAD = (actions: string) => `<div class="page-head"><div><h1>Investments &amp; savings</h1>
  <p class="muted small">Where your savings sit. Together at the plan start they're your plan's opening savings, and their monthly profit or loss is its real Interest.</p></div>
  <div class="head-actions">${actions}</div></div>`;

export function renderInvest(root: HTMLElement, ctx: Ctx): void {
  const t = ctx.data.timeline;
  const data = ctx.data.invest;
  const reload = () => void ctx.reload();
  if (!t) {
    root.innerHTML = HEAD("") + emptyState("Make a plan first", "Investments hold your plan's savings, so create your plan first.", { href: "#/plan/edit", label: "Create plan" });
    return;
  }
  const opening = Dec.of(t.first.openingBalance);
  if (!data.accounts.length) {
    root.innerHTML = HEAD(`<button class="btn primary" data-add>+ Add investment</button>`) + emptyState("Where are your savings?",
      `Add each place your savings sit, for example "Mashreq daily profit" or "Thndr". ${opening.gt(0) ? `Your plan starts with ${money(opening)} EGP of savings: it's filled in for the first one.` : "Their total at the plan start becomes your plan's opening savings."}`);
    root.querySelector("[data-add]")?.addEventListener("click", () => editAccount(ctx, null, opening, reload));
    return;
  }

  const now = currentMonth();
  const upto = now < t.start ? t.start : now;
  const actualNet = new Map(ctx.data.actuals.map((a) => [a.month, a.net]));
  const netOf = (m: Month) => actualNet.get(m) ?? t.planned(m)?.net ?? Dec.ZERO;
  const led = ledger(data, t.start, upto, netOf);
  const endOf = (id: number) => led.get(id)?.at(-1)?.end ?? Dec.ZERO;
  const total = Dec.sum(data.accounts.map((a) => endOf(a.id)));
  const allProfit = Dec.sum(data.months.map((m) => Dec.of(m.profit)));
  const openSum = Dec.sum(data.accounts.map((a) => Dec.of(a.opening)));
  const logMonth = isMonth(ctx.params[0] ?? "") && ctx.params[0]! >= t.start && ctx.params[0]! <= upto ? ctx.params[0]! : upto;


  root.innerHTML = HEAD(`<button class="btn ghost" data-move>⇄ Move money</button><button class="btn primary" data-add>+ Add investment</button>`) + `
    <div class="inv-sum">
      <div class="card stat"><span class="stat-label">Total now</span><span class="stat-value num">${money(total)} <span class="unit">EGP</span></span><span class="small muted">${money(openSum)} at the plan start = your opening savings</span></div>
      <div class="card stat"><span class="stat-label">Profit / loss so far</span><span class="stat-value num ${allProfit.isNegative() ? "neg" : allProfit.gt(0) ? "pos" : ""}">${signed(allProfit)}</span><span class="small muted">since ${esc(monthLabel(t.start, true))}</span></div>
    </div>
    <div class="inv-grid">${data.accounts.map((a) => accountTile(a, led.get(a.id) ?? [])).join("")}</div>
    ${logCard(ctx, logMonth, led, upto)}
    ${(led.get(data.accounts[0]!.id)?.length ?? 0) >= 2 ? `<div class="card chart-card"><h2>Total over time</h2><div class="chart" id="inv-chart"></div></div>` : ""}
    ${historyCard(ctx)}`;

  root.querySelector("[data-add]")?.addEventListener("click", () => editAccount(ctx, null, Dec.ZERO, reload));
  root.querySelector("[data-move]")?.addEventListener("click", () => editMove(ctx, null, reload));
  root.querySelectorAll<HTMLElement>("[data-edit-acc]").forEach((b) => b.addEventListener("click", () => {
    const a = data.accounts.find((x) => x.id === Number(b.dataset.editAcc));
    if (a) editAccount(ctx, a, Dec.ZERO, reload);
  }));
  root.querySelectorAll<HTMLElement>("[data-edit-move]").forEach((b) => b.addEventListener("click", () => {
    const v = data.moves.find((x) => x.id === Number(b.dataset.editMove));
    if (v) editMove(ctx, v.id, reload);
  }));
  root.querySelectorAll<HTMLElement>("[data-log-month]").forEach((b) => b.addEventListener("click", () => {
    ctx.navigate(`#/invest/${b.dataset.logMonth}`);
    root.querySelector("#inv-log")?.scrollIntoView({ block: "start" });
  }));
  wireLog(root, ctx, logMonth, led);

  const chartEl = root.querySelector<HTMLElement>("#inv-chart");
  if (chartEl) {
    const months = led.get(data.accounts[0]!.id)!.map((r) => r.month);
    lineChart(chartEl, {
      labels: months.map((m) => monthLabel(m)),
      height: 200,
      format: (v) => compact(v),
      zero: false,
      series: [{ name: "Total", values: months.map((_, i) => Dec.sum(data.accounts.map((a) => led.get(a.id)![i]!.end)).toNumber()), color: "var(--accent)" }],
    });
  }
}

function rateText(a: InvestAccount): string {
  return a.usual_rate ? `usually ${Dec.of(a.usual_rate).toString()}${UNIT_LABEL[a.rate_unit]}` : "rate varies";
}

function accountTile(a: InvestAccount, rows: LedgerRow[]): string {
  const end = rows.at(-1)?.end ?? Dec.of(a.opening);
  const lastLogged = [...rows].reverse().find((r) => r.profit);
  const sum = Dec.sum(rows.map((r) => r.profit ?? Dec.ZERO));
  return `<button type="button" class="card inv-tile" data-edit-acc="${a.id}" aria-label="Edit ${esc(a.name)}">
    <span class="inv-top"><span class="inv-name">${esc(a.name)}</span>${a.receives_savings ? `<span class="pill ok-pill" title="Each month's savings (income - expenses) land here">Savings land here</span>` : ""}</span>
    <span class="inv-val num">${money(end)} <span class="unit">EGP</span></span>
    <span class="small muted">${esc(rateText(a))}</span>
    <span class="small">${lastLogged ? `${esc(monthLabel(lastLogged.month))}: <span class="${lastLogged.profit!.isNegative() ? "neg" : "pos"}">${signed(lastLogged.profit!, 2)}</span> · total ${signed(sum)}` : `<span class="muted">nothing logged yet</span>`}</span>
  </button>`;
}

function logCard(ctx: Ctx, month: Month, led: Map<number, LedgerRow[]>, upto: Month): string {
  const t = ctx.data.timeline!;
  const data = ctx.data.invest;
  const rowOf = (id: number) => led.get(id)?.find((r) => r.month === month);
  const saved = new Map(data.months.filter((m) => m.month === month).map((m) => [m.account_id, m]));
  const rows = data.accounts.map((a) => {
    const s = saved.get(a.id);
    const base = rowOf(a.id)?.start ?? Dec.ZERO;
    const mode = s ? (s.rate ? "rate" : "amount") : a.usual_rate ? "rate" : "amount";
    const unit = (s?.rate_unit ?? a.rate_unit) as RateUnit;
    const rate = s?.rate ?? (s ? "" : a.usual_rate ?? "");
    return `<div class="inv-row" data-acc="${a.id}" data-base="${esc(base.toString())}">
      <div class="inv-row-head"><span class="inv-name">${esc(a.name)}</span><span class="muted small">at the start of the month ${money(base)}</span></div>
      <span class="seg inv-mode" role="radiogroup" aria-label="How to log ${esc(a.name)}">
        <label><input type="radio" name="mode:${a.id}" value="rate"${mode === "rate" ? " checked" : ""}><span>Rate</span></label>
        <label><input type="radio" name="mode:${a.id}" value="amount"${mode === "amount" ? " checked" : ""}><span>Amount</span></label>
      </span>
      <span class="inv-rate">
        <input name="rate:${a.id}" inputmode="decimal" data-num="rate" value="${esc(rate ? Dec.of(rate).toString() : "")}" placeholder="17" aria-label="${esc(a.name)} rate">
        <select name="unit:${a.id}" aria-label="${esc(a.name)} rate per">${(["yearly", "monthly", "daily"] as const).map((u) => `<option value="${u}"${u === unit ? " selected" : ""}>${UNIT_LABEL[u]}</option>`).join("")}</select>
      </span>
      <span class="inv-amount"><input name="amount:${a.id}" inputmode="text" data-num="signed-money" autocomplete="off" value="${esc(s && !s.rate ? Dec.of(s.profit).toString() : "")}" placeholder="+1200 or -800" aria-label="${esc(a.name)} profit or loss"></span>
      <span class="inv-result small" data-result="${a.id}"></span>
    </div>`;
  }).join("");
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  return `<section class="card" id="inv-log">
    <div class="section-head"><h2>Profit / loss for ${esc(monthLabel(month, true))}</h2>
      <span class="month-step">
        <button type="button" class="icon-btn" data-log-month="${prev}" aria-label="Previous month"${prev < t.start ? " disabled" : ""}>‹</button>
        <button type="button" class="icon-btn" data-log-month="${next}" aria-label="Next month"${next > upto ? " disabled" : ""}>›</button>
      </span></div>
    <p class="muted small">Type the rate the bank gave this month (the app works out the amount from the balance at the start of the month), or type the profit or loss amount from the app (use − for a loss). Leave it empty if you don't know yet.</p>
    <form id="inv-form" novalidate>
      ${rows}
      <div class="inv-total"><span>Interest for ${esc(monthLabel(month, true))} in your plan</span><strong id="inv-total">–</strong></div>
      <button class="btn primary" type="submit">Save ${esc(monthLabel(month, true))}</button>
    </form>
  </section>`;
}

function wireLog(root: HTMLElement, ctx: Ctx, month: Month, _led: Map<number, LedgerRow[]>): void {
  const form = root.querySelector<HTMLFormElement>("#inv-form");
  if (!form) return;
  const profitOf = (row: HTMLElement): { profit: Dec | null; rate: string; unit: RateUnit; bad: boolean } => {
    const id = row.dataset.acc!;
    const mode = form.querySelector<HTMLInputElement>(`input[name="mode:${id}"]:checked`)?.value;
    const unit = form.querySelector<HTMLSelectElement>(`select[name="unit:${id}"]`)!.value as RateUnit;
    if (mode === "rate") {
      const r = clean(form.querySelector<HTMLInputElement>(`input[name="rate:${id}"]`)!.value);
      if (!r) return { profit: null, rate: "", unit, bad: false };
      if (!RATE_RE.test(r)) return { profit: null, rate: r, unit, bad: true };
      return { profit: profitFromRate(Dec.of(row.dataset.base!), Dec.of(r), unit, month), rate: r, unit, bad: false };
    }
    const v = clean(form.querySelector<HTMLInputElement>(`input[name="amount:${id}"]`)!.value).replace(/^\+/, "").replace(/^−/, "-");
    if (!v) return { profit: null, rate: "", unit, bad: false };
    return SIGNED_RE.test(v) ? { profit: Dec.of(v), rate: "", unit, bad: false } : { profit: null, rate: "", unit, bad: true };
  };
  const refresh = () => {
    let total = Dec.ZERO;
    let any = false;
    form.querySelectorAll<HTMLElement>(".inv-row").forEach((row) => {
      const mode = form.querySelector<HTMLInputElement>(`input[name="mode:${row.dataset.acc}"]:checked`)?.value;
      row.dataset.mode = mode;
      const r = profitOf(row);
      const out = form.querySelector<HTMLElement>(`[data-result="${row.dataset.acc}"]`)!;
      out.className = `inv-result small ${r.profit ? (r.profit.isNegative() ? "neg" : "pos") : "muted"}`;
      out.textContent = r.bad ? "Not a valid number" : r.profit ? signed(r.profit, 2) : "not logged";
      if (r.profit) { total = total.plus(r.profit); any = true; }
    });
    const el = form.querySelector<HTMLElement>("#inv-total")!;
    el.textContent = any ? signed(total, 2) : "–";
    el.className = any ? (total.isNegative() ? "neg" : "pos") : "";
  };
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  refresh();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = [...form.querySelectorAll<HTMLElement>(".inv-row")].map((row) => ({ id: row.dataset.acc!, ...profitOf(row) }));
    if (rows.some((r) => r.bad)) return formError(form, "Fix the boxes marked \"Not a valid number\". Rates look like 17 or 0.05; amounts like 1200 or -800.");
    formError(form, null);
    await busy(form, async () => {
      try {
        await ctx.api.rpc("save_invest_month", { p_month: month, p_rows: rows.map((r) => ({
          account_id: Number(r.id), profit: r.profit ? r.profit.toFixed(2) : "", rate: r.profit && r.rate ? r.rate : "", rate_unit: r.unit,
        })) });
        toast(`${monthLabel(month, true)} saved.`, "ok");
        await ctx.reload();
      } catch (ex) {
        if (ex instanceof ApiError && ex.kind === "auth") ctx.fail(ex);
        else formError(form, ex instanceof ApiError ? ex.message : "Could not save.");
      }
    });
  });
}

function historyCard(ctx: Ctx): string {
  const data = ctx.data.invest;
  const name = (id: number) => data.accounts.find((a) => a.id === id)?.name ?? "?";
  const months = [...new Set([...data.months.map((m) => m.month), ...data.moves.map((v) => v.date.slice(0, 7))])].sort().reverse();
  if (!months.length) return "";
  const body = months.map((m) => {
    const ps = data.months.filter((x) => x.month === m);
    const mv = data.moves.filter((v) => v.date.slice(0, 7) === m);
    const tot = Dec.sum(ps.map((x) => Dec.of(x.profit)));
    return `<li class="tx-month"><span>${esc(monthLabel(m, true))}</span>${ps.length ? `<span class="${tot.isNegative() ? "neg" : "pos"}">${signed(tot, 2)}</span>` : ""}</li>
      ${ps.map((x) => `<li><button type="button" class="tx" data-log-month="${m}">
        <span class="tx-icon ${Dec.of(x.profit).isNegative() ? "spend" : "payment"}" aria-hidden="true">${Dec.of(x.profit).isNegative() ? "↘" : "↗"}</span>
        <span class="tx-main"><span class="tx-label">${esc(name(x.account_id))}</span><span class="tx-sub">${x.rate ? `${Dec.of(x.rate).toString()}${UNIT_LABEL[(x.rate_unit ?? "yearly") as RateUnit]}` : "amount typed"}</span></span>
        <span class="tx-amt ${Dec.of(x.profit).isNegative() ? "out" : "in"}">${signed(x.profit, 2)}</span><span></span></button></li>`).join("")}
      ${mv.map((v) => `<li><button type="button" class="tx" data-edit-move="${v.id}">
        <span class="tx-icon move" aria-hidden="true">⇄</span>
        <span class="tx-main"><span class="tx-label">${esc(name(v.from_account))} → ${esc(name(v.to_account))}</span><span class="tx-sub">${esc(v.date.slice(8))} ${esc(monthLabel(m).split(" ")[0] ?? "")} · move${v.note ? ` · ${esc(v.note)}` : ""}</span></span>
        <span class="tx-amt">${money(v.amount, 0)}</span><span></span></button></li>`).join("")}`;
  }).join("");
  return `<div class="card tx-card"><h2>History</h2><ul class="tx-list inv-hist">${body}</ul></div>`;
}

function fail(ctx: Ctx, dialog: HTMLDialogElement, form: HTMLFormElement, ex: unknown, fallback: string): void {
  if (ex instanceof ApiError && ex.kind === "auth") { dialog.close(); ctx.fail(ex); }
  else formError(form, ex instanceof ApiError ? ex.message : fallback);
}

function editAccount(ctx: Ctx, a: InvestAccount | null, suggestOpening: Dec, reload: () => void): void {
  const t = ctx.data.timeline!;
  const first = !ctx.data.invest.accounts.length;
  openDialog(`
    <form id="acc-form" novalidate>
      <h2>${a ? "Edit investment" : "Add an investment"}</h2>
      <label>Name<input name="name" maxlength="60" value="${esc(a?.name ?? "")}" placeholder="${first ? "Mashreq daily profit" : "Thndr"}" required></label>
      <label>Amount at plan start (${esc(monthLabel(t.start, true))}), EGP
        <input name="opening" inputmode="decimal" data-num="money" value="${esc(a ? Dec.of(a.opening).toString() : suggestOpening.isZero() ? "" : suggestOpening.toString())}" placeholder="0"></label>
      <p class="muted small">${first ? "All your investments together at the plan start are your plan's opening savings." : "Put 0 if you opened it later, then use Move money to record the money you put in."}</p>
      <div class="row-2">
        <label>Usual rate <span class="muted small">(optional)</span><input name="usual_rate" inputmode="decimal" data-num="rate" value="${esc(a?.usual_rate ? Dec.of(a.usual_rate).toString() : "")}" placeholder="17"></label>
        <label>Per<select name="rate_unit">${(["yearly", "monthly", "daily"] as const).map((u) => `<option value="${u}"${(a?.rate_unit ?? "yearly") === u ? " selected" : ""}>${UNIT_LABEL[u]}</option>`).join("")}</select></label>
      </div>
      <p class="muted small">The usual rate is filled in each month for you to change. Leave it empty for things like stocks, where you type the amount.</p>
      <label class="check"><input type="checkbox" name="receives_savings"${a?.receives_savings || (first && !a) ? " checked" : ""}> Each month's savings (income − expenses) land here</label>
      <div class="dialog-actions">
        ${a ? `<button type="button" class="btn ghost danger-text" id="delete-acc">Delete</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${a ? "Save" : "Add"}</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#acc-form")!;
    if (!a) form.querySelector<HTMLInputElement>("input[name=name]")?.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      const opening = clean(f.opening) || "0";
      const rate = clean(f.usual_rate);
      const problem = !(f.name ?? "").trim() ? "Give it a name."
        : !AMOUNT_RE.test(opening) ? "Amount at plan start must be a number of 0 or more."
        : rate && !RATE_RE.test(rate) ? "Usual rate must be a number like 17 or 0.05." : null;
      formError(form, problem);
      if (problem) return;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("save_invest_account", { p_id: a?.id ?? null, p: {
            name: (f.name ?? "").trim(), opening, usual_rate: rate, rate_unit: f.rate_unit ?? "yearly",
            receives_savings: !!form.querySelector<HTMLInputElement>("input[name=receives_savings]")?.checked,
          } });
          dialog.close();
          toast(a ? "Saved." : "Investment added.", "ok");
          reload();
        } catch (ex) { fail(ctx, dialog, form, ex, "Could not save."); }
      });
    });
    dialog.querySelector("#delete-acc")?.addEventListener("click", async () => {
      if (!a || !confirm(`Delete "${a.name}" with all its profit/loss and moves? This can't be undone.`)) return;
      try {
        await ctx.api.rpc("delete_invest_account", { p_id: a.id });
        dialog.close();
        toast("Deleted.", "ok");
        reload();
      } catch (ex) { fail(ctx, dialog, form, ex, "Could not delete."); }
    });
  });
}

function editMove(ctx: Ctx, id: number | null, reload: () => void): void {
  const accs = ctx.data.invest.accounts;
  if (accs.length < 2) { toast("Add a second investment first, then move money between them.", "info"); return; }
  const v = id ? ctx.data.invest.moves.find((x) => x.id === id) ?? null : null;
  const opts = (sel: number) => accs.map((a) => `<option value="${a.id}"${a.id === sel ? " selected" : ""}>${esc(a.name)}</option>`).join("");
  const t = today();
  openDialog(`
    <form id="move-form" novalidate>
      <h2>${v ? "Edit move" : "Move money"}</h2>
      <div class="row-2">
        <label>From<select name="from">${opts(v?.from_account ?? accs[0]!.id)}</select></label>
        <label>To<select name="to">${opts(v?.to_account ?? accs[1]!.id)}</select></label>
      </div>
      <div class="row-2">
        <label>Amount (EGP)<input name="amount" inputmode="decimal" data-num="money" value="${esc(v ? Dec.of(v.amount).toString() : "")}" placeholder="20000" required></label>
        <label>Date<input name="date" type="date" max="${t}" value="${esc(v?.date ?? t)}" required></label>
      </div>
      <label>Note <span class="muted small">(optional)</span><input name="note" maxlength="120" value="${esc(v?.note ?? "")}" placeholder="Bought EGX stocks"></label>
      <p class="muted small">A move isn't profit or loss and doesn't change your savings, only where they sit.</p>
      <div class="dialog-actions">
        ${v ? `<button type="button" class="btn ghost danger-text" id="delete-move">Delete</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${v ? "Save" : "Move"}</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#move-form")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      const amt = clean(f.amount);
      const problem = f.from === f.to ? "Pick two different investments."
        : !AMOUNT_RE.test(amt) || Dec.of(amt).isZero() ? "Amount must be more than 0."
        : !f.date || f.date > t ? "Pick a date that isn't in the future." : null;
      formError(form, problem);
      if (problem) return;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("save_invest_move", { p_id: v?.id ?? null, p: { from_account: f.from, to_account: f.to, amount: amt, date: f.date, note: (f.note ?? "").trim() } });
          dialog.close();
          toast(v ? "Saved." : "Money moved.", "ok");
          reload();
        } catch (ex) { fail(ctx, dialog, form, ex, "Could not save."); }
      });
    });
    dialog.querySelector("#delete-move")?.addEventListener("click", async () => {
      if (!v || !confirm("Delete this move?")) return;
      try {
        await ctx.api.rpc("delete_invest_move", { p_id: v.id });
        dialog.close();
        toast("Deleted.", "ok");
        reload();
      } catch (ex) { fail(ctx, dialog, form, ex, "Could not delete."); }
    });
  });
}
