// Gold holdings list. Live prices, value and profit/loss arrive with step 5.
import { Dec } from "../engine/decimal.ts";
import { emptyState, esc } from "../lib/dom.ts";
import { egp, money } from "../lib/format.ts";
import { loadingHtml } from "./shell.ts";
import type { Ctx } from "./context.ts";

interface Holding { id: number; label: string; karat: number; grams: string; purchase_price: string; purchase_date: string; sold_date: string | null }

export function renderGold(root: HTMLElement, ctx: Ctx): void {
  root.innerHTML = `<div class="page-head"><h1>Gold</h1></div>${loadingHtml()}`;
  ctx.api.rpc<Holding[]>("get_gold_holdings").then((rows) => {
    const owned = rows.filter((r) => !r.sold_date);
    if (owned.length === 0) {
      root.innerHTML = `<div class="page-head"><h1>Gold</h1></div>` +
        emptyState("No gold yet", "Import your pieces from Excel (Gold sheet). Adding pieces by hand and live prices come in step 5.", { href: "#/plan/import", label: "Import from Excel" });
      return;
    }
    const grams = Dec.sum(owned.map((r) => r.grams));
    const cost = Dec.sum(owned.map((r) => r.purchase_price));
    root.innerHTML = `
      <div class="page-head"><div><h1>Gold</h1><p class="muted small">Live prices, current value and profit/loss arrive in step 5.</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/plan/import">Import from Excel</a></div></div>
      <div class="stats-grid">
        <div class="card stat"><span class="stat-label">Pieces</span><span class="stat-value">${owned.length}</span></div>
        <div class="card stat"><span class="stat-label">Weight</span><span class="stat-value num">${esc(grams.toString())} g</span></div>
        <div class="card stat"><span class="stat-label">Paid</span><span class="stat-value num">${egp(cost)}</span></div>
      </div>
      <div class="card"><table class="table">
        <thead><tr><th>Piece</th><th class="num">Karat</th><th class="num">Grams</th><th class="num">Paid (EGP)</th><th class="num">Bought</th></tr></thead>
        <tbody>${owned.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td class="num">${r.karat}K</td><td class="num">${esc(Dec.of(r.grams).toString())}</td>
          <td class="num">${money(r.purchase_price)}</td><td class="num">${esc(r.purchase_date)}</td></tr>`).join("")}</tbody>
      </table></div>`;
  }).catch((e) => {
    root.innerHTML = `<div class="page-head"><h1>Gold</h1></div><div class="alert danger">Couldn't load your gold.</div>`;
    ctx.fail(e);
  });
}
