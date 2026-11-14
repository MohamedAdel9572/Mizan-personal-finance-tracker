import { Dec } from "../engine/decimal.ts";
import { currentMonth, isMonth } from "../engine/month.ts";
import type { PlanVersion } from "../engine/types.ts";
import { ApiError } from "../lib/api.ts";
import { esc, toast } from "../lib/dom.ts";
import { egp, money, monthLabel } from "../lib/format.ts";
import { parseImport, type ParsedImport } from "../lib/importer.ts";
import { defaultEffective, draftFromVersion, draftToPayload, lastPlanMonth, type Draft } from "../lib/planDraft.ts";
import { readXlsx, XlsxError } from "../lib/xlsx.ts";
import type { Ctx } from "./context.ts";

const MAX_BYTES = 5 * 1024 * 1024;

function todayCairo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** Reuse the stable key of a line with the same name and type, so its history stays attached. */
function attachKeys(draft: Draft, latest: PlanVersion | undefined): void {
  if (!latest) return;
  for (const item of draft.items) {
    const same = latest.items.find((i) => i.name.trim().toLowerCase() === item.name.trim().toLowerCase() && i.kind === item.kind);
    if (same) item.key = same.key;
  }
}

/** Same plan as the current version? Then importing must not create a new version. */
function samePlan(a: Draft, b: Draft): boolean {
  const norm = (d: Draft) => JSON.stringify({
    start: d.start,
    horizon: Number(d.horizonMonths),
    opening: Dec.of(d.openingBalance).toString(),
    rates: [...d.rates].map((r) => [r.from, Dec.of(r.rate).toString()]).sort(),
    items: [...d.items]
      .map((i) => [i.kind, i.name.trim().toLowerCase(), i.recurrence, i.recurrence === "recurring" ? i.start : "", i.recurrence === "recurring" ? i.end : "",
        [...i.amounts].map((x) => [x.month, Dec.of(x.amount).toString()]).sort()])
      .sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
  });
  return norm(a) === norm(b);
}

export function renderImport(root: HTMLElement, ctx: Ctx): void {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Import from Excel</h1>
      <p class="muted small">Upload the Mizan template or your own month-by-month sheet. You'll see a preview first; nothing is saved until you confirm.</p></div>
      <div class="head-actions"><a class="btn ghost" href="/Mizan-template.xlsx" download>Download template</a></div>
    </div>
    <div class="card import-drop">
      <label class="file-pick">
        <span class="btn primary">Choose .xlsx file</span>
        <input type="file" id="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      </label>
      <p class="muted small">Works with: the template (Settings, Lines, Actuals, Unplanned, Gold sheets) or a sheet with Income / Installments / Assets sections and months across.</p>
    </div>
    <div id="preview"></div>`;

  const input = root.querySelector<HTMLInputElement>("#file")!;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    const box = root.querySelector<HTMLElement>("#preview")!;
    if (!file) return;
    if (file.size > MAX_BYTES) {
      box.innerHTML = `<div class="alert danger">The file is larger than 5 MB. Is it the right file?</div>`;
      return;
    }
    box.innerHTML = `<div class="loading"><span class="spinner"></span>Reading ${esc(file.name)}…</div>`;
    try {
      const sheets = await readXlsx(await file.arrayBuffer());
      const latest = ctx.data.versions[0]?.version;
      const parsed = parseImport(sheets, { today: todayCairo(), existingLines: latest?.items.map((i) => i.name) ?? [] });
      if (parsed.draft) attachKeys(parsed.draft, latest);
      renderPreview(box, ctx, parsed, file.name, latest);
    } catch (e) {
      console.error(e);
      box.innerHTML = `<div class="alert danger">${esc(e instanceof XlsxError ? e.message : "This file couldn't be read. Save it as .xlsx in Excel and try again.")}</div>`;
    }
  });
}

function renderPreview(box: HTMLElement, ctx: Ctx, p: ParsedImport, fileName: string, latest: PlanVersion | undefined): void {
  const planChanged = p.draft ? !(latest && samePlan(p.draft, draftFromVersion(latest))) : false;
  const nothing = !planChanged && !p.actuals.length && !p.unplanned.length && !p.gold.length;
  const blocked = p.problems.length > 0;
  const d = p.draft;
  const eff = d && latest ? defaultEffective(currentMonth(), latest.effectiveFrom, d.start) : d?.start ?? "";
  const goldGrams = Dec.sum(p.gold.map((g) => g.grams));
  const goldCost = Dec.sum(p.gold.map((g) => g.price));
  const actMonths = new Set(p.actuals.map((a) => a.month));

  box.innerHTML = `
    ${blocked ? `<div class="alert danger" role="alert"><strong>${p.problems.length} ${p.problems.length === 1 ? "problem" : "problems"} to fix in the file, then upload it again:</strong>
      <table class="table problems"><thead><tr><th>Sheet</th><th>Row</th><th>Problem</th></tr></thead><tbody>
      ${p.problems.slice(0, 100).map((x) => `<tr><td>${esc(x.sheet)}</td><td>${x.row ?? "–"}</td><td>${esc(x.message)}</td></tr>`).join("")}
      </tbody></table>${p.problems.length > 100 ? `<p class="small">…and ${p.problems.length - 100} more.</p>` : ""}</div>` : ""}
    ${p.notes.length ? `<div class="notice"><ul class="tight">${p.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
    <div class="stats-grid">
      <div class="card stat"><span class="stat-label">Plan</span>
        ${d ? `<span class="stat-value">${d.items.length} lines</span>
          <span class="small muted">${esc(monthLabel(d.start, true))} – ${esc(monthLabel(lastPlanMonth(d) ?? d.start, true))} · opening ${money(d.openingBalance)} · ${esc(d.rates[0]?.rate ?? "0")}%</span>
          <span class="small">${!planChanged ? "Same as your current plan: no new version." : latest ? `Will be saved as version ${latest.versionNo + 1}.` : "Will be your first plan."}</span>`
        : `<span class="stat-value">–</span><span class="small muted">No plan in this file</span>`}
      </div>
      <div class="card stat"><span class="stat-label">Actuals</span><span class="stat-value">${p.actuals.length}</span><span class="small muted">${actMonths.size} ${actMonths.size === 1 ? "month" : "months"}</span></div>
      <div class="card stat"><span class="stat-label">Unplanned</span><span class="stat-value">${p.unplanned.length}</span><span class="small muted">items</span></div>
      <div class="card stat"><span class="stat-label">Gold</span><span class="stat-value">${p.gold.length} pieces</span><span class="small muted">${goldGrams.toString()} g · paid ${egp(goldCost)}</span></div>
    </div>
    ${d && planChanged ? `<details class="card"><summary><strong>Plan lines</strong></summary>
      <table class="table"><thead><tr><th>Line</th><th>Type</th><th>Months</th><th class="num">Amounts</th></tr></thead><tbody>
      ${d.items.map((i) => `<tr><th scope="row">${esc(i.name)}${i.key ? "" : ' <span class="badge neutral">new</span>'}</th><td>${i.kind}</td>
        <td>${i.recurrence === "one_off" ? "one-off" : `${esc(i.start)} → ${esc(i.end || "no end")}`}</td>
        <td class="num">${i.amounts.map((a) => `${esc(a.month)}: ${money(a.amount)}`).join("<br>")}</td></tr>`).join("")}
      </tbody></table></details>` : ""}
    <form id="confirm" class="card" novalidate>
      ${d && planChanged && latest ? `<label>Use the imported plan from<input type="month" name="effective" value="${esc(eff)}" min="${esc(latest.effectiveFrom)}"></label>
        <p class="muted small">Months before that stay compared with version ${latest.versionNo}.</p>` : ""}
      <button class="btn primary" type="submit" ${blocked || nothing ? "disabled" : ""}>${nothing && !blocked ? "Nothing new to import" : "Import"}</button>
      <p class="form-error" hidden></p>
    </form>`;

  const form = box.querySelector<HTMLFormElement>("#confirm")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (blocked || nothing) return;
    const effective = (form.elements.namedItem("effective") as HTMLInputElement | null)?.value ?? d?.start ?? "";
    const err = form.querySelector<HTMLElement>(".form-error")!;
    if (d && planChanged && latest && (!isMonth(effective) || effective < latest.effectiveFrom)) {
      err.hidden = false;
      err.textContent = `Pick a month from ${monthLabel(latest.effectiveFrom, true)} on.`;
      return;
    }
    const btn = form.querySelector<HTMLButtonElement>("button")!;
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const res = await ctx.api.rpc<{ version_no: number | null; actuals: number; unplanned: number; unplanned_skipped: number; gold: number; gold_skipped: number }>("import_workbook", {
        p_plan: d && planChanged ? draftToPayload(d, effective, `Imported from ${fileName}`.slice(0, 500)) : null,
        p_actuals: p.actuals,
        p_unplanned: p.unplanned,
        p_gold: p.gold,
        p_file_name: fileName,
      });
      await ctx.reload();
      const parts = [
        res.version_no ? `plan version ${res.version_no}` : null,
        res.actuals ? `${res.actuals} actuals` : null,
        res.unplanned ? `${res.unplanned} unplanned` : null,
        res.gold ? `${res.gold} gold pieces` : null,
      ].filter(Boolean);
      const skipped = res.gold_skipped + res.unplanned_skipped;
      toast(`Imported ${parts.join(", ") || "nothing new"}${skipped ? ` (${skipped} already there, skipped)` : ""}.`, "ok");
      ctx.navigate(res.gold && !res.version_no ? "#/gold" : "#/plan");
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = "Import";
      if (ex instanceof ApiError && ex.kind === "auth") return ctx.fail(ex);
      err.hidden = false;
      err.textContent = ex instanceof ApiError ? ex.message : "Import failed. Please try again.";
    }
  });
}
