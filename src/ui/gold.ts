// Gold: holdings, your price per gram, value and profit/loss. Automatic prices arrive with step 5.
import { Dec } from "../engine/decimal.ts";
import { valueHoldings, type Karat } from "../engine/gold.ts";
import { effectivePrices, toHoldings, type HoldingRow, type PriceRow } from "../lib/gold.ts";
import { ApiError } from "../lib/api.ts";
import { emptyState, esc, toast } from "../lib/dom.ts";
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
      emptyState("No gold yet", "Import your pieces from Excel (Gold sheet). Adding pieces by hand comes in step 5.", { href: "#/plan/import", label: "Import from Excel" });
    return;
  }
  const eff = effectivePrices(prices);
  const holdings = toHoldings(owned);
  const summary = valueHoldings(holdings, eff, "0", today());
  const byLabel = new Map(summary.holdings.map((h) => [h.holding, h]));
  const karats = [...new Set(owned.map((r) => r.karat as Karat))].sort((a, b) => b - a);
  const grams = Dec.sum(owned.map((r) => r.grams));
  const priced = summary.missingPrices.length === 0;

  root.innerHTML = `
    <div class="page-head"><div><h1>Gold</h1>
      <p class="muted small">Value = grams × the price a shop pays you per gram. Automatic daily prices arrive in step 5.</p></div>
      <div class="head-actions"><a class="btn ghost" href="#/plan/import">Import from Excel</a></div></div>

    <div class="stats-grid">
      <div class="card stat"><span class="stat-label">Value now</span>
        <span class="stat-value num">${priced ? egp(summary.market) : "–"}</span>
        <span class="small muted">${owned.length} pieces · ${esc(grams.toString())} g</span></div>
      <div class="card stat"><span class="stat-label">Paid</span><span class="stat-value num">${egp(Dec.sum(owned.map((r) => r.purchase_price)))}</span></div>
      <div class="card stat"><span class="stat-label">Profit / loss</span>
        <span class="stat-value num ${priced ? (summary.profitMarket.isNegative() ? "neg" : "pos") : ""}">${priced ? signed(summary.profitMarket) : "–"}</span>
        <span class="small muted">${priced && !summary.cost.isZero() ? `${summary.profitMarket.div(summary.cost).times(100).toFixed(1)}% on what you paid` : "set a price below"}</span></div>
    </div>

    <form class="card price-card" id="prices" novalidate>
      <div class="section-head"><h2>Price per gram</h2></div>
      <p class="muted small">Use the shop <strong>buying</strong> price (what a shop pays you), e.g. from your gold app or a price board.</p>
      <div class="price-rows">
        ${karats.map((k) => {
          const p = prices.find((x) => x.karat === k);
          const when = p?.my_price_at ? `your price, ${dateTime(p.my_price_at)}` : p?.fetched_at ? `${esc(p.source ?? "fetched")}, ${dateTime(p.fetched_at)}` : "not set";
          return `<label class="price-row"><span><strong>${k}K</strong><span class="muted small">${when}</span></span>
            <span class="suffix"><input name="k${k}" inputmode="decimal" value="${esc(p?.my_price ? Dec.of(p.my_price).toString() : "")}" placeholder="${esc(p?.fetched_price ? Dec.of(p.fetched_price).toString() : "e.g. 5900")}"><span>EGP</span></span></label>`;
        }).join("")}
      </div>
      <button class="btn primary" type="submit">Save prices</button>
      <p class="form-error" hidden></p>
    </form>

    <div class="card"><table class="table gold-table">
      <thead><tr><th>Piece</th><th class="num">Karat</th><th class="num">Grams</th><th class="num">Paid</th><th class="num">Value now</th><th class="num">Profit / loss</th><th class="num">Bought</th></tr></thead>
      <tbody>${owned.map((r, i) => {
        const v = byLabel.get(holdings[i]!);
        return `<tr><th scope="row">${esc(r.label)}</th><td class="num" data-label="Karat">${r.karat}K</td>
          <td class="num" data-label="Grams">${esc(Dec.of(r.grams).toString())}</td>
          <td class="num" data-label="Paid">${money(r.purchase_price)}</td>
          <td class="num" data-label="Value">${v ? money(v.market) : "–"}</td>
          <td class="num ${v ? (v.profitMarket.isNegative() ? "neg" : "pos") : ""}" data-label="Profit">${v ? signed(v.profitMarket) : "–"}</td>
          <td class="num" data-label="Bought">${esc(r.purchase_date)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>`;

  const form = root.querySelector<HTMLFormElement>("#prices")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector<HTMLElement>(".form-error")!;
    const changes: { karat: Karat; price: string }[] = [];
    for (const k of karats) {
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
      toast("Prices saved.", "ok");
    } catch (ex) {
      btn.disabled = false;
      if (ex instanceof ApiError && ex.kind === "auth") return ctx.fail(ex);
      err.hidden = false;
      err.textContent = ex instanceof ApiError ? ex.message : "Could not save the prices.";
    }
  });
}
