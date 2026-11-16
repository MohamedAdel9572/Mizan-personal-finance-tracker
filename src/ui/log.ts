import { Dec } from "../engine/decimal.ts";
import { addMonths, currentMonth, isMonth, monthRange, type Month } from "../engine/month.ts";
import { ApiError } from "../lib/api.ts";
import { busy, emptyState, esc, formError, formValues, openDialog, toast } from "../lib/dom.ts";
import { egp, money, monthLabel, signed } from "../lib/format.ts";
import { cleanAmount } from "../lib/planDraft.ts";
import type { Ctx } from "./context.ts";

const AMOUNT_RE = /^\d{1,14}(\.\d{1,2})?$/;

/** Unsaved check-in values, kept while an unplanned item is added (that re-renders the screen). */
let stash: { month: Month; values: Map<string, string> } | null = null;

function stashForm(month: Month): void {
  const form = document.querySelector<HTMLFormElement>("#checkin");
  if (!form) return;
  const values = new Map<string, string>();
  form.querySelectorAll<HTMLInputElement>("input[name]").forEach((i) => {
    if (i.type === "radio") { if (i.checked) values.set(`radio:${i.name}`, i.value); }
    else values.set(i.name, i.value);
  });
  stash = { month, values };
}

/** Where the month log lives: a panel on the Plan page. */
export const LOG_BASE = "#/plan/log/";
/** Which Plan tab to go back to when the log panel closes. */
export const planReturn: { tab: "plan" | "actual" } = { tab: "plan" };

export function renderLog(root: HTMLElement, ctx: Ctx): void {
  const t = ctx.data.timeline;
  if (!t) {
    root.innerHTML = `<div class="page-head"><h1>Log actuals</h1></div>` +
      emptyState("Create your plan first", "Each month you log what really happened against your plan.", { href: "#/plan", label: "Go to plan" });
    return;
  }
  const now = currentMonth();
  if (now < t.start) {
    root.innerHTML = `<div class="page-head"><h1>Log actuals</h1></div>` +
      emptyState("Nothing to log yet", `Your plan starts in ${monthLabel(t.start, true)}. Come back then.`);
    return;
  }

  const months = monthRange(t.start, now).reverse();
  const checked = new Set(ctx.data.checkins.map((c) => c.month));
  const wanted = ctx.params[0];
  const month: Month = isMonth(wanted) && months.includes(wanted)
    ? wanted
    : (months.find((m) => !checked.has(m)) ?? months[0]!); // first month not checked in yet
  const version = t.versionFor(month)!;
  const planned = t.planned(month)!;
  const existing = ctx.data.entries.get(month);
  const checkin = ctx.data.checkins.find((c) => c.month === month);
  const unplanned = ctx.data.unplanned.filter((u) => u.month === month);

  // lines: everything planned this month, plus anything already logged
  const keys: string[] = [];
  for (const item of version.items) {
    if (item.kind === "asset") continue;
    if (!(planned.lines.get(item.key) ?? Dec.ZERO).isZero() || existing?.has(item.key)) keys.push(item.key);
  }
  for (const key of existing?.keys() ?? []) if (!keys.includes(key)) keys.push(key);

  // lines paid with a card: choose Card or Cash for this month
  const { cards, links, txns } = ctx.data.cards;
  const linkOf = (key: string) => {
    const l = links.find((x) => x.item_key === key);
    const card = l && cards.find((c) => c.id === l.card_id);
    return l && card ? { link: l, card } : null;
  };
  const viaFor = (key: string): "card" | "cash" => {
    if (txns.some((x) => x.item_key === key && x.month === month)) return "card";
    return existing?.has(key) ? "cash" : "card";
  };
  const lineRow = (key: string) => {
    const info = t.lineInfo(key)!;
    const p = planned.lines.get(key) ?? Dec.ZERO;
    const value = existing?.get(key) ?? (checkin ? "0" : p.toFixed(2));
    const lk = info.kind === "expense" ? linkOf(key) : null;
    const via = lk ? viaFor(key) : null;
    return `<div class="log-line">
      <label for="l-${esc(key)}"><span class="line-name">${esc(info.name)}</span><span class="muted small">planned ${money(p)}</span></label>
      <input id="l-${esc(key)}" name="line:${esc(key)}" inputmode="decimal" value="${esc(Dec.of(value).toString())}" data-planned="${esc(p.toString())}" data-kind="${info.kind}">
      <span class="gap small" data-gap-for="${esc(key)}"></span>
      ${lk ? `<div class="via" role="radiogroup" aria-label="How ${esc(info.name)} was paid">
        <span class="muted small">Paid with</span>
        <span class="seg via-seg">
          <label><input type="radio" name="via:${esc(key)}" value="card"${via === "card" ? " checked" : ""}><span>${esc(lk.card.name)}${lk.link.mode === "installment" ? " · installment" : ""}</span></label>
          <label><input type="radio" name="via:${esc(key)}" value="cash"${via === "cash" ? " checked" : ""}><span>Cash</span></label>
        </span></div>` : ""}
    </div>`;
  };
  const group = (kind: "income" | "expense", title: string) => {
    const list = keys.filter((k) => t.lineInfo(k)?.kind === kind);
    return list.length ? `<h3>${title}</h3>${list.map(lineRow).join("")}` : "";
  };

  root.innerHTML = `
    <div class="panel-head">
      <div><h2>Log a month</h2>
      <p class="muted small">Planned amounts are filled in; change what was different.</p></div>
      <button type="button" class="icon-btn" data-close-panel aria-label="Close">×</button>
    </div>
    ${comparisonSummary(ctx, month)}
    <div class="month-nav">
      <button class="icon-btn" data-go="${esc(addMonths(month, -1))}" aria-label="Previous month" ${month <= t.start ? "disabled" : ""}>‹</button>
      <label class="month-select"><span class="sr-only">Month</span>
        <select id="month">${months.map((m) => `<option value="${m}"${m === month ? " selected" : ""}>${esc(monthLabel(m, true))}${checked.has(m) ? " ✓" : ""}</option>`).join("")}</select>
      </label>
      <button class="icon-btn" data-go="${esc(addMonths(month, 1))}" aria-label="Next month" ${month >= now ? "disabled" : ""}>›</button>
    </div>
    ${checkin ? `<div class="notice ok">Checked in. Saving again updates it.</div>` : ""}

    <div class="log-layout">
      <form id="checkin" class="card" novalidate>
        <h2>Planned lines <span class="muted small">(plan v${version.versionNo})</span></h2>
        ${keys.length ? group("income", "Income") + group("expense", "Installments & expenses") : `<p class="muted">No planned lines this month.</p>`}
        <h3>Savings account</h3>
        ${ctx.data.invest.accounts.length ? (() => {
          const ps = ctx.data.invest.months.filter((x) => x.month === month);
          const tot = Dec.sum(ps.map((x) => Dec.of(x.profit)));
          return `<p class="muted small">Interest this month comes from your investments: ${ps.length ? `<strong class="${tot.isNegative() ? "neg" : "pos"}">${signed(tot, 2)}</strong>` : "nothing logged yet"}. <a href="#/invest/${month}">Log profit / loss →</a></p>`;
        })() : ""}
        <label>Real balance at month end <span class="muted small">(optional; from your bank)</span>
          <input name="balance" inputmode="decimal" value="${esc(checkin?.savingsBalance ? Dec.of(checkin.savingsBalance).toString() : "")}" placeholder="plan: ${esc(money(planned.balance))}">
        </label>
        <label>Note<input name="note" maxlength="500" value="${esc(checkin?.note ?? "")}"></label>
        <div class="totals" id="totals"></div>
        <div class="sticky-save"><button class="btn primary block" type="submit">${checkin ? "Update check-in" : "Save check-in"}</button></div>
        ${checkin ? `<button type="button" class="btn ghost small danger-text clear-month-btn" data-clear-month="${esc(month)}">Clear ${esc(monthLabel(month, true))}…</button>` : ""}
      </form>

      <section class="card">
        <div class="section-head"><h2>Unplanned</h2><button class="btn ghost small" data-add-unplanned>+ Add</button></div>
        ${unplanned.length ? `<ul class="plain-list">${unplanned.map((u) => `
          <li><div><span class="line-name">${esc(u.name)}</span>${u.note ? `<span class="muted small">${esc(u.note)}</span>` : ""}</div>
            <span class="num ${u.kind === "expense" ? "neg" : "pos"}">${u.kind === "expense" ? "-" : "+"}${money(u.amount)}</span>
            <button class="icon-btn danger" data-del-unplanned="${u.id}" aria-label="Delete ${esc(u.name)}">×</button></li>`).join("")}</ul>`
          : `<p class="muted small">Things that weren't in the plan, like a car repair or a gift. They count in this month's actuals.</p>`}
      </section>
    </div>
    `;

  const form = root.querySelector<HTMLFormElement>("#checkin")!;
  if (stash?.month === month) {
    for (const [name, value] of stash.values) {
      if (name.startsWith("radio:")) {
        const r = form.querySelector<HTMLInputElement>(`input[name="${CSS.escape(name.slice(6))}"][value="${CSS.escape(value)}"]`);
        if (r) r.checked = true;
        continue;
      }
      const el = form.querySelector<HTMLInputElement>(`input[name="${CSS.escape(name)}"]`);
      if (el) el.value = value;
    }
  }
  stash = null;
  const inputs = [...form.querySelectorAll<HTMLInputElement>("input[name^='line:']")];
  const unplannedNet = Dec.sum(unplanned.map((u) => (u.kind === "income" ? Dec.of(u.amount) : Dec.of(u.amount).neg())));

  const updateGaps = () => {
    let income = Dec.ZERO;
    let expenses = Dec.ZERO;
    let ok = true;
    for (const input of inputs) {
      const raw = cleanAmount(input.value);
      const gapEl = form.querySelector<HTMLElement>(`[data-gap-for="${CSS.escape(input.name.slice(5))}"]`)!;
      input.classList.toggle("invalid", !AMOUNT_RE.test(raw));
      if (!AMOUNT_RE.test(raw)) {
        ok = false;
        gapEl.textContent = "";
        continue;
      }
      const v = Dec.of(raw);
      const gap = v.minus(input.dataset.planned ?? "0");
      const good = input.dataset.kind === "income" ? !gap.isNegative() : !gap.gt(0);
      gapEl.textContent = gap.round(0).isZero() ? "" : signed(gap);
      gapEl.className = `gap small ${good ? "good" : "bad"}`;
      if (input.dataset.kind === "income") income = income.plus(v);
      else expenses = expenses.plus(v);
    }
    const net = income.minus(expenses).plus(unplannedNet);
    const gap = net.minus(planned.net);
    form.querySelector("#totals")!.innerHTML = ok ? `
      <div class="kv"><span>Net this month</span><strong class="num">${egp(net)}</strong></div>
      <div class="kv"><span>vs plan (${money(planned.net)})</span><strong class="num ${gap.isNegative() ? "neg" : "pos"}">${signed(gap)}</strong></div>` : "";
  };
  updateGaps();
  form.addEventListener("input", updateGaps);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formValues(form);
    const bad = inputs.find((i) => !AMOUNT_RE.test(cleanAmount(i.value)));
    if (bad) {
      formError(form, "Every line needs an amount of 0 or more (max 2 decimals). Put 0 if it didn't happen.");
      bad.focus();
      return;
    }
    const balance = cleanAmount(f.balance ?? "");
    if (balance && !AMOUNT_RE.test(balance)) {
      formError(form, "The bank balance must be a number of 0 or more.");
      return;
    }
    formError(form, null);
    // gold value of that month (pieces owned by then, at today's price) is saved with the month
    const goldNow = ctx.data.goldAuto ? ctx.data.goldValueAt(month) : null;
    await busy(form, async () => {
      try {
        await ctx.api.rpc("save_checkin", {
          p_month: month,
          p_entries: inputs.map((i) => ({ item_key: i.name.slice(5), amount: cleanAmount(i.value) })),
          p_savings_balance: balance || null,
          p_note: (f.note ?? "").trim(),
          ...(goldNow ? { p_gold_value: goldNow.round(2).toString() } : {}),
        }).catch(async (err) => {
          // database without migration 013 doesn't know p_gold_value yet: save without it
          if (goldNow && err instanceof ApiError && err.code === "PGRST202") {
            return ctx.api.rpc("save_checkin", { p_month: month, p_entries: inputs.map((i) => ({ item_key: i.name.slice(5), amount: cleanAmount(i.value) })),
              p_savings_balance: balance || null, p_note: (f.note ?? "").trim() });
          }
          throw err;
        });
        // lines paid with a card: add (or remove) the entry on the card for this month
        for (const i of inputs) {
          const key = i.name.slice(5);
          const via = form.querySelector<HTMLInputElement>(`input[name="via:${CSS.escape(key)}"]:checked`)?.value;
          if (!via) continue;
          await ctx.api.rpc("settle_line", { p_month: month, p_item_key: key, p_amount: cleanAmount(i.value), p_via: via });
        }
        await ctx.reload();
        toast(`${monthLabel(month, true)} saved.`, "ok");
        planReturn.tab = "actual";
        ctx.navigate("#/plan/actual");
      } catch (err) {
        if (err instanceof ApiError && err.kind === "auth") ctx.fail(err);
        else formError(form, err instanceof ApiError ? err.message : "Could not save. Please try again.");
      }
    });
  });

  root.querySelector<HTMLSelectElement>("#month")!.addEventListener("change", (e) => ctx.navigate(`${LOG_BASE}${(e.target as HTMLSelectElement).value}`));
  root.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => b.addEventListener("click", () => ctx.navigate(`${LOG_BASE}${b.dataset.go}`)));
  root.querySelectorAll<HTMLButtonElement>("[data-add-unplanned]").forEach((b) => b.addEventListener("click", () => addUnplanned(ctx, month)));
  root.querySelector<HTMLButtonElement>("[data-clear-month]")?.addEventListener("click", () => openClearMonth(ctx, month));
  root.querySelectorAll<HTMLButtonElement>("[data-del-unplanned]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this item?")) return;
    b.disabled = true;
    try {
      await ctx.api.rpc("delete_unplanned", { p_id: Number(b.dataset.delUnplanned) });
      stashForm(month);
      await ctx.reload();
      toast("Deleted.", "ok");
    } catch (err) {
      b.disabled = false;
      ctx.fail(err);
    }
  }));
}

function addUnplanned(ctx: Ctx, month: Month): void {
  openDialog(`
    <form id="unplanned-form" novalidate>
      <h2>Unplanned item · ${esc(monthLabel(month, true))}</h2>
      <div class="segmented" role="radiogroup" aria-label="Type">
        <label><input type="radio" name="kind" value="expense" checked><span>Expense</span></label>
        <label><input type="radio" name="kind" value="income"><span>Income</span></label>
      </div>
      <label>What was it?<input name="name" maxlength="80" placeholder="e.g. Car repair" required></label>
      <label>Amount (EGP)<input name="amount" inputmode="decimal" required></label>
      <label>Note <span class="muted small">(optional)</span><input name="note" maxlength="500"></label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">Add</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#unplanned-form")!;
    dialog.querySelector<HTMLInputElement>("input[name=name]")?.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      const amount = cleanAmount(f.amount ?? "");
      const problem = !(f.name ?? "").trim() ? "Please enter what it was."
        : !AMOUNT_RE.test(amount) || Dec.of(amount).isZero() ? "Amount must be more than 0 (max 2 decimals)." : null;
      formError(form, problem);
      if (problem) return;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("add_unplanned", { p_month: month, p_kind: f.kind, p_name: (f.name ?? "").trim(), p_amount: amount, p_note: (f.note ?? "").trim() });
          dialog.close();
          stashForm(month);
          await ctx.reload();
          toast("Added.", "ok");
        } catch (err) {
          if (err instanceof ApiError && err.kind === "auth") { dialog.close(); ctx.fail(err); }
          else formError(form, err instanceof ApiError ? err.message : "Could not save. Please try again.");
        }
      });
    });
  });
}

/** Planned vs actual summary for an already logged month (shown at the top of the panel). */
function comparisonSummary(ctx: Ctx, month: Month): string {
  const c = ctx.data.comparisons.find((x) => x.month === month && !x.assumed);
  if (!c) return "";
  const gap = c.net.gap;
  return `<div class="panel-summary">
    <span class="badge ${c.onPlan ? "good" : "bad"}">${c.onPlan ? "On plan" : "Behind plan"}</span>
    <span>Net <strong class="num">${money(c.net.actual)}</strong> vs plan ${money(c.net.planned)}
      <strong class="num ${gap.round(0).isNegative() ? "neg" : gap.round(0).isZero() ? "" : "pos"}">(${gap.round(0).isZero() ? "on plan" : signed(gap)})</strong></span>
    ${c.biggestCause ? `<span class="muted">Biggest cause: ${esc(c.biggestCause.name)} ${signed(c.biggestCause.netEffect)}</span>` : ""}
  </div>`;
}

/**
 * Asks which logged month to clear (or confirms `preset`), then removes its logged amounts,
 * unplanned items and check-in. The plan itself is not changed.
 */
export function openClearMonth(ctx: Ctx, preset?: string): void {
  const months = ctx.data.checkins.map((c) => c.month)
    .concat(ctx.data.unplanned.map((u) => u.month))
    .filter((m, i, all) => all.indexOf(m) === i)
    .sort().reverse();
  if (!months.length) return void toast("No month is logged yet.", "info");
  const first = preset && months.includes(preset) ? preset : months[0]!;
  const what = (m: string) => {
    const lines = ctx.data.entries.get(m)?.size ?? 0;
    const unp = ctx.data.unplanned.filter((u) => u.month === m).length;
    const c = ctx.data.checkins.find((x) => x.month === m);
    const items = [
      `${lines} logged amount${lines === 1 ? "" : "s"}`,
      ...(unp ? [`${unp} unplanned item${unp === 1 ? "" : "s"}`] : []),
      ...(c?.savingsBalance ? ["the bank balance you entered"] : []),
      ...(c?.note ? ["the note"] : []),
      ...(ctx.data.goldByMonth.has(m) ? ["the gold value saved that month"] : []),
    ];
    return `<ul class="clear-list">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
  };
  openDialog(`
    <form id="clear-form" novalidate>
      <h2>${preset ? `Clear ${esc(monthLabel(first, true))}?` : "Clear a month"}</h2>
      ${preset ? `<input type="hidden" name="month" value="${esc(first)}">` : `
      <label>Month<select name="month">${months.map((m) => `<option value="${esc(m)}"${m === first ? " selected" : ""}>${esc(monthLabel(m, true))}</option>`).join("")}</select></label>`}
      <p>This removes:</p>
      <div id="clear-what">${what(first)}</div>
      <p class="muted small">Your plan isn't changed. The month goes back to "not logged" and you can log it again any time. This can't be undone.</p>
      <p class="form-error" hidden></p>
      <div class="dialog-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn danger">Clear month</button></div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#clear-form")!;
    const sel = form.querySelector<HTMLSelectElement>("select[name=month]");
    sel?.addEventListener("change", () => { form.querySelector("#clear-what")!.innerHTML = what(sel.value); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const m = (form.elements.namedItem("month") as HTMLInputElement | HTMLSelectElement).value;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("clear_month", { p_month: m });
          dialog.close();
          planReturn.tab = "actual";
          await ctx.reload();
          if (location.hash.startsWith(LOG_BASE)) ctx.navigate("#/plan/actual");
          toast(`${monthLabel(m, true)} cleared.`, "ok");
        } catch (err) {
          if (err instanceof ApiError && err.kind === "auth") { dialog.close(); ctx.fail(err); }
          else formError(form, err instanceof ApiError ? err.message : "Could not clear the month.");
        }
      });
    });
  });
}
