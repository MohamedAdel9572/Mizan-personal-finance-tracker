// Gold: holdings, your price per gram, value and profit/loss. Automatic prices arrive with step 5.
import { Dec } from "../engine/decimal.ts";
import { KARATS, valueHoldings, type Karat } from "../engine/gold.ts";
import { effectivePrices, toHoldings, type HoldingRow, type PriceRow } from "../lib/gold.ts";
import { getGoldFeed } from "../lib/goldFeed.ts";
import { ApiError } from "../lib/api.ts";
import { busy, emptyState, esc, formError, formValues, openDialog, toast } from "../lib/dom.ts";
import { dateTime, egp, money, signed } from "../lib/format.ts";
import { loadingHtml } from "./shell.ts";
import type { Ctx } from "./context.ts";

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

export function renderGold(root: HTMLElement, ctx: Ctx): void {
  root.innerHTML = `<div class="page-head"><h1>Gold</h1></div>${loadingHtml()}`;
  Promise.all([ctx.api.rpc<HoldingRow[]>("get_gold_holdings"), ctx.api.rpc<PriceRow[]>("get_gold_prices")])
    .then(([rows, prices]) => draw(root, ctx, rows, prices))
    .catch((e) => {
      root.innerHTML = `<div class="page-head"><h1>Gold</h1></div><div class="alert danger">Couldn't load your gold.</div>`;
      ctx.fail(e);
    });
}

function draw(root: HTMLElement, ctx: Ctx, rows: HoldingRow[], prices: PriceRow[]): void {
  const owned = rows.filter((r) => !r.sold_date);
  if (owned.length === 0) {
    root.innerHTML = `<div class="page-head"><h1>Gold</h1></div>` +
      emptyState("No gold yet", "Add your pieces one by one, or import them from Excel (Gold sheet).") +
      `<div class="center quick-actions" style="justify-content:center"><button class="btn primary" id="add-gold">+ Add a piece</button><a class="btn ghost" href="#/plan/import">Import from Excel</a></div>`;
    root.querySelector("#add-gold")!.addEventListener("click", () => editPiece(ctx, null));
    return;
  }
  const feed = ctx.data.goldFeed;
  const eff = effectivePrices(prices, feed);
  const holdings = toHoldings(owned);
  const summary = valueHoldings(holdings, eff, "0", today());
  const byLabel = new Map(summary.holdings.map((h) => [h.holding, h]));
  const karats = [...new Set(owned.map((r) => r.karat as Karat))].sort((a, b) => b - a);
  const grams = Dec.sum(owned.map((r) => r.grams));
  const priced = summary.missingPrices.length === 0;
  const others = KARATS.filter((k) => !karats.includes(k));
  const priceRow = (k: Karat) => {
    const p = prices.find((x) => x.karat === k);
    const auto = feed?.perGram[k];
    const mine = p?.my_price ? Dec.of(p.my_price) : null;
    return `<div class="price-row">
      <span><strong>${k}K</strong>
        <span class="muted small">${mine ? `Using your price (set ${esc(dateTime(p!.my_price_at!))})` : auto ? `Using automatic: <strong>${money(auto)}</strong> EGP` : "No price"}</span>
        ${mine && auto ? `<span class="muted small">Automatic now: ${money(auto)} EGP</span>` : ""}</span>
      <span class="price-input">
        <label class="suffix"><span class="sr-only">Your ${k}K price per gram</span>
          <input name="k${k}" inputmode="decimal" value="${esc(mine ? mine.toString() : "")}" placeholder="Your price (optional)" aria-describedby="price-hint"><span>EGP</span></label>
        ${mine ? `<button type="button" class="btn ghost small" data-auto="${k}">Use automatic</button>` : ""}
      </span>
    </div>`;
  };

  root.innerHTML = `
    <div class="page-head"><div><h1>Gold</h1>
      <p class="muted small">Value = grams × price per gram. The price updates automatically from the internet; you can set your shop's price instead.</p></div>
      <div class="head-actions"><a class="btn ghost" href="#/plan/import">Import from Excel</a><button class="btn primary" id="add-gold">+ Add a piece</button></div></div>

    <div class="stats-grid">
      <div class="card stat"><span class="stat-label">Value now</span>
        <span class="stat-value num${priced ? "" : " muted"}">${priced ? egp(summary.market) : "Needs price"}</span>
        <span class="small muted">${owned.length} pieces · ${esc(grams.toString())} g</span></div>
      <div class="card stat"><span class="stat-label">Paid</span><span class="stat-value num">${egp(Dec.sum(owned.map((r) => r.purchase_price)))}</span></div>
      <div class="card stat"><span class="stat-label">Profit / loss</span>
        <span class="stat-value num ${priced ? (summary.profitMarket.isNegative() ? "neg" : "pos") : "muted"}">${priced ? signed(summary.profitMarket) : "Needs price"}</span>
        <span class="small muted">${priced && !summary.cost.isZero() ? `${summary.profitMarket.div(summary.cost).times(100).toFixed(1)}% on what you paid` : "set a price below"}</span></div>
    </div>

    ${feed?.stale ? `<div class="alert warning" role="status">Couldn't reach the price service. Showing the last price from ${esc(dateTime(feed.fetchedAt))}.</div>` : ""}
    ${!feed && !priced ? `<div class="alert warning" role="status"><strong>Couldn't get the gold price from the internet.</strong> Type today's price per gram below, or try Refresh.</div>` : ""}
    <form class="card price-card${priced ? "" : " needs-price"}" id="prices" novalidate>
      <div class="section-head"><h2>Price per gram</h2>
        <button type="button" class="btn ghost small" id="refresh-price">Refresh</button></div>
      <p class="muted small" id="price-hint">${feed
        ? `Automatic: world gold $${money(feed.spotUsdOz, 2)}/oz × ${esc(Dec.of(feed.usdEgp).toFixed(2))} EGP per USD, updated ${esc(dateTime(feed.goldAt))}. Shops in Egypt are usually within a few percent of this.`
        : "Automatic price not available right now."}
        Type your shop's buying price to use it instead.</p>
      <div class="price-rows">
        ${karats.map((k) => priceRow(k)).join("")}
      </div>
      ${others.length ? `<details class="other-karats"><summary class="small">Other karats (${others.map((k) => `${k}K`).join(", ")})</summary>
        <div class="price-rows">${others.map((k) => priceRow(k)).join("")}</div></details>` : ""}
      <button class="btn primary" type="submit">Save my prices</button>
      <p class="form-error" hidden></p>
    </form>

    <div class="card">
      <div class="section-head gold-head"><h2>Pieces</h2>
        ${owned.length > 1 ? `<label class="inline-select">Set all to<select id="all-karat"><option value="">Karat…</option>${KARATS.map((k) => `<option value="${k}">${k}K</option>`).join("")}</select></label>` : ""}</div>
      <table class="table gold-table">
      <thead><tr><th>Piece</th><th class="num">Karat</th><th class="num">Grams</th><th class="num">Paid</th><th class="num">Value now</th><th class="num">Profit / loss</th><th class="num">Bought</th><th><span class="sr-only">Edit</span></th></tr></thead>
      <tbody>${owned.map((r, i) => {
        const v = byLabel.get(holdings[i]!);
        return `<tr><th scope="row">${esc(r.label)}</th>
          <td class="num" data-label="Karat"><select class="karat-select" data-id="${r.id}" aria-label="Karat of ${esc(r.label)}">
            ${KARATS.map((k) => `<option value="${k}"${k === r.karat ? " selected" : ""}>${k}K</option>`).join("")}</select></td>
          <td class="num" data-label="Grams">${esc(Dec.of(r.grams).toString())}</td>
          <td class="num" data-label="Paid">${money(r.purchase_price)}</td>
          <td class="num${v ? "" : " muted"}" data-label="Value">${v ? money(v.market) : "needs price"}</td>
          <td class="num ${v ? (v.profitMarket.isNegative() ? "neg" : "pos") : "muted"}" data-label="Profit">${v ? signed(v.profitMarket) : "needs price"}</td>
          <td class="num" data-label="Bought">${esc(r.purchase_date)}</td>
          <td class="edit-cell"><button class="btn ghost small" data-edit="${r.id}" aria-label="Edit ${esc(r.label)}">Edit</button></td></tr>`;
      }).join("")}</tbody>
    </table></div>`;

  const save = async (row: HoldingRow, karat: number) => ctx.api.rpc("update_gold_holding", { p_id: row.id, p: {
    label: row.label, karat, grams: row.grams, price: row.purchase_price, date: row.purchase_date } });
  root.querySelector("#add-gold")?.addEventListener("click", () => editPiece(ctx, null));
  root.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) => b.addEventListener("click", () =>
    editPiece(ctx, owned.find((r) => r.id === Number(b.dataset.edit)) ?? null)));
  root.querySelectorAll<HTMLSelectElement>(".karat-select").forEach((sel) => sel.addEventListener("change", async () => {
    const row = owned.find((r) => r.id === Number(sel.dataset.id));
    if (!row) return;
    sel.disabled = true;
    try {
      await save(row, Number(sel.value));
      await ctx.reload();
      toast(`${row.label} is now ${sel.value}K.`, "ok");
    } catch (ex) {
      sel.disabled = false;
      sel.value = String(row.karat);
      ctx.fail(ex);
    }
  }));
  root.querySelector<HTMLSelectElement>("#all-karat")?.addEventListener("change", async (e) => {
    const sel = e.target as HTMLSelectElement;
    const k = Number(sel.value);
    if (!k) return;
    const todo = owned.filter((r) => r.karat !== k);
    if (!todo.length) { sel.value = ""; return toast(`All pieces are already ${k}K.`, "info"); }
    if (!confirm(`Change ${todo.length} ${todo.length === 1 ? "piece" : "pieces"} to ${k}K?`)) { sel.value = ""; return; }
    sel.disabled = true;
    try {
      for (const row of todo) await save(row, k);
      await ctx.reload();
      toast(`${todo.length} ${todo.length === 1 ? "piece" : "pieces"} changed to ${k}K.`, "ok");
    } catch (ex) {
      sel.disabled = false;
      ctx.fail(ex);
    }
  });

  root.querySelector("#refresh-price")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    const fresh = await getGoldFeed(true);
    await ctx.reload();
    toast(fresh && !fresh.stale ? "Gold price updated." : "Couldn't reach the price service.", fresh && !fresh.stale ? "ok" : "error");
  });
  root.querySelectorAll<HTMLButtonElement>("[data-auto]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await ctx.api.rpc("set_gold_price", { p_karat: Number(b.dataset.auto), p_price: "" });
      await ctx.reload();
      toast(`${b.dataset.auto}K now uses the automatic price.`, "ok");
    } catch (ex) {
      b.disabled = false;
      ctx.fail(ex);
    }
  }));

  const form = root.querySelector<HTMLFormElement>("#prices")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector<HTMLElement>(".form-error")!;
    const changes: { karat: Karat; price: string }[] = [];
    for (const k of KARATS) {
      const raw = (form.elements.namedItem(`k${k}`) as HTMLInputElement).value.trim().replace(/[,\s]/g, "");
      const before = prices.find((x) => x.karat === k)?.my_price;
      if (raw && (!AMOUNT_RE.test(raw) || Dec.of(raw).isZero())) {
        err.hidden = false;
        err.textContent = `${k}K: enter a price per gram above 0 (max 2 decimals).`;
        return;
      }
      if ((raw || null) !== (before ? Dec.of(before).toString() : null)) changes.push({ karat: k, price: raw });
    }
    err.hidden = true;
    if (!changes.length) return toast("Nothing changed.", "info");
    const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    btn.disabled = true;
    try {
      for (const c of changes) await ctx.api.rpc("set_gold_price", { p_karat: c.karat, p_price: c.price });
      await ctx.reload();
      toast("Your prices saved.", "ok");
    } catch (ex) {
      btn.disabled = false;
      if (ex instanceof ApiError && ex.kind === "auth") return ctx.fail(ex);
      err.hidden = false;
      err.textContent = ex instanceof ApiError ? ex.message : "Could not save the prices.";
    }
  });
}

/** Add a piece (row = null) or edit one, with delete. */
function editPiece(ctx: Ctx, row: HoldingRow | null): void {
  const t = today();
  openDialog(`
    <form id="piece-form" novalidate>
      <h2>${row ? "Edit piece" : "Add a gold piece"}</h2>
      <label>Name<input name="label" maxlength="80" value="${esc(row?.label ?? "")}" placeholder="e.g. BTC 2.5g bar" required></label>
      <div class="row-2">
        <label>Karat<select name="karat">${KARATS.map((k) => `<option value="${k}"${k === (row?.karat ?? 21) ? " selected" : ""}>${k}K</option>`).join("")}</select></label>
        <label>Grams<input name="grams" inputmode="decimal" value="${esc(row ? Dec.of(row.grams).toString() : "")}" placeholder="2.5" required></label>
      </div>
      <div class="row-2">
        <label>Paid (total EGP)<input name="price" inputmode="decimal" value="${esc(row ? Dec.of(row.purchase_price).toString() : "")}" placeholder="12510" required></label>
        <label>Bought on<input name="date" type="date" max="${t}" value="${esc(row?.purchase_date ?? t)}" required></label>
      </div>
      <div class="dialog-actions">
        ${row ? `<button type="button" class="btn ghost danger-text" id="delete-piece">Delete</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${row ? "Save" : "Add"}</button>
      </div>
    </form>`, (dialog) => {
    const form = dialog.querySelector<HTMLFormElement>("#piece-form")!;
    if (!row) form.querySelector<HTMLInputElement>("input[name=label]")?.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formValues(form);
      const grams = (f.grams ?? "").replace(/[,\s]/g, "");
      const price = (f.price ?? "").replace(/[,\s]/g, "");
      const problem = !(f.label ?? "").trim() ? "Give the piece a name."
        : !/^\d{1,7}(\.\d{1,3})?$/.test(grams) || Dec.of(grams).isZero() ? "Grams must be more than 0 (max 3 decimals)."
        : !/^\d{1,14}(\.\d{1,2})?$/.test(price) ? "Paid must be a number of 0 or more."
        : !f.date || f.date > t ? "Pick a purchase date that isn't in the future." : null;
      formError(form, problem);
      if (problem) return;
      await busy(form, async () => {
        try {
          const p = { label: (f.label ?? "").trim(), karat: Number(f.karat), grams, price, date: f.date };
          if (row) await ctx.api.rpc("update_gold_holding", { p_id: row.id, p });
          else await ctx.api.rpc("add_gold_holding", { p });
          dialog.close();
          await ctx.reload();
          toast(row ? "Piece saved." : "Piece added.", "ok");
        } catch (ex) {
          if (ex instanceof ApiError && ex.kind === "auth") { dialog.close(); ctx.fail(ex); }
          else formError(form, ex instanceof ApiError ? ex.message : "Could not save the piece.");
        }
      });
    });
    dialog.querySelector("#delete-piece")?.addEventListener("click", async () => {
      if (!row || !confirm(`Delete "${row.label}"? This can't be undone.`)) return;
      try {
        await ctx.api.rpc("delete_gold_holding", { p_id: row.id });
        dialog.close();
        await ctx.reload();
        toast("Piece deleted.", "ok");
      } catch (ex) {
        if (ex instanceof ApiError && ex.kind === "auth") { dialog.close(); ctx.fail(ex); }
        else formError(form, ex instanceof ApiError ? ex.message : "Could not delete the piece.");
      }
    });
  });
}
