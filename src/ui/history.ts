// History: a timeline of every change, and every logged month with its result.
import { isMonth } from "../engine/month.ts";
import { emptyState, esc, toast } from "../lib/dom.ts";
import { money, monthLabel, signed } from "../lib/format.ts";
import { loadingHtml } from "./shell.ts";
import type { Ctx } from "./context.ts";

interface Event { id: number; at: string; type: string; entity: string; month: string | null; summary: string }

type Category = "plan" | "actuals" | "unplanned" | "gold" | "cards" | "invest" | "import" | "other";
const CATEGORY: Record<Category, { label: string; icon: string }> = {
  plan: { label: "Plan", icon: "▦" },
  actuals: { label: "Actuals", icon: "✓" },
  unplanned: { label: "Unplanned", icon: "!" },
  gold: { label: "Gold", icon: "◆" },
  cards: { label: "Cards", icon: "▭" },
  invest: { label: "Investments & savings", icon: "↗" },
  import: { label: "Imports", icon: "⇪" },
  other: { label: "Settings & goal", icon: "⚙" },
};

const PLURAL: Record<string, string> = {
  gold_holdings: "gold pieces", unplanned_items: "unplanned items", gold_price_overrides: "gold prices",
};

function category(e: Event): Category {
  if (e.type === "upload") return "import";
  if (e.type === "plan_version" || e.type === "plan_delete") return "plan";
  if (e.entity === "actual_entries" || e.entity === "monthly_checkins") return "actuals";
  if (e.entity === "unplanned_items") return "unplanned";
  if (e.entity.startsWith("gold")) return "gold";
  if (e.entity === "cards" || e.entity === "card_txns" || e.entity === "card_links") return "cards";
  if (e.entity.startsWith("invest_")) return "invest";
  return "other";
}

/** "Added actual Salary = 28000.00 (2026-11)" -> nicer amounts */
function pretty(summary: string): string {
  return summary.replace(/= (-?\d+(?:\.\d+)?)/g, (_, n: string) => "= " + money(n, n.includes(".") && !/\.0+$/.test(n) ? 2 : 0));
}

interface Group { key: string; cat: Category; at: string; month: string | null; events: Event[] }

/** A check-in writes one entry per line; show those as one group. */
function group(events: Event[]): Group[] {
  const out: Group[] = [];
  for (const e of events) {
    const cat = category(e);
    const last = out[out.length - 1];
    const close = last && Math.abs(new Date(last.at).getTime() - new Date(e.at).getTime()) < 120_000;
    const same = last && last.events[0]!.entity === e.entity && last.events[0]!.type === e.type && last.month === e.month;
    if (last && close && ((cat === "actuals" && last.cat === "actuals" && last.month === e.month) || (same && (e.entity === "gold_holdings" || e.entity === "unplanned_items")))) {
      last.events.push(e);
      continue;
    }
    out.push({ key: String(e.id), cat, at: e.at, month: e.month, events: [e] });
  }
  return out;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const fmt = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(x);
  const today = fmt(new Date());
  const yesterday = fmt(new Date(Date.now() - 86_400_000));
  const day = fmt(d);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return d.toLocaleDateString("en-GB", { timeZone: "Africa/Cairo", weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
}

let filterCat: Category | "all" = "all";
let filterMonth = "all";

export function renderHistory(root: HTMLElement, ctx: Ctx): void {
  const tab = ctx.params[0] === "months" ? "months" : "timeline";
  const head = `<div class="page-head"><div><h1>History</h1><p class="muted small">Every change you made, and every month you logged.</p></div>
      ${tab === "timeline" ? `<div class="head-actions"><button class="btn ghost danger-text" id="clear-history" hidden>Clear history</button></div>` : ""}</div>
    <div class="segmented tabs" role="tablist">
      <a role="tab" href="#/history" class="${tab === "timeline" ? "on" : ""}" aria-selected="${tab === "timeline"}">Timeline</a>
      <a role="tab" href="#/history/months" class="${tab === "months" ? "on" : ""}" aria-selected="${tab === "months"}">Months</a>
    </div>`;
  if (tab === "months") {
    root.innerHTML = head + monthsHtml(ctx);
    return;
  }
  root.innerHTML = head + loadingHtml();
  ctx.api.rpc<Event[]>("get_history", { p_limit: 500 }).then((events) => {
    if (!events.length) {
      root.innerHTML = head + emptyState("Nothing yet", "Saving your plan, logging a month or importing a file shows up here.");
      return;
    }
    const clearBtn = () => root.querySelector<HTMLButtonElement>("#clear-history");
    const wireClear = () => {
      const b = clearBtn();
      if (!b) return;
      b.hidden = false;
      b.addEventListener("click", async () => {
        if (!confirm(`Clear all ${events.length} entries from your history?\n\nOnly this list is cleared. Your plan, logged months and gold stay as they are. This can't be undone.`)) return;
        b.disabled = true;
        try {
          await ctx.api.rpc("clear_history");
          filterCat = "all";
          filterMonth = "all";
          toast("History cleared.", "ok");
          renderHistory(root, ctx);
        } catch (err) {
          b.disabled = false;
          ctx.fail(err);
        }
      });
    };
    queueMicrotask(wireClear);
    const months = [...new Set(events.map((e) => e.month).filter((m): m is string => !!m && isMonth(m)))].sort().reverse();
    const shown = events.filter((e) => (filterCat === "all" || category(e) === filterCat) && (filterMonth === "all" || e.month === filterMonth));
    const groups = group(shown);
    let lastDay = "";
    root.innerHTML = head + `
      <div class="filters">
        <label>Type<select id="f-cat"><option value="all">All changes</option>
          ${(Object.keys(CATEGORY) as Category[]).map((c) => `<option value="${c}"${c === filterCat ? " selected" : ""}>${CATEGORY[c].label}</option>`).join("")}</select></label>
        <label>Month<select id="f-month"><option value="all">All months</option>
          ${months.map((m) => `<option value="${m}"${m === filterMonth ? " selected" : ""}>${esc(monthLabel(m, true))}</option>`).join("")}</select></label>
      </div>
      ${groups.length ? `<ol class="timeline">${groups.map((g) => {
        const day = dayLabel(g.at);
        const dayHead = day !== lastDay ? `<li class="tl-day">${esc(day)}</li>` : "";
        lastDay = day;
        const first = g.events[0]!;
        const title = g.events.length === 1 ? esc(pretty(first.summary))
          : g.cat === "actuals" ? `Logged ${g.month ? esc(monthLabel(g.month, true)) : ""}: ${g.events.length} changes`
          : `${esc(first.summary.split(" ")[0] ?? "Changed")} ${g.events.length} ${esc(PLURAL[first.entity] ?? "items")}`;
        return `${dayHead}<li class="tl-item cat-${g.cat}">
          <span class="tl-icon" aria-hidden="true">${CATEGORY[g.cat].icon}</span>
          <div class="tl-body">
            <div class="tl-title">${title}</div>
            <div class="muted small">${esc(time(g.at))} · ${CATEGORY[g.cat].label}${g.month ? ` · ${esc(monthLabel(g.month, true))}` : ""}</div>
            ${g.events.length > 1 ? `<details><summary class="small">Show details</summary><ul class="tight small">${g.events.map((e) => `<li>${esc(pretty(e.summary))}</li>`).join("")}</ul></details>` : ""}
          </div></li>`;
      }).join("")}</ol>` : `<p class="muted">No changes match these filters.</p>`}`;
    root.querySelector<HTMLSelectElement>("#f-cat")!.addEventListener("change", (e) => { filterCat = (e.target as HTMLSelectElement).value as Category | "all"; renderHistory(root, ctx); });
    root.querySelector<HTMLSelectElement>("#f-month")!.addEventListener("change", (e) => { filterMonth = (e.target as HTMLSelectElement).value; renderHistory(root, ctx); });
  }).catch((e) => {
    root.innerHTML = head + `<div class="alert danger">Couldn't load your history.</div>`;
    ctx.fail(e);
  });
}

function monthsHtml(ctx: Ctx): string {
  const months = ctx.data.comparisons.filter((c) => !c.assumed).reverse();
  if (!months.length) return emptyState("No months logged yet", "Log a month and its result appears here.", { href: "#/log", label: "Log a month" });
  return `<div class="card"><table class="table months-history">
    <thead><tr><th>Month</th><th class="num">Planned net</th><th class="num">Actual net</th><th class="num">Gap</th><th class="num">Savings balance</th><th>Result</th></tr></thead>
    <tbody>${months.map((c) => `<tr>
      <th scope="row"><a href="#/plan/log/${c.month}">${esc(monthLabel(c.month, true))}</a></th>
      <td class="num" data-label="Planned net">${money(c.net.planned)}</td>
      <td class="num" data-label="Actual net">${money(c.net.actual)}</td>
      <td class="num ${c.net.gap.round(0).isNegative() ? "neg" : c.net.gap.round(0).isZero() ? "" : "pos"}" data-label="Gap">${c.net.gap.round(0).isZero() ? "–" : signed(c.net.gap)}</td>
      <td class="num" data-label="Balance">${money(c.balance.actual)}</td>
      <td data-label="Result"><span class="badge ${c.onPlan ? "good" : "bad"}">${c.onPlan ? "On plan" : "Behind"}</span>${c.biggestCause && !c.onPlan ? ` <span class="muted small">${esc(c.biggestCause.name)}</span>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
