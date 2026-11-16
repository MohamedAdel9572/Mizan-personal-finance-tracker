// Cards: your credit and debit cards as cards, what's left on each, and the history of
// spends and payments with what was left after every entry.
import { Dec } from "../engine/decimal.ts";
import { currentMonth } from "../engine/month.ts";
import { ApiError } from "../lib/api.ts";
import { CARD_COLORS, cardState, daysUntil, nextDue, type CardRow, type CardsData, type CardState, type LinkMode, type TxnKind, type TxnRow } from "../lib/cards.ts";
import { busy, emptyState, esc, formError, formValues, openDialog, toast } from "../lib/dom.ts";
import { money, monthLabel } from "../lib/format.ts";
import { lineChart, compact } from "./charts.ts";
import { LOG_BASE } from "./log.ts";
import type { Ctx } from "./context.ts";

const AMOUNT_RE = /^\d{1,14}(\.\d{1,2})?$/;
const HEAD = `<div class="page-head"><div><h1>Cards</h1><p class="muted small">Your credit and debit cards, what's left on each, and every spend and payment.</p></div>
  <div class="head-actions"><button class="btn primary" data-add-card>+ Add card</button></div></div>`;

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}
const n2 = (d: Dec) => money(d, d.round(0).eq(d) ? 0 : 2);

export function renderCards(root: HTMLElement, ctx: Ctx): void {
  draw(root, ctx, ctx.data.cards);
}

function draw(root: HTMLElement, ctx: Ctx, data: CardsData): void {
  const month = currentMonth();
  const t = today();
  const reload = () => void ctx.reload();
  if (data.cards.length === 0) {
    root.innerHTML = HEAD + emptyState("No cards yet", "Add a credit card to see its limit, what you've used and what's left, or a debit card to track its balance.");
    wireAdd(root, ctx, reload);
    return;
  }
  const states = data.cards.map((c) => cardState(c, data.txns, month));
  const wanted = Number(ctx.params[0]);
  const sel = states.find((s) => s.card.id === wanted) ?? states[0]!;
  const credits = states.filter((s) => s.limit);

  const totals = credits.length > 1 ? (() => {
    const limit = Dec.sum(credits.map((s) => s.limit!));
    const used = Dec.sum(credits.map((s) => (s.used.isNegative() ? Dec.ZERO : s.used)));
    const util = limit.isZero() ? 0 : used.div(limit).toNumber();
    return `<div class="cards-total">
      <span><small>All credit cards</small><strong>${n2(limit.minus(used))}</strong> <span class="muted small">available of ${n2(limit)}</span></span>
      <span class="ct-bar" aria-hidden="true"><i class="${utilClass(util)}" style="width:${Math.min(100, util * 100).toFixed(1)}%"></i></span>
      <span class="muted small">${Math.round(util * 100)}% used</span>
    </div>`;
  })() : "";

  root.innerHTML = HEAD + totals + `
    <div class="wallet" role="tablist" aria-label="Your cards">${states.map((s) => plastic(s, s === sel)).join("")}</div>
    ${detail(sel, t, linesHtml(ctx, sel))}`;

  wireAdd(root, ctx, reload);
  root.querySelectorAll<HTMLElement>("[data-card]").forEach((b) => b.addEventListener("click", () => {
    ctx.navigate(`#/cards/${b.dataset.card}`);
  }));
  root.querySelector(".pcard.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  root.querySelectorAll<HTMLElement>("[data-txn-kind]").forEach((b) => b.addEventListener("click", () =>
    editTxn(ctx, sel, null, b.dataset.txnKind as TxnKind, reload)));
  root.querySelectorAll<HTMLElement>("[data-txn]").forEach((r) => r.addEventListener("click", () => {
    const line = sel.history.find((h) => h.txn.id === Number(r.dataset.txn));
    if (line) editTxn(ctx, sel, line.txn, line.txn.kind, reload);
  }));
  root.querySelector("[data-edit-card]")?.addEventListener("click", () => editCard(ctx, sel, reload));
  root.querySelector("[data-link-line]")?.addEventListener("click", () => linkLine(ctx, sel.card, reload));
  root.querySelectorAll<HTMLElement>("[data-unlink]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Stop paying this line with this card? Entries already on the card stay.")) return;
    try {
      await ctx.api.rpc("set_card_link", { p_item_key: b.dataset.unlink, p_card_id: null });
      toast("Line unlinked.", "ok");
      reload();
    } catch (e) { ctx.fail(e); }
  }));

  const chartEl = root.querySelector<HTMLElement>("#card-chart");
  if (chartEl) {
    const pts = [...sel.history].reverse();
    const startLeft = sel.limit ? sel.limit.minus(Dec.of(sel.card.opening_balance)) : Dec.of(sel.card.opening_balance);
    lineChart(chartEl, {
      labels: ["Start", ...pts.map((h) => shortDate(h.txn.date))],
      height: 180,
      format: (v) => compact(v),
      zero: false,
      series: [{ name: sel.limit ? "Available" : "Balance", values: [startLeft.toNumber(), ...pts.map((h) => h.after.toNumber())], color: "var(--accent)" }],
    });
  }
}

function utilClass(u: number): string {
  return u >= 0.7 ? "bad" : u >= 0.3 ? "warn" : "good";
}

function shortDate(d: string): string {
  return `${Number(d.slice(8))} ${monthLabel(d.slice(0, 7)).split(" ")[0]}`;
}

/** The card itself, drawn like a plastic card. */
function plastic(s: CardState, on: boolean): string {
  const c = s.card;
  const credit = !!s.limit;
  const pctUsed = credit ? Math.max(0, Math.min(1, s.utilization)) : 0;
  return `
  <button type="button" class="pcard pc-${esc(c.color)}${on ? " on" : ""}" data-card="${c.id}" role="tab" aria-selected="${on}">
    <span class="pc-top"><span class="pc-bank">${esc(c.bank || (credit ? "Credit card" : "Debit card"))}</span><span class="pc-kind">${credit ? "Credit" : "Debit"}</span></span>
    <span class="pcard-chip" aria-hidden="true"></span>
    <span class="pc-num"><span>••••</span><span>••••</span><span>••••</span><span>${esc(c.last4 ?? "••••")}</span></span>
    <span class="pc-bottom">
      <span class="pc-name">${esc(c.name)}</span>
      <span class="pc-amt"><small>${credit ? "Available" : "Balance"}</small>${n2(s.available)}</span>
    </span>
    ${credit ? `<span class="pc-bar" aria-hidden="true"><i style="width:${(pctUsed * 100).toFixed(1)}%"></i></span>` : ""}
  </button>`;
}

function ring(u: number): string {
  const r = 34;
  const len = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(1, u));
  return `<svg class="ring" viewBox="0 0 84 84" width="84" height="84" aria-hidden="true">
    <circle cx="42" cy="42" r="${r}" class="ring-bg"/>
    <circle cx="42" cy="42" r="${r}" class="ring-fg ${utilClass(u)}" stroke-dasharray="${(len * shown).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 42 42)"/>
    <text x="42" y="47" text-anchor="middle">${Math.round(u * 100)}%</text>
  </svg>`;
}

function detail(s: CardState, t: string, lines: string): string {
  const c = s.card;
  const credit = !!s.limit;
  const due = credit && c.due_day ? nextDue(c.due_day, t) : null;
  const dueDays = due ? daysUntil(due, t) : 0;
  const stats = credit ? `
    <div class="cd-gauge">${ring(s.utilization)}<span><small>Used</small><strong>${n2(s.used.isNegative() ? Dec.ZERO : s.used)}</strong><span class="muted small">of ${n2(s.limit!)} limit</span></span></div>
    <div class="stat"><span class="stat-label">Available</span><span class="cd-big">${n2(s.available)}</span>${s.used.isNegative() ? `<span class="small good-text">${n2(s.used.neg())} in your favour</span>` : ""}</div>
    <div class="stat"><span class="stat-label">Spent this month</span><span class="cd-big">${n2(s.spentThisMonth)}</span><span class="muted small">Paid ${n2(s.inThisMonth)}</span></div>
    <div class="stat"><span class="stat-label">Payment due</span><span class="cd-big">${due ? shortDate(due) : "–"}</span><span class="muted small">${due ? (dueDays === 0 ? "Today" : `In ${dueDays} day${dueDays === 1 ? "" : "s"}`) : "Set a due day in Edit card"}</span></div>`
    : `
    <div class="stat"><span class="stat-label">Balance</span><span class="cd-big${s.available.isNegative() ? " bad-text" : ""}">${n2(s.available)}</span></div>
    <div class="stat"><span class="stat-label">Spent this month</span><span class="cd-big">${n2(s.spentThisMonth)}</span></div>
    <div class="stat"><span class="stat-label">In this month</span><span class="cd-big">${n2(s.inThisMonth)}</span></div>`;

  let lastMonth = "";
  const rows = s.history.map((h) => {
    const m = h.txn.date.slice(0, 7);
    const head = m !== lastMonth ? `<li class="tx-month">${esc(monthLabel(m, true))}</li>` : "";
    lastMonth = m;
    const label = h.txn.note || (h.txn.kind === "spend" ? "Spend" : h.txn.kind === "refund" ? "Refund" : credit ? "Payment" : "Deposit");
    const kindWord = h.txn.kind === "spend" ? "Spend" : h.txn.kind === "refund" ? "Refund" : credit ? "Payment" : "Deposit";
    return `${head}<li><button type="button" class="tx" data-txn="${h.txn.id}">
      <span class="tx-icon ${h.txn.kind}" aria-hidden="true">${h.txn.kind === "spend" ? "↗" : "↙"}</span>
      <span class="tx-main"><span class="tx-label">${esc(label)}</span><span class="tx-sub">${shortDate(h.txn.date)} · ${kindWord}</span></span>
      <span class="tx-amt ${h.effect.isNegative() ? "out" : "in"}">${h.effect.isNegative() ? "−" : "+"}${n2(h.effect.abs())}</span>
      <span class="tx-after"><small>${credit ? "Available" : "Balance"}</small>${n2(h.after)}</span>
    </button></li>`;
  }).join("");

  const before = credit ? s.limit!.minus(Dec.of(c.opening_balance)) : Dec.of(c.opening_balance);
  const start = `Balance before these entries: ${n2(before)}. To correct the balance, type the current one in Edit card`;

  return `
  <section class="card-detail">
    <div class="cd-head">
      <h2>${esc(c.name)}${c.last4 ? ` <span class="muted small">•••• ${esc(c.last4)}</span>` : ""}</h2>
      <div class="cd-actions">
        <button class="btn primary small" data-txn-kind="spend">− Spend</button>
        <button class="btn ghost small" data-txn-kind="payment">+ ${credit ? "Pay bill" : "Deposit"}</button>
        <button class="btn ghost small" data-txn-kind="refund">Refund</button>
        <button class="btn ghost small" data-edit-card>Edit card</button>
      </div>
    </div>
    <div class="cd-stats${credit ? "" : " debit"}">${stats}</div>
    ${lines}
    ${s.history.length >= 2 ? `<div class="card chart-card"><h3>${credit ? "Available" : "Balance"} over time</h3><div class="chart" id="card-chart"></div></div>` : ""}
    <div class="card tx-card">
      <h3>History</h3>
      ${s.history.length ? `<ul class="tx-list">${rows}</ul>` : `<p class="muted small">No entries yet. Add a spend or a ${credit ? "payment" : "deposit"} and it shows here with what's left after it.</p>`}
      <p class="muted small tx-start">${start}.</p>
    </div>
  </section>`;
}

function wireAdd(root: HTMLElement, ctx: Ctx, reload: () => void): void {
  root.querySelector("[data-add-card]")?.addEventListener("click", () => editCard(ctx, null, reload));
}

function fail(ctx: Ctx, dialog: HTMLDialogElement, form: HTMLFormElement, ex: unknown, fallback: string): void {
  if (ex instanceof ApiError && ex.kind === "auth") { dialog.close(); ctx.fail(ex); }
  else formError(form, ex instanceof ApiError ? ex.message : fallback);
}

/** Add a card (card = null) or edit one, with delete. */
/**
 * Add a card (state = null) or edit one, with delete. You type the current balance (what you can
 * spend now); the database keeps the starting point before the history, so it's worked out here:
 *   credit: already used before the entries = limit + net effect of the entries - current balance
 *   debit:  balance before the entries      = current balance - net effect of the entries
 */
function editCard(ctx: Ctx, state: CardState | null, reload: () => void): void {
  const card = state?.card ?? null;
  const kind = card?.kind ?? "credit";
  const net = state ? Dec.sum(state.history.map((h) => h.effect)) : Dec.ZERO;
  const colors = CARD_COLORS.map((c) => `<label class="swatch pc-${c}"><input type="radio" name="color" value="${c}"${(card?.color ?? "indigo") === c ? " checked" : ""}><span class="sr-only">${c}</span></label>`).join("");
  openDialog(`
    <form id="card-form" novalidate>
      <h2>${card ? "Edit card" : "Add a card"}</h2>
      ${card ? "" : `<div class="seg kind-seg" role="radiogroup" aria-label="Card type">
        <label><input type="radio" name="kind" value="credit" checked><span>Credit card</span></label>
        <label><input type="radio" name="kind" value="debit"><span>Debit card</span></label></div>`}
      <div class="row-2">
        <label>Name<input name="name" maxlength="60" value="${esc(card?.name ?? "")}" placeholder="CIB Visa Platinum" required></label>
        <label>Bank <span class="muted small">(optional)</span><input name="bank" maxlength="60" value="${esc(card?.bank ?? "")}" placeholder="CIB"></label>
      </div>
      <div class="row-2">
        <label>Last 4 digits <span class="muted small">(optional)</span><input name="last4" inputmode="numeric" maxlength="4" pattern="\\d{4}" value="${esc(card?.last4 ?? "")}" placeholder="4417"></label>
        <label class="only-credit">Payment due day <span class="muted small">(optional)</span><input name="due_day" inputmode="numeric" maxlength="2" value="${esc(card?.due_day ?? "")}" placeholder="25"></label>
      </div>
      <div class="row-2">
        <label class="only-credit">Credit limit (EGP)<input name="credit_limit" inputmode="decimal" data-num="money" value="${esc(card?.credit_limit ? Dec.of(card.credit_limit).toString() : "")}" placeholder="50000"></label>
        <label><span class="lbl-credit">Current balance (EGP)</span><span class="lbl-debit">Current balance (EGP)</span><input name="current" inputmode="decimal" data-num="money" value="${esc(state ? state.available.round(2).toString() : "")}" placeholder="${kind === "credit" ? "same as the limit if unused" : "0"}"></label>
      </div>
      <p class="muted small form-hint">Current balance is what you can spend now, as your bank app shows it.</p>
      <fieldset class="swatches"><legend>Colour</legend>${colors}</fieldset>
      <p class="muted small">Only the last 4 digits are saved. Never type the full card number.</p>
      <div class="dialog-actions">
        ${card ? `<button type="button" class="btn ghost danger-text" id="delete-card">Delete</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${card ? "Save" : "Add card"}</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#card-form")!;
    const sync = () => form.dataset.kind = (form.querySelector<HTMLInputElement>("input[name=kind]:checked")?.value ?? kind);
    sync();
    form.addEventListener("change", sync);
    if (!card) form.querySelector<HTMLInputElement>("input[name=name]")?.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      const k = form.dataset.kind!;
      const lim = (f.credit_limit ?? "").replace(/[,\s]/g, "");
      const cur = (f.current ?? "").replace(/[,\s]/g, "");
      const curOk = AMOUNT_RE.test(cur);
      // empty current balance on a new credit card = nothing used yet
      const current = curOk ? Dec.of(cur) : k === "credit" && !cur && AMOUNT_RE.test(lim) ? Dec.of(lim) : null;
      const opening = current === null ? null
        : k === "credit" ? (AMOUNT_RE.test(lim) ? Dec.of(lim).plus(net).minus(current) : Dec.ZERO)
        : current.minus(net);
      const open = opening ? opening.round(2).toString() : "0";
      const last4 = (f.last4 ?? "").trim();
      const due = (f.due_day ?? "").trim();
      const problem = !(f.name ?? "").trim() ? "Give the card a name."
        : last4 && !/^\d{4}$/.test(last4) ? "Last 4 digits must be exactly 4 numbers."
        : k === "credit" && (!AMOUNT_RE.test(lim) || Dec.of(lim).isZero()) ? "Credit limit must be more than 0."
        : current === null ? "Current balance must be a number of 0 or more."
        : opening!.isNegative() ? (k === "credit"
            ? `Current balance can't be more than ${n2(Dec.of(lim).plus(net))} with the entries in this card's history.`
            : `Current balance can't be less than ${n2(net)} with the entries in this card's history.`)
        : k === "credit" && due && (!/^\d{1,2}$/.test(due) || Number(due) < 1 || Number(due) > 31) ? "Payment due day must be from 1 to 31."
        : null;
      formError(form, problem);
      if (problem) return;
      await busy(form, async () => {
        try {
          const id = await ctx.api.rpc<number>("save_card", { p_id: card?.id ?? null, p: {
            name: (f.name ?? "").trim(), bank: (f.bank ?? "").trim(), kind: k, last4, color: f.color ?? "indigo",
            credit_limit: k === "credit" ? lim : "", opening_balance: open, due_day: k === "credit" ? due : "",
          } });
          dialog.close();
          toast(card ? "Card saved." : "Card added.", "ok");
          await ctx.reload();
          if (!card) ctx.navigate(`#/cards/${id}`);
        } catch (ex) { fail(ctx, dialog, form, ex, "Could not save the card."); }
      });
    });
    dialog.querySelector("#delete-card")?.addEventListener("click", async () => {
      if (!card || !confirm(`Delete "${card.name}" and all its history? This can't be undone.`)) return;
      try {
        await ctx.api.rpc("delete_card", { p_id: card.id });
        dialog.close();
        toast("Card deleted.", "ok");
        await ctx.reload();
        ctx.navigate("#/cards");
      } catch (ex) { fail(ctx, dialog, form, ex, "Could not delete the card."); }
    });
  });
}

/** Add an entry (txn = null) or edit one, with delete. */
function editTxn(ctx: Ctx, s: CardState, txn: TxnRow | null, kind: TxnKind, reload: () => void): void {
  const credit = !!s.limit;
  const t = today();
  const word = (k: TxnKind) => (k === "spend" ? "Spend" : k === "refund" ? "Refund" : credit ? "Payment" : "Deposit");
  // paying a credit card bill: start with everything used; change it for a part payment
  const billDue = !txn && credit && kind === "payment" && s.used.gt(0) ? s.used : null;
  openDialog(`
    <form id="txn-form" novalidate>
      <h2>${txn ? "Edit entry" : `${word(kind)} · ${esc(s.card.name)}`}</h2>
      <div class="seg kind-seg" role="radiogroup" aria-label="Type">
        ${(["spend", "payment", "refund"] as const).map((k) => `<label><input type="radio" name="kind" value="${k}"${k === kind ? " checked" : ""}><span>${word(k)}</span></label>`).join("")}
      </div>
      <div class="row-2">
        <label>Amount (EGP)<input name="amount" inputmode="decimal" data-num="money" value="${esc(txn ? Dec.of(txn.amount).toString() : billDue ? billDue.round(2).toString() : "")}" placeholder="0" required></label>
        <label>Date<input name="date" type="date" max="${t}" value="${esc(txn?.date ?? t)}" required></label>
      </div>
      <label>Note <span class="muted small">(optional)</span><input name="note" maxlength="120" value="${esc(txn?.note ?? "")}" placeholder="${kind === "spend" ? "Carrefour" : credit ? "November bill" : "Salary"}"></label>
      ${billDue ? `<p class="muted small">Filled with the full amount used (${n2(billDue)}). Change it to pay part of the bill.</p>` : ""}
      ${txn?.item_key ? `<p class="notice small">This entry pays a plan line for ${esc(monthLabel(txn.month ?? txn.date.slice(0, 7), true))}. Changing the amount on the Log page changes it here too.</p>` : ""}
      <p class="muted small" id="txn-preview"></p>
      <div class="dialog-actions">
        ${txn ? `<button type="button" class="btn ghost danger-text" id="delete-txn">Delete</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${txn ? "Save" : "Add"}</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#txn-form")!;
    const amountInput = form.querySelector<HTMLInputElement>("input[name=amount]")!;
    if (!txn) amountInput.focus();
    const preview = () => {
      const f = formValues(form);
      const amt = (f.amount ?? "").replace(/[,\s]/g, "");
      const p = form.querySelector<HTMLElement>("#txn-preview")!;
      if (!AMOUNT_RE.test(amt)) { p.textContent = ""; return; }
      const old = txn ? (txn.kind === "spend" ? Dec.of(txn.amount).neg() : Dec.of(txn.amount)) : Dec.ZERO;
      const eff = f.kind === "spend" ? Dec.of(amt).neg() : Dec.of(amt);
      const after = s.available.minus(old).plus(eff);
      p.innerHTML = `${credit ? "Available" : "Balance"} after this: <strong class="${after.isNegative() ? "bad-text" : ""}">${n2(after)}</strong>${credit && after.isNegative() ? " (over the limit)" : ""}`;
    };
    form.addEventListener("input", preview);
    form.addEventListener("change", preview);
    preview();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      const amt = (f.amount ?? "").replace(/[,\s]/g, "");
      const problem = !AMOUNT_RE.test(amt) || Dec.of(amt).isZero() ? "Amount must be more than 0."
        : !f.date || f.date > t ? "Pick a date that isn't in the future." : null;
      formError(form, problem);
      if (problem) return;
      await busy(form, async () => {
        try {
          await ctx.api.rpc("save_card_txn", { p_id: txn?.id ?? null, p: { card_id: s.card.id, kind: f.kind, amount: amt, date: f.date, note: (f.note ?? "").trim() } });
          dialog.close();
          toast(txn ? "Entry saved." : "Added.", "ok");
          reload();
        } catch (ex) { fail(ctx, dialog, form, ex, "Could not save."); }
      });
    });
    dialog.querySelector("#delete-txn")?.addEventListener("click", async () => {
      if (!txn || !confirm("Delete this entry?")) return;
      try {
        await ctx.api.rpc("delete_card_txn", { p_id: txn.id });
        dialog.close();
        toast("Entry deleted.", "ok");
        reload();
      } catch (ex) { fail(ctx, dialog, form, ex, "Could not delete."); }
    });
  });
}

/** Plan lines paid with this card, with this month's status. */
function linesHtml(ctx: Ctx, s: CardState): string {
  const t = ctx.data.timeline;
  if (!t) return "";
  const month = currentMonth();
  const mine = ctx.data.cards.links.filter((l) => l.card_id === s.card.id);
  const planned = t.planned(month);
  const rows = mine.map((l) => {
    const info = t.lineInfo(l.item_key);
    const amt = planned?.lines.get(l.item_key) ?? Dec.ZERO;
    const onCard = ctx.data.cards.txns.find((x) => x.item_key === l.item_key && x.month === month);
    const logged = ctx.data.entries.get(month)?.get(l.item_key);
    const status = amt.isZero() && !logged ? `<span class="pill muted-pill">Nothing this month</span>`
      : onCard ? `<span class="pill ok-pill">${l.mode === "installment" ? "Paid" : "Charged"} ${n2(Dec.of(onCard.amount))}</span>`
      : logged ? `<span class="pill muted-pill">Paid cash</span>`
      : `<span class="pill due-pill">Due ${n2(amt)}</span>`;
    return `<li class="ln">
      <span class="ln-main"><span class="ln-name">${esc(info?.name ?? "Removed line")}</span>
        <span class="muted small">${l.mode === "installment" ? "Installment: each payment adds back to what's available" : "Charged to the card every month"}</span></span>
      ${status}
      <button type="button" class="icon-btn danger" data-unlink="${esc(l.item_key)}" aria-label="Unlink ${esc(info?.name ?? "line")}">×</button>
    </li>`;
  }).join("");
  const anyDue = mine.some((l) => !ctx.data.cards.txns.some((x) => x.item_key === l.item_key && x.month === month)
    && !ctx.data.entries.get(month)?.get(l.item_key) && !(planned?.lines.get(l.item_key) ?? Dec.ZERO).isZero());
  return `<div class="card lines-card">
    <div class="section-head"><h3>Plan lines on this card</h3><button type="button" class="btn ghost small" data-link-line>+ Link a line</button></div>
    ${mine.length ? `<ul class="ln-list">${rows}</ul>
      <p class="muted small ln-foot">Each month, the Log page asks if these were paid with this card or cash.
        ${anyDue ? `<a href="${LOG_BASE}${month}">Log ${esc(monthLabel(month, true))} →</a>` : ""}</p>`
      : `<p class="muted small">Link a plan line (like an installment or a subscription) and the Log page will add it to this card when you log the month.</p>`}
  </div>`;
}

function linkLine(ctx: Ctx, card: CardRow, reload: () => void): void {
  const latest = ctx.data.versions[0]?.version;
  const expenses = latest?.items.filter((i) => i.kind === "expense") ?? [];
  if (!expenses.length) { toast("Add expense lines to your plan first.", "info"); return; }
  // a line belongs to one card: lines already linked are hidden until they're unlinked
  const linked = new Set(ctx.data.cards.links.map((l) => l.item_key));
  const lines = expenses.filter((i) => !linked.has(i.key));
  if (!lines.length) { toast("Every expense line is already linked to a card. Unlink one first.", "info"); return; }
  openDialog(`
    <form id="link-form" novalidate>
      <h2>Link a plan line to ${esc(card.name)}</h2>
      <label>Plan line<select name="item">${lines.map((i) => `<option value="${esc(i.key)}">${esc(i.name)}</option>`).join("")}</select></label>
      ${linked.size ? `<p class="muted small">Lines already on a card aren't listed. Unlink them there first.</p>` : ""}
      <fieldset class="link-modes"><legend>How the card is used</legend>
        <label class="radio-card"><input type="radio" name="mode" value="installment" checked>
          <span><strong>Installment</strong><span class="muted small">The full price is already taken from the limit. Each month's payment adds it back (e.g. a tablet on installments).</span></span></label>
        ${card.kind === "credit" ? `<label class="radio-card"><input type="radio" name="mode" value="monthly">
          <span><strong>Charged monthly</strong><span class="muted small">The card is charged every month (e.g. a subscription). You pay the bill later with Pay bill.</span></span></label>` : ""}
      </fieldset>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">Link</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#link-form")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      if (!f.item) return formError(form, "Pick a plan line.");
      await busy(form, async () => {
        try {
          await ctx.api.rpc("set_card_link", { p_item_key: f.item, p_card_id: card.id, p_mode: (f.mode ?? "installment") as LinkMode });
          dialog.close();
          toast("Line linked.", "ok");
          reload();
        } catch (ex) { fail(ctx, dialog, form, ex, "Could not link the line."); }
      });
    });
  });
}
