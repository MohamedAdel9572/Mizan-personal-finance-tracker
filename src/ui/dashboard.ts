// Dashboard: headline numbers, goal progress, alerts and charts.
import { Dec } from "../engine/decimal.ts";
import { buildAlerts } from "../engine/alerts.ts";
import { goalProgress, plannedFinish, projectedFinish, type Goal } from "../engine/goal.ts";
import { currentMonth, isMonth, monthRange, monthsBetween, type Month } from "../engine/month.ts";
import { planEnd } from "../engine/plan.ts";
import { ApiError } from "../lib/api.ts";
import { busy, emptyState, esc, formError, formValues, openDialog, toast } from "../lib/dom.ts";
import { egp, money, monthLabel, pct, signed } from "../lib/format.ts";
import { barChart, compact, divergingBars, lineChart } from "./charts.ts";
import { LOG_BASE } from "./log.ts";
import type { Ctx } from "./context.ts";

const PLANNED = "var(--chart-planned)";
const ACTUAL = "var(--series-1)";
const INCOME = "var(--series-3)";
const EXPENSE = "var(--series-2)";

// alert texts carry months as 2026-11; show them as "Nov 2026"
function readableMonths(text: string): string {
  return text.replace(/\b(\d{4}-\d{2})\b/g, (m) => (isMonth(m) ? monthLabel(m, true) : m));
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

export function renderDashboard(root: HTMLElement, ctx: Ctx): void {
  const t = ctx.data.timeline;
  const name = esc(firstName(ctx.data.profile.full_name));
  if (!t) {
    root.innerHTML = `<div class="page-head"><h1>Hi ${name}</h1></div>` +
      emptyState("Let's set up your plan", "Add your income, installments and savings account first. Then your dashboard fills with charts.", { href: "#/plan", label: "Create my plan" });
    return;
  }

  const now = currentMonth();
  const latest = t.latest;
  const end = planEnd(latest) > now ? planEnd(latest) : now;
  const months = monthRange(t.start, end);
  const labels = months.map((m) => monthLabel(m));
  const actualBy = new Map(ctx.data.actuals.filter((a) => !a.assumed).map((a) => [a.month, a]));
  const cmps = ctx.data.comparisons.filter((c) => !c.assumed);
  const lastCmp = cmps.at(-1);
  const lastActual = lastCmp ? actualBy.get(lastCmp.month) : undefined;
  const planned = (m: Month) => t.planned(m);
  const nowIdx = months.indexOf(now);
  const notLogged = now >= t.start && !ctx.data.checkins.some((c) => c.month === now);

  const goal = ctx.data.goal;
  const nwNow = lastActual?.netWorth ?? planned(now < t.start ? t.start : now)?.netWorth ?? Dec.ZERO;
  const nwPlannedNow = planned(lastActual?.month ?? (now < t.start ? t.start : now))?.netWorth ?? Dec.ZERO;
  const proj = goal ? projectedFinish(t, ctx.data.actuals, ctx.data.comparisons, goal) : null;
  const planFinish = goal ? plannedFinish(t, goal) : null;
  const alerts = buildAlerts(ctx.data.comparisons, ctx.data.actuals, goal, proj);

  const rateOf = (net: Dec, income: Dec) => (income.isZero() ? null : net.div(income));
  const lastRate = lastActual ? rateOf(lastActual.net, lastActual.income) : null;
  const plannedRate = lastActual ? rateOf(planned(lastActual.month)!.net, planned(lastActual.month)!.income) : null;
  const gold = ctx.data.goldValue;

  const tile = (label: string, value: string, sub: string, cls = "") =>
    `<div class="card stat"><span class="stat-label">${label}</span><span class="stat-value num ${cls}">${value}</span><span class="small muted">${sub}</span></div>`;
  const toneOf = (d: Dec) => (d.round(0).isZero() ? "" : d.isNegative() ? "neg" : "pos");

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Hi ${name}</h1><p class="muted small">${lastCmp ? `Last logged month: ${esc(monthLabel(lastCmp.month, true))}` : "No months logged yet: these numbers are your plan."}</p></div>
      <div class="head-actions">
        ${notLogged ? `<a class="btn primary" href="${LOG_BASE}${now}">Log ${esc(monthLabel(now, true))}</a>` : ""}
        <button class="btn ghost" id="edit-goal">${goal ? "Edit goal" : "Set goal"}</button>
      </div>
    </div>

    <div class="kpis">
      ${tile("Net worth", egp(nwNow), lastActual ? `plan ${money(nwPlannedNow)} · ${signed(nwNow.minus(nwPlannedNow))}` : `planned for ${monthLabel(now < t.start ? t.start : now, true)}`, lastActual ? toneOf(nwNow.minus(nwPlannedNow)) : "")}
      ${goal ? tile("Goal progress", pct(goalProgress(nwNow, goal)), `of ${money(goal.targetAmount)} by ${monthLabel(goal.targetMonth, true)}`) : tile("Goal", "Not set", "set a goal to track progress")}
      ${lastCmp ? tile("Last month vs plan", signed(lastCmp.net.gap), `${monthLabel(lastCmp.month, true)} net ${money(lastCmp.net.actual)}`, toneOf(lastCmp.net.gap)) : tile("Last month vs plan", "–", "log a month to compare")}
      ${lastCmp ? tile("Total gap so far", signed(lastCmp.cumulative.net), `since ${monthLabel(t.start, true)}`, toneOf(lastCmp.cumulative.net)) : ""}
      ${lastRate !== null ? tile("Savings rate", pct(lastRate), `plan ${plannedRate !== null ? pct(plannedRate) : "–"} · ${monthLabel(lastActual!.month, true)}`, lastRate.gte(plannedRate ?? Dec.ZERO) ? "pos" : "neg") : ""}
      ${gold ? `<a class="card stat link-card" href="#/gold"><span class="stat-label">Gold now</span><span class="stat-value num">${egp(gold)}</span><span class="small muted">${ctx.data.goldFeed && !ctx.data.goldFeed.stale ? "at today's price" : "at the last known price"}</span></a>` : ""}
    </div>

    <div class="dash-grid">
      ${goal ? goalCard(goal, nwNow, nwPlannedNow, planFinish, proj) : `<section class="card"><h2>Your goal</h2><p class="muted">Set a target (for example 1,000,000 EGP by Dec 2028) to see your progress and when you'll reach it.</p><button class="btn primary" id="set-goal-2">Set goal</button></section>`}
      <section class="card alerts-card"><h2>Alerts</h2>${alerts.length ? `<ul class="alerts">${alerts.map((a) =>
        `<li class="alert-${a.level}"><span class="alert-icon" aria-hidden="true">${a.level === "danger" ? "!" : a.level === "warning" ? "▲" : "i"}</span><span><strong>${a.level === "danger" ? "Needs attention" : a.level === "warning" ? "Watch" : "Good news"}:</strong> ${esc(readableMonths(a.message))}</span></li>`).join("")}</ul>`
        : `<p class="muted">${cmps.length ? "Nothing to worry about. You're on plan." : "Alerts appear once you log months."}</p>`}</section>
    </div>

    <div class="chart-grid">
      <section class="card chart-card"><h2>Net worth</h2><p class="muted small">Savings + gold + other assets. Planned (dashed) vs actual.</p><div class="chart" id="c-networth"></div></section>
      <section class="card chart-card"><h2>Savings balance</h2><p class="muted small">Planned (dashed) vs actual, including interest.</p><div class="chart" id="c-balance"></div></section>
      <section class="card chart-card"><h2>Income vs expenses</h2><p class="muted small">Per month. Logged months show what really happened; the rest is the plan.</p><div class="chart" id="c-incexp"></div></section>
      <section class="card chart-card"><h2>Savings rate</h2><p class="muted small">Share of income you kept (net ÷ income).</p><div class="chart" id="c-rate"></div></section>
      <section class="card chart-card"><h2>Plan vs actual net</h2><p class="muted small">Logged months only.</p><div class="chart" id="c-net"></div></section>
      <section class="card chart-card"><h2>Where the gap comes from</h2><p class="muted small">Total since you started, by line. Right helps your savings, left hurts.</p><div class="chart" id="c-gaps"></div></section>
    </div>
    <p class="muted small center"><a href="#/history/months">See every month in History →</a></p>`;

  const kpis = root.querySelector<HTMLElement>(".kpis");
  kpis?.style.setProperty("--n", String(kpis.children.length));

  // ---------- charts ----------
  const n = (d: Dec | undefined | null) => (d ? d.toNumber() : null);
  const fmtEgp = (v: number) => compact(v);
  lineChart(root.querySelector("#c-networth")!, {
    labels, format: fmtEgp, marker: nowIdx,
    series: [
      { name: "Planned", values: months.map((m) => n(planned(m)?.netWorth)), color: PLANNED, dashed: true },
      { name: "Actual", values: months.map((m) => n(actualBy.get(m)?.netWorth)), color: ACTUAL },
      ...(goal ? [{ name: "Goal", values: months.map(() => Dec.of(goal.targetAmount).toNumber()), color: "var(--chart-goal)", dashed: true }] : []),
    ],
  });
  lineChart(root.querySelector("#c-balance")!, {
    labels, format: fmtEgp, marker: nowIdx,
    series: [
      { name: "Planned", values: months.map((m) => n(planned(m)?.balance)), color: PLANNED, dashed: true },
      { name: "Actual", values: months.map((m) => n(actualBy.get(m)?.balance)), color: ACTUAL },
    ],
  });
  barChart(root.querySelector("#c-incexp")!, {
    labels, format: fmtEgp,
    series: [
      { name: "Income", values: months.map((m) => (actualBy.get(m)?.income ?? planned(m)?.income ?? Dec.ZERO).toNumber()), color: INCOME },
      { name: "Expenses", values: months.map((m) => (actualBy.get(m)?.expenses ?? planned(m)?.expenses ?? Dec.ZERO).toNumber()), color: EXPENSE },
    ],
  });
  const rate = (net?: Dec, inc?: Dec) => (net && inc && !inc.isZero() ? net.div(inc).times(100).toNumber() : null);
  lineChart(root.querySelector("#c-rate")!, {
    labels, format: (v) => `${Math.round(v)}%`, marker: nowIdx, zero: false,
    series: [
      { name: "Planned", values: months.map((m) => rate(planned(m)?.net, planned(m)?.income)), color: PLANNED, dashed: true },
      { name: "Actual", values: months.map((m) => rate(actualBy.get(m)?.net, actualBy.get(m)?.income)), color: ACTUAL },
    ],
  });
  const netEl = root.querySelector<HTMLElement>("#c-net")!;
  if (cmps.length) {
    barChart(netEl, {
      labels: cmps.map((c) => monthLabel(c.month)), format: fmtEgp, height: 220,
      series: [
        { name: "Planned net", values: cmps.map((c) => c.net.planned.toNumber()), color: PLANNED },
        { name: "Actual net", values: cmps.map((c) => c.net.actual.toNumber()), color: ACTUAL },
      ],
    });
  } else netEl.innerHTML = `<p class="muted chart-empty">Log a month to compare it with the plan.</p>`;

  const gapsEl = root.querySelector<HTMLElement>("#c-gaps")!;
  if (lastCmp) {
    const byLine = new Map<string, number>();
    let unplanned = 0;
    for (const [key, gap] of lastCmp.cumulative.lines) {
      if (key.startsWith("unplanned:")) continue;
      const info = t.lineInfo(key);
      if (!info) continue;
      const effect = info.kind === "income" ? gap : gap.neg();
      byLine.set(info.name, (byLine.get(info.name) ?? 0) + effect.toNumber());
    }
    for (const u of ctx.data.unplanned) unplanned += (u.kind === "income" ? 1 : -1) * Dec.of(u.amount).toNumber();
    const items = [...byLine].map(([label, value]) => ({ label, value }))
      .concat(unplanned ? [{ label: "Unplanned items", value: unplanned }] : [])
      .filter((i) => Math.round(i.value) !== 0)
      .sort((a, b) => a.value - b.value);
    if (items.length) divergingBars(gapsEl, items, (v) => signed(Dec.of(Math.round(v))));
    else gapsEl.innerHTML = `<p class="muted chart-empty">Every line is exactly on plan so far.</p>`;
  } else gapsEl.innerHTML = `<p class="muted chart-empty">Log a month to see which lines cause gaps.</p>`;

  root.querySelectorAll("#edit-goal, #set-goal-2").forEach((b) => b.addEventListener("click", () => editGoal(ctx, goal)));
}

function goalCard(goal: Goal, nwNow: Dec, nwPlanned: Dec, planFinish: Month | null, proj: ReturnType<typeof projectedFinish> | null): string {
  const target = Dec.of(goal.targetAmount);
  const pctOf = (d: Dec) => Math.max(0, Math.min(100, d.div(target).times(100).toNumber()));
  const actualPct = pctOf(nwNow);
  const plannedPct = pctOf(nwPlanned);
  const ahead = nwNow.gte(nwPlanned);
  const vs = (m: Month | null) => {
    if (!m) return "not within 50 years";
    const d = monthsBetween(goal.targetMonth, m);
    return `${monthLabel(m, true)}${d === 0 ? " (on time)" : d < 0 ? ` (${-d} months early)` : ` (${d} months late)`}`;
  };
  return `<section class="card goal-card">
    <div class="section-head"><h2>Goal: ${money(target)} EGP by ${esc(monthLabel(goal.targetMonth, true))}</h2></div>
    <div class="goal-bar" role="img" aria-label="${actualPct.toFixed(0)}% reached; the plan expected ${plannedPct.toFixed(0)}% by now">
      <div class="goal-fill ${ahead ? "ahead" : "behind"}" style="width:${actualPct}%"></div>
      <div class="goal-marker" style="left:${plannedPct}%" title="Planned by now: ${plannedPct.toFixed(0)}%"><span>plan</span></div>
    </div>
    <div class="goal-legend small"><span><strong>${actualPct.toFixed(0)}%</strong> reached (${money(nwNow)})</span><span class="muted">plan by now: ${plannedPct.toFixed(0)}%</span></div>
    <dl class="goal-facts">
      <div><dt>Plan reaches it</dt><dd>${esc(vs(planFinish))}</dd></div>
      <div><dt>At your real pace</dt><dd class="${proj && proj.month && (proj.monthsVsTarget ?? 0) > 0 ? "neg" : "pos"}">${esc(vs(proj?.month ?? null))}</dd></div>
      ${proj && proj.basedOnMonths ? `<div><dt>Your average gap</dt><dd>${signed(proj.averageNetGap)} / month (last ${proj.basedOnMonths} logged)</dd></div>` : ""}
      ${goal.monthlySavingsTarget ? `<div><dt>Monthly savings target</dt><dd>${money(goal.monthlySavingsTarget)} EGP</dd></div>` : ""}
    </dl>
  </section>`;
}

function editGoal(ctx: Ctx, goal: Goal | null): void {
  openDialog(`
    <form id="goal-form" novalidate>
      <h2>${goal ? "Edit goal" : "Set your goal"}</h2>
      <label>Target net worth (EGP)<input name="amount" inputmode="decimal" value="${esc(goal ? Dec.of(goal.targetAmount).toString() : "1000000")}" required></label>
      <label>By<input name="month" type="month" value="${esc(goal?.targetMonth ?? "2028-12")}" required></label>
      <label>Monthly savings target (EGP, optional)<input name="saving" inputmode="decimal" value="${esc(goal?.monthlySavingsTarget ? Dec.of(goal.monthlySavingsTarget).toString() : "")}"></label>
      <p class="muted small">Net worth = savings balance + gold + other assets.</p>
      <div class="dialog-actions">${goal ? `<button type="button" class="btn ghost danger-text" id="remove-goal">Remove goal</button><span class="spacer"></span>` : ""}<button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save goal</button></div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#goal-form")!;
    dialog.querySelector("#remove-goal")?.addEventListener("click", async () => {
      if (!confirm("Remove your goal? The dashboard goes back to showing your plan without a target. You can set a new goal any time.")) return;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("delete_goal");
          dialog.close();
          await ctx.reload();
          toast("Goal removed.", "ok");
        } catch (ex) {
          if (ex instanceof ApiError && ex.kind === "auth") { dialog.close(); ctx.fail(ex); }
          else formError(form, ex instanceof ApiError ? ex.message : "Could not remove the goal.");
        }
      });
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      const amount = (f.amount ?? "").replace(/[,\s]/g, "");
      const saving = (f.saving ?? "").replace(/[,\s]/g, "");
      const problem = !/^\d{1,14}(\.\d{1,2})?$/.test(amount) || Dec.of(amount).isZero() ? "Target must be a number above 0."
        : !isMonth(f.month) ? "Pick a month." : saving && !/^\d{1,14}(\.\d{1,2})?$/.test(saving) ? "Monthly savings target must be a number." : null;
      formError(form, problem);
      if (problem) return;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("set_goal", { p_target_amount: amount, p_target_month: f.month, p_monthly_savings_target: saving || null });
          dialog.close();
          await ctx.reload();
          toast("Goal saved.", "ok");
        } catch (ex) {
          if (ex instanceof ApiError && ex.kind === "auth") { dialog.close(); ctx.fail(ex); }
          else formError(form, ex instanceof ApiError ? ex.message : "Could not save the goal.");
        }
      });
    });
  });
}
