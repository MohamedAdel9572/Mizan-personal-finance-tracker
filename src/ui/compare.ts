import type { LineGap, MonthComparison, TotalGap } from "../engine/compare.ts";
import { isMonth } from "../engine/month.ts";
import { emptyState, esc } from "../lib/dom.ts";
import { money, monthLabel, signed } from "../lib/format.ts";
import type { Ctx } from "./context.ts";

/** Words + colour for a line's gap, from the point of view of your savings. */
function verdict(l: LineGap): { text: string; cls: string } {
  if (l.status === "on_plan") return { text: "On plan", cls: "neutral" };
  switch (l.kind) {
    case "expense": return l.gap.gt(0) ? { text: "Overspent", cls: "bad" } : { text: "Under budget", cls: "good" };
    case "income": return l.gap.isNegative() ? { text: "Below plan", cls: "bad" } : { text: "Above plan", cls: "good" };
    case "unplanned_expense": return { text: "Unplanned", cls: "bad" };
    case "unplanned_income": return { text: "Unplanned", cls: "good" };
  }
}

function gapCls(netEffect: { isNegative(): boolean; isZero(): boolean }): string {
  return netEffect.isZero() ? "" : netEffect.isNegative() ? "neg" : "pos";
}

function totalCard(title: string, t: TotalGap, higherIsBetter: boolean): string {
  const effect = higherIsBetter ? t.gap : t.gap.neg();
  return `<div class="card stat">
    <span class="stat-label">${esc(title)}</span>
    <span class="stat-value num">${money(t.actual)}</span>
    <span class="small muted">plan ${money(t.planned)}</span>
    <span class="small num ${gapCls(effect.round(0))}">${t.gap.round(0).isZero() ? "on plan" : signed(t.gap)}</span>
  </div>`;
}

export function renderCompare(root: HTMLElement, ctx: Ctx): void {
  const all = ctx.data.comparisons.filter((c) => !c.assumed);
  if (!ctx.data.timeline || all.length === 0) {
    root.innerHTML = `<div class="page-head"><h1>Plan vs actual</h1></div>` +
      emptyState("No months logged yet", "Log a month's real numbers and it will be compared with your plan here.", { href: "#/log", label: "Log a month" });
    return;
  }
  const wanted = ctx.params[0];
  const c: MonthComparison = (isMonth(wanted) && all.find((x) => x.month === wanted)) || all[all.length - 1]!;
  const lines = [...c.lines].sort((a, b) => a.netEffect.cmp(b.netEffect)); // worst first

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Plan vs actual</h1><p class="muted small">Gap = actual − planned. Green helps your savings, red hurts them.</p></div>
    </div>

    <div class="compare-layout">
      <section class="card months-card">
        <h2>Months</h2>
        <table class="table months-table">
          <thead><tr><th scope="col">Month</th><th scope="col" class="num">Net gap</th><th scope="col" class="num">Cumulative</th></tr></thead>
          <tbody>${[...all].reverse().map((m) => `
            <tr class="${m.month === c.month ? "selected" : ""}">
              <th scope="row"><a href="#/compare/${m.month}"><span class="dot ${m.onPlan ? "good" : "bad"}" aria-hidden="true"></span>${esc(monthLabel(m.month, true))}</a></th>
              <td class="num ${gapCls(m.net.gap.round(0))}">${signed(m.net.gap)}</td>
              <td class="num ${gapCls(m.cumulative.net.round(0))}">${signed(m.cumulative.net)}</td>
            </tr>`).join("")}</tbody>
        </table>
      </section>

      <section class="month-detail">
        <div class="detail-head">
          <h2>${esc(monthLabel(c.month, true))} <span class="badge ${c.onPlan ? "good" : "bad"}">${c.onPlan ? "On plan" : "Behind plan"}</span></h2>
          <span class="detail-actions"><span class="muted small">compared with plan v${c.versionNo}</span><a class="btn ghost small" href="#/log/${c.month}">Edit month</a></span>
        </div>
        ${c.biggestCause ? `<div class="alert ${c.onPlan ? "warning" : "danger"}"><strong>Biggest cause:</strong> ${esc(c.biggestCause.name)}, ${signed(c.biggestCause.netEffect)} EGP on your net.</div>` : ""}
        <div class="stats-grid">
          ${totalCard("Income", c.income, true)}
          ${totalCard("Expenses", c.expenses, false)}
          ${totalCard("Net", c.net, true)}
          ${totalCard("Savings balance", c.balance, true)}
        </div>

        <div class="card">
          <h3>By line</h3>
          <table class="table lines-table">
            <thead><tr><th scope="col">Line</th><th scope="col" class="num">Planned</th><th scope="col" class="num">Actual</th><th scope="col" class="num">Gap</th><th scope="col" class="num">So far</th></tr></thead>
            <tbody>${lines.map((l) => {
              const v = verdict(l);
              const sofar = c.cumulative.lines.get(l.key);
              return `<tr>
                <th scope="row">${esc(l.name)} <span class="badge ${v.cls}">${v.text}</span></th>
                <td class="num" data-label="Planned">${money(l.planned)}</td>
                <td class="num" data-label="Actual">${money(l.actual)}</td>
                <td class="num ${gapCls(l.netEffect.round(0))}" data-label="Gap">${l.gap.round(0).isZero() ? "–" : signed(l.gap)}</td>
                <td class="num muted" data-label="So far">${sofar && !l.key.startsWith("unplanned:") && !sofar.round(0).isZero() ? signed(sofar) : "–"}</td>
              </tr>`;
            }).join("")}</tbody>
          </table>
        </div>
        <p class="muted small">Cumulative net gap since you started: <strong class="num ${gapCls(c.cumulative.net.round(0))}">${signed(c.cumulative.net)} EGP</strong></p>
      </section>
    </div>`;
}
