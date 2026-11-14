import { Dec } from "../engine/decimal.ts";
import { currentMonth, isMonth, monthRange, type Month } from "../engine/month.ts";
import { planEnd, projectPlan } from "../engine/plan.ts";
import type { PlanMonth, PlanVersion } from "../engine/types.ts";
import type { MonthComparison } from "../engine/compare.ts";
import { SEED_PLAN } from "../data/seed.ts";
import { ApiError } from "../lib/api.ts";
import { busy, esc, formError, openDialog, toast } from "../lib/dom.ts";
import { money, monthLabel, dateTime } from "../lib/format.ts";
import {
  defaultEffective, draftFromVersion, draftToPayload, emptyDraft, lastPlanMonth, newItem, validateDraft,
  type Draft, type DraftItem,
} from "../lib/planDraft.ts";
import { isGoldLine, type VersionInfo } from "../lib/store.ts";
import type { Ctx } from "./context.ts";
import { renderImport } from "./importScreen.ts";
import { LOG_BASE, planReturn, renderLog } from "./log.ts";

// ---------------------------------------------------------------------------
//  View: two tabs over the same grid. "Plan" shows the expected numbers only.
//  "Actual" shows logged months with a status dot (hover shows the plan) and
//  leaves unlogged months empty. Clicking a month opens the log panel.
// ---------------------------------------------------------------------------

type Status = "good" | "warn" | "bad";
let STATUS_WORD: Record<Status, string> = { good: "On plan or better", warn: "Slightly behind (within 5%)", bad: "Behind plan" };
/** "slightly behind" band in %, from Settings */
let warnPct = "5";

/** Green when it helps your savings or matches the plan, amber when worse by up to `pct`% (Settings, default 5), red beyond that. */
export function statusOf(effect: Dec, planned: Dec, pct: string = warnPct): Status {
  if (!effect.isNegative() || effect.round(0).isZero()) return "good";
  const base = planned.abs();
  return !base.isZero() && effect.abs().lte(base.times(Dec.of(pct).div(100))) ? "warn" : "bad";
}

interface Actual { planned: Dec; actual: Dec; effect: Dec; unit: "income" | "expense" | "neutral" }

interface GridRow {
  label: string;
  cls: string;
  values: (r: PlanMonth) => Dec;
  /** actual for a logged month, or null when there is nothing to compare */
  actual?: (month: Month) => Actual | null;
  /** value shown on the Actual tab for rows without a plan comparison (assets) */
  logged?: (month: Month) => Dec | null;
  /** small tag after the label, e.g. "automatic" for the Gold line */
  tag?: { text: string; title: string };
}

function gridRows(v: PlanVersion, ctx: Ctx): { section: string; rows: GridRow[] }[] {
  const cmp = new Map(ctx.data.comparisons.filter((c) => !c.assumed).map((c) => [c.month, c]));
  const act = new Map(ctx.data.actuals.filter((a) => !a.assumed).map((a) => [a.month, a]));
  const lineActual = (key: string) => (m: Month): Actual | null => {
    const l = cmp.get(m)?.lines.find((x) => x.key === key);
    return l ? { planned: l.planned, actual: l.actual, effect: l.netEffect, unit: l.kind === "income" ? "income" : "expense" } : null;
  };
  const total = (pick: (c: MonthComparison) => { planned: Dec; actual: Dec; gap: Dec }, higherIsBetter: boolean, unit: Actual["unit"]) => (m: Month): Actual | null => {
    const c = cmp.get(m);
    if (!c) return null;
    const t = pick(c);
    return { planned: t.planned, actual: t.actual, effect: higherIsBetter ? t.gap : t.gap.neg(), unit };
  };
  const line = (key: string, name: string, withActual: boolean): GridRow => {
    const autoGold = !withActual && ctx.data.goldAuto && isGoldLine(name);
    return {
      label: name, cls: "line", values: (r) => r.lines.get(key) ?? Dec.ZERO,
      ...(withActual ? { actual: lineActual(key) }
        : autoGold ? { logged: (m: Month) => (cmp.has(m) ? ctx.data.goldByMonth.get(m) ?? null : null) }
        : { logged: (m: Month) => (cmp.has(m) ? act.get(m)?.lines.get(key) ?? null : null) }),
      ...(autoGold ? { tag: { text: "automatic", title: "Value of your gold pieces at today's Egyptian shop price (Gold page). Logged months keep the value from the day you logged them." } } : {}),
    };
  };
  const of = (kind: string) => v.items.filter((i) => i.kind === kind).map((i) => line(i.key, i.name, kind !== "asset"));
  const unplanned = (kind: "income" | "expense"): GridRow[] => {
    const items = ctx.data.unplanned.filter((u) => u.kind === kind);
    if (!items.length) return [];
    return [{
      label: kind === "income" ? "Unplanned income" : "Unplanned expenses", cls: "line unplanned", values: () => Dec.ZERO,
      actual: (m) => {
        const sum = Dec.sum(items.filter((u) => u.month === m).map((u) => u.amount));
        if (sum.isZero() || !cmp.has(m)) return null;
        return { planned: Dec.ZERO, actual: sum, effect: kind === "income" ? sum : sum.neg(), unit: kind };
      },
    }];
  };
  return [
    { section: "Income", rows: [...of("income"), ...unplanned("income"), { label: "Total income", cls: "total", values: (r) => r.income, actual: total((c) => c.income, true, "income") }] },
    { section: "Installments & expenses", rows: [...of("expense"), ...unplanned("expense"), { label: "Total expenses", cls: "total", values: (r) => r.expenses, actual: total((c) => c.expenses, false, "expense") }] },
    {
      section: "Savings",
      rows: [
        { label: "Net", cls: "total signed", values: (r) => r.net, actual: total((c) => c.net, true, "neutral") },
        {
          label: "Interest", cls: "line", values: (r) => r.interest,
          actual: (m) => {
            const a = act.get(m);
            const p = ctx.data.timeline?.planned(m);
            return a && p ? { planned: p.interest, actual: a.interest, effect: a.interest.minus(p.interest), unit: "neutral" } : null;
          },
        },
        { label: "Savings balance", cls: "total signed", values: (r) => r.balance, actual: total((c) => c.balance, true, "neutral") },
      ],
    },
    { section: "Assets", rows: [...of("asset"), { label: "Net worth", cls: "grand", values: (r) => r.netWorth, actual: total((c) => c.netWorth, true, "neutral") }] },
  ];
}

function gapWords(a: Actual): string {
  const gap = a.actual.minus(a.planned);
  if (gap.round(0).isZero()) return "as planned";
  const amount = money(gap.abs());
  if (a.unit === "expense") return gap.gt(0) ? `${amount} over plan` : `${amount} under plan`;
  return gap.gt(0) ? `${amount} above plan` : `${amount} below plan`;
}

function tipText(month: Month, a: Actual, st: Status): string {
  return `${monthLabel(month, true)} · ${STATUS_WORD[st]}\nActual ${money(a.actual)} · Planned ${money(a.planned)}\n${gapWords(a)}`;
}

function cell(d: Dec, signedCls: boolean, month: Month, actual: Actual | null): string {
  const neg = d.isNegative() && d.round(0).isNegative();
  const zero = d.round(0).isZero();
  const text = zero ? "–" : money(d);
  if (!actual) return `<td class="num${neg && signedCls ? " neg" : ""}${zero ? " zero" : ""}">${text}</td>`;
  const st = statusOf(actual.effect, actual.planned);
  return `<td class="num has-actual${neg && signedCls ? " neg" : ""}${zero ? " zero" : ""}" tabindex="0" data-tip="${esc(tipText(month, actual, st))}">`
    + `<span class="dot-status ${st}" aria-hidden="true"></span>${text}<span class="sr-only">, ${esc(STATUS_WORD[st])}, actual ${money(actual.actual)}</span></td>`;
}

function actualCell(row: GridRow, month: Month, signedCls: boolean, isLogged: boolean): string {
  const a = row.actual ? row.actual(month) : null;
  const plain = !a && row.logged ? row.logged(month) : null;
  const d = a ? a.actual : plain;
  if (!d) return isLogged ? `<td class="num zero">–</td>` : `<td class="num blank"></td>`;
  const neg = d.round(0).isNegative();
  const zero = d.round(0).isZero();
  const text = zero ? "–" : money(d);
  const cls = `num${neg && signedCls ? " neg" : ""}${zero ? " zero" : ""}`;
  if (!a) return `<td class="${cls}">${text}</td>`;
  const st = statusOf(a.effect, a.planned);
  const tip = `${monthLabel(month, true)} · ${STATUS_WORD[st]}\nActual ${money(a.actual)} · Planned ${money(a.planned)}\n${gapWords(a)}`;
  return `<td class="${cls} has-actual" tabindex="0" data-tip="${esc(tip)}"><span class="dot-status ${st}" aria-hidden="true"></span>${text}`
    + `<span class="sr-only">, ${esc(STATUS_WORD[st])}, planned ${money(a.planned)}</span></td>`;
}

let selectedVersionNo: number | null = null;
let mobileMonthIndex = -1;

/** First month that still needs logging (or this month). */
function logTarget(ctx: Ctx): Month | null {
  const t = ctx.data.timeline;
  const now = currentMonth();
  if (!t || now < t.start) return null;
  const done = new Set(ctx.data.checkins.map((c) => c.month));
  return monthRange(t.start, now).find((m) => !done.has(m)) ?? now;
}

export function renderPlan(root: HTMLElement, ctx: Ctx): void {
  if (ctx.params[0] === "edit") return renderEditor(root, ctx, ctx.params[1] === "sample");
  if (ctx.params[0] === "import") return renderImport(root, ctx);

  const { versions } = ctx.data;
  if (versions.length === 0) {
    root.innerHTML = `
      <div class="page-head"><div><h1>Plan</h1>
        <p class="muted small">No plan yet. Pick how you want to start. You can change everything later.</p></div></div>
      <div class="choices">
        ${choice("#/plan/import", "upload", "Import from Excel", "Upload the Mizan template or your own month-by-month sheet. You'll see a preview first.", true)}
        ${choice("#/plan/edit", "pencil", "Start from scratch", "Add your income, installments and savings account by hand.")}
        ${choice("#/plan/edit/sample", "spark", "Use the sample numbers", "Start from the numbers of your Excel sheet and adjust them.")}
        ${choice("/Mizan-template.xlsx", "download", "Download template", "An empty Excel file in the right format to fill in and upload.", false, true)}
      </div>`;
    return;
  }

  warnPct = ctx.data.settings.warnPct;
  const pctText = Dec.of(warnPct).toString();
  STATUS_WORD = { ...STATUS_WORD, warn: `Slightly behind (within ${pctText}%)` };
  // #/plan = what you expect (plan only), #/plan/actual = what really happened
  const tab: "plan" | "actual" = ctx.params[0] === "actual" ? "actual" : ctx.params[0] === "log" ? planReturn.tab : "plan";
  planReturn.tab = tab;
  const info = versions.find((v) => v.version.versionNo === selectedVersionNo) ?? versions[0]!;
  const v = info.version;
  const rows = projectPlan(v);
  const now = currentMonth();
  const groups = gridRows(v, ctx);
  const logged = new Map(ctx.data.comparisons.filter((c) => !c.assumed).map((c) => [c.month, c]));
  const target = logTarget(ctx);
  const canLog = (m: Month) => !!ctx.data.timeline && m >= ctx.data.timeline.start && m <= now;
  if (mobileMonthIndex < 0 || mobileMonthIndex >= rows.length) {
    const i = rows.findIndex((r) => r.month === now);
    mobileMonthIndex = i >= 0 ? i : 0;
  }
  const mm = rows[mobileMonthIndex]!;

  const monthHead = (m: Month) => {
    const c = logged.get(m);
    const dot = tab === "plan" ? "" : c ? `<span class="dot-status ${c.onPlan ? "good" : "bad"}" aria-hidden="true"></span>` : canLog(m) ? `<span class="dot-status pending" aria-hidden="true"></span>` : "";
    const label = esc(monthLabel(m));
    if (!canLog(m)) return `<th scope="col" class="num${m === now ? " current" : ""}">${label}</th>`;
    const what = c ? `${monthLabel(m, true)}: ${c.onPlan ? "on plan" : "behind plan"}. Open to see or edit the actuals` : `Log ${monthLabel(m, true)}`;
    return `<th scope="col" class="num${m === now ? " current" : ""}"><a class="month-link" href="${LOG_BASE}${m}" title="${esc(what)}" aria-label="${esc(what)}">${dot}${label}</a></th>`;
  };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Plan</h1>
        <p class="muted small">${esc(monthLabel(v.start, true))} – ${esc(monthLabel(planEnd(v), true))} · opening ${money(v.openingBalance)} EGP</p>
      </div>
      <div class="head-actions">
        <label class="sr-only" for="version">Plan version</label>
        <select id="version">${versions.map((x) => `<option value="${x.version.versionNo}"${x === info ? " selected" : ""}>${esc(versionLabel(x))}</option>`).join("")}</select>
        ${target ? `<a class="btn ${logged.has(target) ? "ghost" : "primary"}" href="${LOG_BASE}${target}">${logged.has(target) ? "Edit" : "Log"} ${esc(monthLabel(target, true))}</a>` : ""}
        <a class="btn ghost" href="#/plan/edit">Edit plan</a>
        <details class="menu">
          <summary class="icon-btn" aria-label="More plan actions" title="More">⋯</summary>
          <div class="menu-list" role="menu">
            <a role="menuitem" href="#/plan/import"><strong>Import from Excel</strong><span class="muted small">The template or your own month-by-month sheet</span></a>
            <a role="menuitem" href="/Mizan-template.xlsx" download><strong>Download template</strong><span class="muted small">Empty Excel file in the right format</span></a>
            <button type="button" role="menuitem" id="undo-version" ${versions.length > 1 ? "" : "disabled"}>
              <strong>Undo last change</strong><span class="muted small">${versions.length > 1 ? `Delete version ${versions[0]!.version.versionNo}; version ${versions[1]!.version.versionNo} becomes current` : "Only one version, nothing to undo"}</span></button>
            <button type="button" role="menuitem" id="delete-plan" class="danger-item">
              <strong>Delete plan</strong><span class="muted small">All versions, logged months and unplanned items. Gold is kept.</span></button>
          </div>
        </details>
      </div>
    </div>
    ${info !== versions[0] ? `<p class="notice">You are looking at an older version. Months from ${esc(monthLabel(v.effectiveFrom, true))} were compared with it until a newer version took over.</p>` : ""}
    <div class="plan-tabs">
      <div class="segmented tabs" role="tablist" aria-label="Plan or actual">
        <a role="tab" href="#/plan" class="${tab === "plan" ? "on" : ""}" aria-selected="${tab === "plan"}">Plan</a>
        <a role="tab" href="#/plan/actual" class="${tab === "actual" ? "on" : ""}" aria-selected="${tab === "actual"}">Actual</a>
      </div>
      ${tab === "plan"
        ? `<p class="muted small">What you expect each month. Switch to Actual to see what really happened.</p>`
        : `<div class="legend" aria-label="What the dots mean">
            <span><span class="dot-status good"></span>On plan or better</span>
            <span><span class="dot-status warn"></span>Slightly behind (≤ ${pctText}%) <a class="small" href="#/settings" title="Change this limit in Settings">change</a></span>
            <span><span class="dot-status bad"></span>Behind plan</span>
            <span><span class="dot-status pending"></span>Not logged yet</span>
            <span class="muted desktop-only">Empty months are not logged yet. Hover a cell to see the plan.</span>
          </div>`}
    </div>

    <div class="grid-wrap desktop-only" role="region" aria-label="${tab === "plan" ? "Plan by month" : "Actual by month"}" tabindex="0">
      <table class="grid">
        <thead><tr><th class="sticky-col" scope="col">Line</th>${rows.map((r) => monthHead(r.month)).join("")}</tr></thead>
        <tbody>
          ${groups.map((g) => `
            <tr class="section"><th class="sticky-col" scope="rowgroup" colspan="1">${esc(g.section)}</th><td colspan="${rows.length}"></td></tr>
            ${g.rows.map((row) => `<tr class="${row.cls}"><th class="sticky-col" scope="row">${esc(row.label)}${row.tag ? ` <span class="row-tag" title="${esc(row.tag.title)}">${esc(row.tag.text)}</span>` : ""}</th>${rows.map((r) =>
              tab === "plan" ? cell(row.values(r), row.cls.includes("signed") || row.cls === "grand", r.month, null)
                : actualCell(row, r.month, row.cls.includes("signed") || row.cls === "grand", logged.has(r.month))).join("")}</tr>`).join("")}
          `).join("")}
        </tbody>
      </table>
    </div>

    <section class="month-view mobile-only" aria-label="Plan for one month">
      <div class="month-nav">
        <button class="icon-btn" data-step="-1" aria-label="Previous month">‹</button>
        <div class="month-title"><strong>${tab === "actual" && logged.get(mm.month) ? `<span class="dot-status ${logged.get(mm.month)!.onPlan ? "good" : "bad"}"></span>` : ""}${esc(monthLabel(mm.month, true))}</strong><span class="muted small">${mobileMonthIndex + 1} of ${rows.length}</span></div>
        <button class="icon-btn" data-step="1" aria-label="Next month">›</button>
      </div>
      ${canLog(mm.month) ? `<a class="btn ${logged.has(mm.month) ? "ghost" : "primary"} block" href="${LOG_BASE}${mm.month}">${logged.has(mm.month) ? "Edit" : "Log"} ${esc(monthLabel(mm.month, true))}</a>` : ""}
      ${tab === "actual" && !logged.has(mm.month) ? `<p class="muted center">Not logged yet.</p>` : `<div class="swipe">${groups.map((g) => `
        <div class="card list-card">
          <h3>${esc(g.section)}</h3>
          ${g.rows.map((row) => {
            const a = row.actual ? row.actual(mm.month) : null;
            const d = tab === "plan" ? row.values(mm) : a ? a.actual : row.logged?.(mm.month) ?? null;
            if (!d) return "";
            if (row.cls.startsWith("line") && d.isZero()) return "";
            const neg = d.round(0).isNegative();
            const st = tab === "actual" && a ? statusOf(a.effect, a.planned) : null;
            return `<div class="kv ${row.cls}"><span>${esc(row.label)}${row.tag ? ` <span class="row-tag">${esc(row.tag.text)}</span>` : ""}${st && a ? `<span class="kv-actual muted small">plan ${money(a.planned)} · ${esc(gapWords(a))}</span>` : ""}</span>
              <span class="num${neg ? " neg" : ""}">${st ? `<span class="dot-status ${st}" aria-label="${esc(STATUS_WORD[st])}"></span>` : ""}${d.round(0).isZero() ? "–" : money(d)}</span></div>`;
          }).join("")}
        </div>`).join("")}
      </div>`}
    </section>
`;

  // tooltip that follows the hovered / focused cell (works inside the scrolling grid)
  const tip = document.getElementById("grid-tip") ?? Object.assign(document.createElement("div"), { id: "grid-tip", role: "tooltip" });
  if (!tip.isConnected) document.body.append(tip);
  const show = (el: HTMLElement) => {
    tip.textContent = el.dataset.tip ?? "";
    tip.className = "grid-tip show";
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`;
  };
  const hide = () => (tip.className = "grid-tip");
  const grid = root.querySelector<HTMLElement>(".grid-wrap");
  grid?.addEventListener("mouseover", (e) => { const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]"); if (el) show(el); });
  grid?.addEventListener("mouseout", (e) => { if ((e.target as HTMLElement).closest("[data-tip]")) hide(); });
  grid?.addEventListener("focusin", (e) => { const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]"); if (el) show(el); });
  grid?.addEventListener("focusout", hide);
  grid?.addEventListener("scroll", hide, { passive: true });

  root.querySelector("#undo-version")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const [cur, prev] = versions;
    if (!cur || !prev) return;
    if (!confirm(`Delete plan version ${cur.version.versionNo}? Version ${prev.version.versionNo} becomes current again.`)) return;
    btn.disabled = true;
    try {
      await ctx.api.rpc("delete_latest_plan_version");
      selectedVersionNo = null;
      await ctx.reload();
      toast(`Version ${cur.version.versionNo} deleted. Version ${prev.version.versionNo} is current.`, "ok");
    } catch (err) {
      btn.disabled = false;
      ctx.fail(err);
    }
  });
  root.querySelector("#delete-plan")?.addEventListener("click", () => confirmDeletePlan(ctx));

  root.querySelector<HTMLSelectElement>("#version")!.addEventListener("change", (e) => {
    selectedVersionNo = Number((e.target as HTMLSelectElement).value);
    renderPlan(root, ctx);
  });
  const go = (step: number) => {
    const next = mobileMonthIndex + step;
    if (next < 0 || next >= rows.length) return;
    mobileMonthIndex = next;
    renderPlan(root, ctx);
  };
  root.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.step))));
  const swipe = root.querySelector<HTMLElement>(".month-view")!;
  let x0 = 0;
  swipe.addEventListener("touchstart", (e) => (x0 = e.touches[0]?.clientX ?? 0), { passive: true });
  swipe.addEventListener("touchend", (e) => {
    const dx = (e.changedTouches[0]?.clientX ?? 0) - x0;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
  });

  // #/plan/log/<month>: the log panel opens on top of the grid
  if (ctx.params[0] === "log") openLogPanel(ctx, ctx.params[1] ?? "");
}

function openLogPanel(ctx: Ctx, month: string): void {
  const dialog = openDialog(`<div class="log-panel"></div>`, (d) => {
    d.classList.add("wide");
    const body = d.querySelector<HTMLElement>(".log-panel")!;
    renderLog(body, { ...ctx, params: month ? [month] : [] });
    body.querySelector("[data-close-panel]")?.addEventListener("click", () => d.close());
  });
  // closing by the user (×, Esc, backdrop) goes back to the plan; closing because the route changed doesn't
  dialog.addEventListener("close", () => {
    if (dialog.dataset.closing !== "route" && location.hash.startsWith(LOG_BASE)) ctx.navigate(planReturn.tab === "actual" ? "#/plan/actual" : "#/plan");
  });
}

const CHOICE_ICONS: Record<string, string> = {
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
};

/** A big tappable option card (used where the user picks how to start). */
function choice(href: string, icon: string, title: string, text: string, primary = false, download = false): string {
  return `<a class="choice${primary ? " primary" : ""}" href="${esc(href)}"${download ? " download" : ""}>
    <span class="choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${CHOICE_ICONS[icon]}</svg></span>
    <span class="choice-body"><strong>${esc(title)}</strong><span class="muted small">${esc(text)}</span></span>
    <span class="choice-arrow" aria-hidden="true">›</span>
  </a>`;
}

function confirmDeletePlan(ctx: Ctx): void {
  const months = ctx.data.checkins.length;
  const unplanned = ctx.data.unplanned.length;
  const versions = ctx.data.versions.length;
  openDialog(`
    <form id="delete-plan-form" novalidate>
      <h2>Delete the whole plan?</h2>
      <p>This permanently deletes:</p>
      <ul class="tight">
        <li>${versions} plan ${versions === 1 ? "version" : "versions"}</li>
        <li>${months} logged ${months === 1 ? "month" : "months"} and their amounts</li>
        <li>${unplanned} unplanned ${unplanned === 1 ? "item" : "items"}</li>
      </ul>
      <p class="muted small">Your gold pieces and your account stay. It can't be undone; download or keep your Excel file if you may need it again.</p>
      <label>Type <strong>DELETE</strong> to confirm<input name="confirm" autocomplete="off" autocapitalize="characters"></label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn danger" disabled>Delete plan</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#delete-plan-form")!;
    const input = form.querySelector<HTMLInputElement>("input[name=confirm]")!;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    input.focus();
    input.addEventListener("input", () => (submit.disabled = input.value.trim().toUpperCase() !== "DELETE"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (input.value.trim().toUpperCase() !== "DELETE") return;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("delete_plan");
          dialog.close();
          selectedVersionNo = null;
          discardPlanDraft();
          await ctx.reload();
          ctx.navigate("#/plan");
          toast("Plan deleted.", "ok");
        } catch (err) {
          if (err instanceof ApiError && err.kind === "auth") { dialog.close(); ctx.fail(err); }
          else formError(form, err instanceof ApiError ? err.message : "Could not delete the plan.");
        }
      });
      submit.disabled = input.value.trim().toUpperCase() !== "DELETE";
    });
  });
}

function versionLabel(x: VersionInfo): string {
  return `v${x.version.versionNo} · from ${monthLabel(x.version.effectiveFrom)} · saved ${dateTime(x.createdAt).split(",")[0]}`;
}

// ---------------------------------------------------------------------------
//  Editor: one card per line, amounts as a list of changes over time
// ---------------------------------------------------------------------------

let draft: Draft | null = null;
let dirty = false;

export function hasUnsavedPlan(): boolean {
  return dirty;
}

export function discardPlanDraft(): void {
  draft = null;
  dirty = false;
}

const KIND_LABEL = { income: "Income", expense: "Installment / expense", asset: "Asset (gold, other)" } as const;

function renderEditor(root: HTMLElement, ctx: Ctx, sample: boolean): void {
  const latest = ctx.data.versions[0]?.rawVersion;
  if (!draft) {
    draft = latest ? draftFromVersion(latest) : sample ? draftFromVersion({ ...SEED_PLAN }) : emptyDraft(currentMonth());
    if (sample && !latest) draft.items.forEach((i) => (i.key = "")); // new lines get real keys from the database
    dirty = !latest && sample;
  }
  const d = draft;
  const end = lastPlanMonth(d);

  const amountRow = (item: DraftItem, i: number, a: { month: string; amount: string }, j: number) => `
    <div class="amount-row">
      <label><span class="sr-only">Month</span><input type="month" data-i="${i}" data-j="${j}" data-f="month" value="${esc(a.month)}" ${item.recurrence === "recurring" && j === 0 ? "disabled title=\"Same as the start month\"" : ""}></label>
      <label><span class="sr-only">Amount</span><input inputmode="decimal" data-i="${i}" data-j="${j}" data-f="amount" value="${esc(a.amount)}" placeholder="0"></label>
      <button type="button" class="icon-btn danger" data-del-amount="${i}:${j}" aria-label="Remove amount"${item.amounts.length === 1 ? " disabled" : ""}>×</button>
    </div>`;

  const itemCard = (item: DraftItem, i: number) => `
    <fieldset class="card item-card kind-${item.kind}" id="item-${i}">
      <legend class="sr-only">Line ${i + 1}</legend>
      <div class="item-head">
        <input class="item-name" data-i="${i}" data-f="name" value="${esc(item.name)}" placeholder="Name, e.g. Salary" aria-label="Line name" maxlength="80">
        <button type="button" class="icon-btn danger" data-del-item="${i}" aria-label="Remove line ${esc(item.name)}">🗑</button>
      </div>
      <div class="row-2">
        <label>Type<select data-i="${i}" data-f="kind" ${item.key ? "disabled title=\"A saved line can't change type. Add a new line instead.\"" : ""}>
          ${(["income", "expense", "asset"] as const).map((k) => `<option value="${k}"${item.kind === k ? " selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}
        </select></label>
        <label>Repeats<select data-i="${i}" data-f="recurrence" ${item.kind === "asset" ? "disabled" : ""}>
          <option value="recurring"${item.recurrence === "recurring" ? " selected" : ""}>Every month</option>
          <option value="one_off"${item.recurrence === "one_off" ? " selected" : ""}>One-off months</option>
        </select></label>
      </div>
      ${item.recurrence === "recurring" ? `
      <div class="row-2">
        <label>From<input type="month" data-i="${i}" data-f="start" value="${esc(item.start)}"></label>
        <label>Until <span class="muted small">(empty = no end)</span><input type="month" data-i="${i}" data-f="end" value="${esc(item.end)}"></label>
      </div>` : ""}
      ${item.kind === "asset" && isGoldLine(item.name) ? `<p class="notice small">Automatic: this line shows the value of your pieces on the Gold page at today's Egyptian shop price. The amount below is only used if you have no gold pieces.</p>` : ""}
      <div class="amounts">
        <div class="amount-head muted small"><span>${item.recurrence === "recurring" ? "Amount from month" : "Month"}</span><span>${item.kind === "asset" ? "Value" : "Amount"} (EGP)</span><span></span></div>
        ${item.amounts.map((a, j) => amountRow(item, i, a, j)).join("")}
        <button type="button" class="btn ghost small" data-add-amount="${i}">+ ${item.recurrence === "recurring" ? "Amount changes from…" : "Add month"}</button>
      </div>
    </fieldset>`;

  const section = (kind: DraftItem["kind"], title: string) => {
    const list = d.items.map((it, i) => [it, i] as const).filter(([it]) => it.kind === kind);
    return `<section class="editor-section">
      <h2>${title} <span class="muted small">(${list.length})</span></h2>
      ${list.map(([it, i]) => itemCard(it, i)).join("") || `<p class="muted small">Nothing yet.</p>`}
      <button type="button" class="btn ghost" data-add-item="${kind}">+ Add ${title.toLowerCase().replace(/s$/, "")}</button>
    </section>`;
  };

  root.innerHTML = `
    <form id="plan-editor" novalidate>
      <div class="page-head">
        <div><h1>${latest ? "Edit plan" : "Create plan"}</h1>
        <p class="muted small">${latest ? `Saving creates version ${latest.versionNo + 1}. Version ${latest.versionNo} is kept as it is.` : "You can change everything later. Every change is kept as a new version."}</p></div>
        <div class="head-actions">
          ${latest ? `<a class="btn ghost" href="#/plan" data-cancel>Cancel</a>` : ""}
          <button class="btn primary head-save" type="submit">Save plan</button>
        </div>
      </div>
      <div id="problems"></div>

      <section class="card editor-section">
        <h2>Plan & savings account</h2>
        <div class="row-3">
          <label>Start month<input type="month" data-f="start" value="${esc(d.start)}"></label>
          <label>Horizon (months)<input inputmode="numeric" data-f="horizonMonths" value="${esc(d.horizonMonths)}"></label>
          <label>Opening savings (EGP)<input inputmode="decimal" data-f="openingBalance" value="${esc(d.openingBalance)}"></label>
        </div>
        ${end ? `<p class="muted small">Plan runs to ${esc(monthLabel(end, true))}.</p>` : ""}
        <h3>Annual interest rate</h3>
        ${d.rates.map((r, k) => `
          <div class="amount-row">
            <label><span class="sr-only">From month</span><input type="month" data-rate="${k}" data-f="from" value="${esc(r.from)}" ${k === 0 ? "disabled title=\"Same as the start month\"" : ""}></label>
            <label class="suffix"><span class="sr-only">Rate</span><input inputmode="decimal" data-rate="${k}" data-f="rate" value="${esc(r.rate)}"><span>%</span></label>
            <button type="button" class="icon-btn danger" data-del-rate="${k}" aria-label="Remove rate"${d.rates.length === 1 ? " disabled" : ""}>×</button>
          </div>`).join("")}
        <button type="button" class="btn ghost small" data-add-rate>+ Rate changes from…</button>
      </section>

      ${section("income", "Income")}
      ${section("expense", "Installments & expenses")}
      ${section("asset", "Assets")}
      <div class="sticky-save mobile-only"><button class="btn primary block" type="submit">Save plan</button></div>
    </form>`;

  const form = root.querySelector<HTMLFormElement>("#plan-editor")!;
  const rerender = () => renderEditor(root, ctx, false);

  // typing: update the draft without re-rendering (keeps focus and cursor)
  form.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const f = el.dataset.f;
    if (!f) return;
    dirty = true;
    if (el.dataset.rate !== undefined) {
      const r = d.rates[Number(el.dataset.rate)]!;
      if (f === "from") r.from = el.value;
      else r.rate = el.value;
      return;
    }
    if (el.dataset.i === undefined) {
      if (f === "start") {
        d.start = el.value;
        if (d.rates[0]) d.rates[0].from = el.value;
      } else if (f === "horizonMonths") d.horizonMonths = el.value;
      else if (f === "openingBalance") d.openingBalance = el.value;
      return;
    }
    const item = d.items[Number(el.dataset.i)]!;
    if (el.dataset.j !== undefined) {
      const a = item.amounts[Number(el.dataset.j)]!;
      if (f === "month") a.month = el.value;
      else a.amount = el.value;
      return;
    }
    if (f === "name") item.name = el.value;
    else if (f === "start") {
      item.start = el.value;
      if (item.recurrence === "recurring" && item.amounts[0]) item.amounts[0].month = el.value;
    } else if (f === "end") item.end = el.value;
  });

  // structural changes: re-render
  form.addEventListener("change", (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.tagName !== "SELECT" || el.dataset.i === undefined) return;
    const item = d.items[Number(el.dataset.i)]!;
    if (el.dataset.f === "kind") {
      item.kind = el.value as DraftItem["kind"];
      if (item.kind === "asset") item.recurrence = "recurring";
    } else if (el.dataset.f === "recurrence") {
      item.recurrence = el.value as DraftItem["recurrence"];
      if (item.recurrence === "recurring") {
        const first = [...item.amounts].sort((a, b) => a.month.localeCompare(b.month))[0];
        item.start = first?.month || d.start;
        item.end = "";
      }
    }
    rerender();
  });

  form.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b || b.type === "submit") return;
    const ds = b.dataset;
    const month = d.start && isMonth(d.start) ? defaultEffective(currentMonth(), null, d.start) : currentMonth();
    if (ds.addItem) {
      d.items.push(newItem(ds.addItem as DraftItem["kind"], month));
      dirty = true;
      rerender();
      root.querySelector<HTMLInputElement>(`#item-${d.items.length - 1} .item-name`)?.focus();
    } else if (ds.delItem) {
      const item = d.items[Number(ds.delItem)]!;
      const msg = item.key
        ? `Remove "${item.name}" from the plan? Earlier versions and your logged actuals for it are kept.`
        : `Remove "${item.name || "this line"}"?`;
      if (!confirm(msg)) return;
      d.items.splice(Number(ds.delItem), 1);
      dirty = true;
      rerender();
    } else if (ds.addAmount) {
      const item = d.items[Number(ds.addAmount)]!;
      item.amounts.push({ month: "", amount: "" });
      dirty = true;
      rerender();
    } else if (ds.delAmount) {
      const [i, j] = ds.delAmount.split(":").map(Number);
      d.items[i!]!.amounts.splice(j!, 1);
      dirty = true;
      rerender();
    } else if (ds.addRate !== undefined) {
      d.rates.push({ from: "", rate: d.rates.at(-1)?.rate ?? "0" });
      dirty = true;
      rerender();
    } else if (ds.delRate) {
      d.rates.splice(Number(ds.delRate), 1);
      dirty = true;
      rerender();
    }
  });

  root.querySelector("[data-cancel]")?.addEventListener("click", (e) => {
    if (dirty && !confirm("Discard your changes?")) {
      e.preventDefault();
      return;
    }
    discardPlanDraft();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const problems = validateDraft(d);
    const box = root.querySelector<HTMLElement>("#problems")!;
    root.querySelectorAll(".item-card.invalid").forEach((el) => el.classList.remove("invalid"));
    if (problems.length) {
      box.innerHTML = `<div class="alert danger" role="alert"><strong>Please fix ${problems.length === 1 ? "this" : `these ${problems.length} things`}:</strong><ul>${problems.slice(0, 12).map((p) => `<li>${p.item !== null ? `<a href="#item-${p.item}" data-jump="${p.item}">${esc(p.message)}</a>` : esc(p.message)}</li>`).join("")}</ul></div>`;
      problems.forEach((p) => p.item !== null && root.querySelector(`#item-${p.item}`)?.classList.add("invalid"));
      box.querySelectorAll<HTMLAnchorElement>("[data-jump]").forEach((a) => a.addEventListener("click", (ev) => {
        ev.preventDefault();
        root.querySelector(`#item-${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }));
      box.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    box.innerHTML = "";
    askEffectiveAndSave(ctx, d, latest ?? null);
  });
}

function askEffectiveAndSave(ctx: Ctx, d: Draft, latest: PlanVersion | null): void {
  const eff = latest ? defaultEffective(currentMonth(), latest.effectiveFrom, d.start) : d.start;
  const end = lastPlanMonth(d) ?? d.start;
  openDialog(`
    <form method="dialog" id="save-form" novalidate>
      <h2>Save plan</h2>
      ${latest ? `
        <label>Use this version from<input type="month" name="effective" value="${esc(eff)}" min="${esc(latest.effectiveFrom)}" required></label>
        <p class="muted small">Months before ${esc(monthLabel(eff, true))} stay compared with version ${latest.versionNo}. Pick an earlier month only to fix a mistake.</p>`
      : `<p class="muted small">This is your first plan. It covers ${esc(monthLabel(d.start, true))} to ${esc(monthLabel(end, true))}.</p>`}
      <label>Note <span class="muted small">(optional, e.g. "salary raise")</span><input name="note" maxlength="500"></label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-close>Back</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#save-form")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const effective = (form.elements.namedItem("effective") as HTMLInputElement | null)?.value ?? d.start;
      const note = (form.elements.namedItem("note") as HTMLInputElement).value.trim();
      if (!isMonth(effective)) return formError(form, "Pick a valid month.");
      if (latest && effective < latest.effectiveFrom) return formError(form, `Can't be before ${monthLabel(latest.effectiveFrom, true)}.`);
      await busy(form, async () => {
        try {
          const res = await ctx.api.rpc<{ version_no: number }>("save_plan_version", { p_plan: draftToPayload(d, effective, note) });
          dialog.close();
          discardPlanDraft();
          await ctx.reload();
          ctx.navigate("#/plan");
          toast(`Plan saved as version ${res.version_no}.`, "ok");
        } catch (err) {
          if (err instanceof ApiError && err.kind === "auth") ctx.fail(err);
          else formError(form, err instanceof ApiError ? err.message : "Could not save. Please try again.");
        }
      });
    });
  });
}

/** Months covered by any version up to `to` (used by Log and Compare). */
export function planMonthsUntil(ctx: Ctx, to: Month): Month[] {
  const t = ctx.data.timeline;
  if (!t || to < t.start) return [];
  return monthRange(t.start, to);
}

