/**
 * Turns an uploaded workbook (the Mizan template) into a plan draft, actuals,
 * unplanned items and gold holdings, with a problem list that names the sheet
 * and row of every mistake. Nothing is saved here: the Import screen shows the
 * preview and the user confirms.
 */
import { Dec } from "../engine/decimal.ts";
import { isMonth } from "../engine/month.ts";
import { validateDraft, type Draft, type DraftItem } from "./planDraft.ts";
import { serialToIso, type Sheet } from "./xlsx.ts";

export interface ImportProblem {
  sheet: string;
  row: number | null;
  message: string;
}

export interface ImportActual { row: number; month: string; line: string; amount: string; note: string }
export interface ImportUnplanned { row: number; month: string; kind: "income" | "expense"; name: string; amount: string; note: string }
export interface ImportGold { row: number; label: string; karat: 24 | 21 | 18; grams: string; price: string; date: string }

export interface ParsedImport {
  draft: Draft | null;
  /** first sheet row of each draft item, for pointing at problems */
  itemRows: number[];
  actuals: ImportActual[];
  unplanned: ImportUnplanned[];
  gold: ImportGold[];
  problems: ImportProblem[];
  /** non-blocking remarks shown in the preview (what was detected and assumed) */
  notes: string[];
  /** "template" = Mizan template, "grid" = month-columns sheet like the original Excel */
  source: "template" | "grid" | "none";
}

export interface ImportOptions {
  /** today in Cairo, YYYY-MM-DD */
  today: string;
  /** names of lines in the current plan (used when the file has no Lines) */
  existingLines: string[];
}

type Cell = { value: string | number | boolean | null; raw: string } | undefined;

const AMOUNT_RE = /^\d{1,14}(\.\d{1,2})?$/;
const GRAMS_RE = /^\d{1,7}(\.\d{1,3})?$/;

function get(sheet: Sheet, ref: string): Cell {
  return sheet.cells.get(ref);
}

function textOf(c: Cell): string {
  return c?.value == null ? "" : String(c.raw || c.value).trim();
}

function isEmptyRow(sheet: Sheet, row: number, cols: string): boolean {
  return [...cols].every((col) => textOf(get(sheet, `${col}${row}`)) === "");
}

/** Excel date serial, "2027-03", "2027-3", "03/2027", "1/3/2027" -> "2027-03" */
export function monthOf(c: Cell): string | null {
  if (c?.value == null) return null;
  if (typeof c.value === "number") return serialToIso(c.value)?.slice(0, 7) ?? null;
  const s = String(c.value).trim();
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (m) return norm(m[1]!, m[2]!);
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return norm(m[2]!, m[1]!);
  m = /^\d{1,2}[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); // dd/mm/yyyy
  if (m) return norm(m[2]!, m[1]!);
  return null;
  function norm(y: string, mo: string): string | null {
    const out = `${y}-${mo.padStart(2, "0")}`;
    return isMonth(out) ? out : null;
  }
}

/** Excel date serial, "2025-03-21", "21/03/2025" -> "2025-03-21" */
export function dateOf(c: Cell): string | null {
  if (c?.value == null) return null;
  if (typeof c.value === "number") return serialToIso(c.value);
  const s = String(c.value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return valid(m[3]!, m[2]!, m[1]!);
  return null;
  function valid(y: string, mo: string, d: string): string | null {
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const t = new Date(iso + "T00:00:00Z");
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
  }
}

/** Exact amount text, or null. Accepts "12,510" and "EGP 12,510". */
export function amountOf(c: Cell, re = AMOUNT_RE): string | null {
  if (c?.value == null) return null;
  const s = textOf(c).replace(/egp|ج\.?م|جنيه/gi, "").replace(/[,\s]/g, "");
  if (!re.test(s)) return null;
  return Dec.of(s).toString();
}

function kindOf(c: Cell): "income" | "expense" | "asset" | null {
  const s = textOf(c).toLowerCase();
  if (s === "income") return "income";
  if (s === "expense" || s === "expenses" || s === "installment" || s === "installments") return "expense";
  if (s === "asset" || s === "assets") return "asset";
  return null;
}

function repeatsOf(c: Cell): "recurring" | "one_off" | null {
  const s = textOf(c).toLowerCase().replace(/[\s_-]/g, "");
  if (s === "everymonth" || s === "monthly" || s === "recurring" || s === "") return s === "" ? null : "recurring";
  if (s === "oneoff" || s === "once") return "one_off";
  return null;
}

export function parseImport(sheets: Sheet[], opts: ImportOptions): ParsedImport {
  const problems: ImportProblem[] = [];
  const find = (name: string) => sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  const out: ParsedImport = { draft: null, itemRows: [], actuals: [], unplanned: [], gold: [], problems, notes: [], source: "none" };
  const todayMonth = opts.today.slice(0, 7);

  // ---------- Lines + Settings -> plan draft ----------
  const lines = find("Lines");
  const settings = find("Settings");
  let groups = new Map<string, Group>();
  let gridSettings: GridSettings | null = null;
  if (lines) out.source = "template";
  if (!lines) {
    const grid = sheets.map((sh) => readGrid(sh)).find((g) => g !== null);
    if (grid) {
      out.source = "grid";
      groups = grid.groups;
      gridSettings = grid.settings;
      problems.push(...grid.problems);
      out.notes.push(...grid.notes);
    }
  }
  if (lines) {
    for (let r = 2; r <= lines.maxRow; r++) {
      if (isEmptyRow(lines, r, "ABCDEF")) continue;
      const p = (message: string) => problems.push({ sheet: "Lines", row: r, message });
      const kind = kindOf(get(lines, `A${r}`));
      const name = textOf(get(lines, `B${r}`));
      const rec = repeatsOf(get(lines, `C${r}`));
      const from = monthOf(get(lines, `D${r}`));
      const untilCell = get(lines, `E${r}`);
      const until = untilCell?.value == null ? "" : monthOf(untilCell);
      const amount = amountOf(get(lines, `F${r}`));
      let ok = true;
      if (!kind) { p(`Type "${textOf(get(lines, `A${r}`))}" is unknown. Use Income, Expense or Asset.`); ok = false; }
      if (!name) { p("Name is empty."); ok = false; } else if (name.length > 80) { p("Name is longer than 80 characters."); ok = false; }
      if (!rec) { p(`Repeats "${textOf(get(lines, `C${r}`))}" is unknown. Use Every month or One-off.`); ok = false; }
      if (!from) { p(`From "${textOf(get(lines, `D${r}`))}" is not a valid month.`); ok = false; }
      if (until === null) { p(`Until "${textOf(untilCell)}" is not a valid month.`); ok = false; }
      if (amount === null) {
        const t = textOf(get(lines, `F${r}`));
        p(t.startsWith("-") ? "Amount can't be negative." : `Amount "${t}" is not valid (0 or more, max 2 decimals).`);
        ok = false;
      }
      if (from && until && until < from) { p(`Until (${until}) is before From (${from}).`); ok = false; }
      if (kind === "asset" && rec === "one_off") { p("Assets must repeat Every month."); ok = false; }
      if (!ok || !kind || !rec || !from || amount === null || until === null) continue;

      const key = name.toLowerCase();
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { name, kind, rec, until, rows: [r], amounts: [{ month: from, amount, row: r }] });
        continue;
      }
      if (g.kind !== kind) { p(`"${name}" is ${g.kind} on row ${g.rows[0]} but ${kind} here.`); continue; }
      if (g.rec !== rec) { p(`"${name}" repeats differently than on row ${g.rows[0]}.`); continue; }
      if (until && g.until && until !== g.until) { p(`"${name}" has a different Until than on row ${g.rows[0]}.`); continue; }
      if (g.amounts.some((a) => a.month === from)) { p(`"${name}" already has an amount for ${from}.`); continue; }
      if (until && !g.until) g.until = until;
      g.rows.push(r);
      g.amounts.push({ month: from, amount, row: r });
    }
  }

  if (groups.size > 0) {
    if (!settings && !gridSettings) problems.push({ sheet: "Settings", row: null, message: "The Settings sheet is missing." });
    const s = gridSettings ? undefined : settings;
    const start = gridSettings ? gridSettings.start : s ? monthOf(get(s, "B3")) : null;
    const horizonText = gridSettings ? String(gridSettings.horizon) : s ? textOf(get(s, "B4")) : "";
    const opening = gridSettings ? gridSettings.opening : s ? amountOf(get(s, "B5")) : null;
    if (s && !start) problems.push({ sheet: "Settings", row: 3, message: "Start month is missing or not a valid month." });
    if (s && !/^\d{1,3}$/.test(horizonText)) problems.push({ sheet: "Settings", row: 4, message: "Horizon must be a whole number of months." });
    if (s && opening === null) problems.push({ sheet: "Settings", row: 5, message: "Opening savings balance must be a number of 0 or more." });

    const rates: { from: string; rate: string }[] = gridSettings ? [{ from: gridSettings.start, rate: gridSettings.ratePct }] : [];
    if (s) {
      for (let r = 10; r <= Math.max(10, s.maxRow); r++) {
        if (isEmptyRow(s, r, "AB")) continue;
        const from = monthOf(get(s, `A${r}`));
        const rc = get(s, `B${r}`);
        let rate: string | null = null;
        const rt = textOf(rc).replace("%", "").trim();
        if (/^\d{1,3}(\.\d{1,8})?$/.test(rt)) {
          const d = Dec.of(rt);
          // 0.17 (a % formatted cell) means 17%; 17 also means 17%
          rate = (typeof rc?.value === "number" && d.lte(1) ? d.times(100) : d).round(4).toString();
        }
        if (!from) problems.push({ sheet: "Settings", row: r, message: "Rate month is not a valid month." });
        if (rate === null || Dec.of(rate).gt(100)) problems.push({ sheet: "Settings", row: r, message: `Rate "${textOf(rc)}" must be between 0% and 100%.` });
        if (from && rate !== null) rates.push({ from, rate });
      }
    }

    const items: DraftItem[] = [];
    for (const g of groups.values()) {
      const amounts = [...g.amounts].sort((a, b) => a.month.localeCompare(b.month)).map(({ month, amount }) => ({ month, amount }));
      items.push({
        key: "",
        kind: g.kind,
        name: g.name,
        recurrence: g.rec,
        start: amounts[0]!.month,
        end: g.rec === "recurring" ? g.until : "",
        amounts,
      });
      out.itemRows.push(g.rows[0]!);
    }
    if (start && opening !== null && /^\d{1,3}$/.test(horizonText)) {
      out.draft = { start, horizonMonths: horizonText, openingBalance: opening, rates, items };
      for (const pr of validateDraft(out.draft)) {
        problems.push(pr.item === null
          ? { sheet: "Settings", row: null, message: pr.message }
          : { sheet: "Lines", row: out.itemRows[pr.item] ?? null, message: pr.message });
      }
    }
  }

  const knownLines = new Set((out.draft ? out.draft.items.filter((i) => i.kind !== "asset").map((i) => i.name) : opts.existingLines)
    .map((n) => n.toLowerCase()));
  const planStart = out.draft?.start ?? null;
  const checkMonth = (sheet: string, r: number, m: string | null, raw: string): boolean => {
    if (!m) { problems.push({ sheet, row: r, message: `Month "${raw}" is not a valid month.` }); return false; }
    if (m > todayMonth) { problems.push({ sheet, row: r, message: `${m} is in the future.` }); return false; }
    if (planStart && m < planStart) { problems.push({ sheet, row: r, message: `${m} is before the plan starts (${planStart}).` }); return false; }
    return true;
  };

  // ---------- Actuals ----------
  const act = find("Actuals");
  if (act) {
    const seen = new Set<string>();
    for (let r = 2; r <= act.maxRow; r++) {
      if (isEmptyRow(act, r, "ABCD")) continue;
      const mc = get(act, `A${r}`);
      const month = monthOf(mc);
      const line = textOf(get(act, `B${r}`));
      const amount = amountOf(get(act, `C${r}`));
      let ok = checkMonth("Actuals", r, month, textOf(mc));
      if (!line) { problems.push({ sheet: "Actuals", row: r, message: "Line is empty." }); ok = false; }
      else if (!knownLines.has(line.toLowerCase())) { problems.push({ sheet: "Actuals", row: r, message: `"${line}" is not an income or expense line in the plan.` }); ok = false; }
      if (amount === null) { problems.push({ sheet: "Actuals", row: r, message: `Amount "${textOf(get(act, `C${r}`))}" is not valid (0 or more, max 2 decimals).` }); ok = false; }
      const k = `${month}|${line.toLowerCase()}`;
      if (ok && seen.has(k)) { problems.push({ sheet: "Actuals", row: r, message: `"${line}" appears twice for ${month}.` }); ok = false; }
      if (ok) {
        seen.add(k);
        out.actuals.push({ row: r, month: month!, line, amount: amount!, note: textOf(get(act, `D${r}`)).slice(0, 500) });
      }
    }
  }

  // ---------- Unplanned ----------
  const un = find("Unplanned");
  if (un) {
    for (let r = 2; r <= un.maxRow; r++) {
      if (isEmptyRow(un, r, "ABCDE")) continue;
      const mc = get(un, `A${r}`);
      const month = monthOf(mc);
      const kind = kindOf(get(un, `B${r}`));
      const name = textOf(get(un, `C${r}`));
      const amount = amountOf(get(un, `D${r}`));
      let ok = checkMonth("Unplanned", r, month, textOf(mc));
      if (kind !== "income" && kind !== "expense") { problems.push({ sheet: "Unplanned", row: r, message: `Type "${textOf(get(un, `B${r}`))}" is unknown. Use Income or Expense.` }); ok = false; }
      if (!name || name.length > 80) { problems.push({ sheet: "Unplanned", row: r, message: "Name is required (max 80 characters)." }); ok = false; }
      if (amount === null || Dec.of(amount).isZero()) { problems.push({ sheet: "Unplanned", row: r, message: "Amount must be more than 0 (max 2 decimals)." }); ok = false; }
      if (ok) out.unplanned.push({ row: r, month: month!, kind: kind as "income" | "expense", name, amount: amount!, note: textOf(get(un, `E${r}`)).slice(0, 500) });
    }
  }

  // ---------- Gold ----------
  const gold = find("Gold");
  if (gold) {
    for (let r = 11; r <= gold.maxRow; r++) {
      const label = textOf(get(gold, `A${r}`));
      if (label.toLowerCase() === "total") break;
      if (isEmptyRow(gold, r, "ABCDE")) continue;
      const p = (message: string) => problems.push({ sheet: "Gold", row: r, message });
      const karat = Number(textOf(get(gold, `B${r}`)));
      const grams = amountOf(get(gold, `C${r}`), GRAMS_RE);
      const price = amountOf(get(gold, `D${r}`));
      const date = dateOf(get(gold, `E${r}`));
      let ok = true;
      if (!label || label.length > 80) { p("Label is required (max 80 characters)."); ok = false; }
      if (karat !== 24 && karat !== 21 && karat !== 18) { p(`Karat "${textOf(get(gold, `B${r}`))}" must be 24, 21 or 18.`); ok = false; }
      if (grams === null || Dec.of(grams).isZero()) { p("Grams must be more than 0 (max 3 decimals)."); ok = false; }
      if (price === null) { p("Purchase price must be a number of 0 or more."); ok = false; }
      if (!date) { p(`Purchase date "${textOf(get(gold, `E${r}`))}" is not a valid date.`); ok = false; }
      else if (date > opts.today) { p("Purchase date is in the future."); ok = false; }
      if (ok) out.gold.push({ row: r, label, karat: karat as 24 | 21 | 18, grams: grams!, price: price!, date: date! });
    }
  }

  if (out.source === "none" && !act && !un && !gold) {
    problems.push({ sheet: "File", row: null, message: "No Lines, Actuals, Unplanned or Gold sheet found. Use the Mizan template." });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Reading a month-columns sheet (like the original Excel: Income / Installments
//  / Assets sections, months across, one row per line)
// ---------------------------------------------------------------------------

interface Group {
  name: string;
  kind: DraftItem["kind"];
  rec: DraftItem["recurrence"];
  until: string;
  rows: number[];
  amounts: { month: string; amount: string; row: number }[];
}

interface GridSettings { start: string; horizon: number; opening: string; ratePct: string }

const COLS = (() => {
  const out: string[] = [];
  for (let i = 0; i < 80; i++) out.push(i < 26 ? String.fromCharCode(65 + i) : "A" + String.fromCharCode(65 + i - 26));
  return out;
})();

function sectionKind(label: string): DraftItem["kind"] | null {
  if (/^income/.test(label)) return "income";
  if (/^(install|expense|spending|costs?\b)/.test(label)) return "expense";
  if (/^ass?ets?|^assests?/.test(label)) return "asset";
  return null;
}

/** Rows that are results, not inputs (totals, balances, interest). */
const COMPUTED_ROW = /^(total|net|acc|interest|balance|net worth|saving|cloud)/i;

function readGrid(sheet: Sheet): { groups: Map<string, Group>; settings: GridSettings; problems: ImportProblem[]; notes: string[] } | null {
  const problems: ImportProblem[] = [];
  const notes: string[] = [];
  const groups = new Map<string, Group>();
  let start: string | null = null;
  let lastMonth: string | null = null;
  let opening: string | null = null;
  let openingFrom = "";
  let ratePct: string | null = null;
  let rateFrom = "";
  let sections = 0;

  for (let r = 1; r <= sheet.maxRow; r++) {
    // a section header: a label followed by at least 3 month cells
    let labelCol = -1;
    for (let c = 0; c < 10; c++) if (textOf(get(sheet, `${COLS[c]}${r}`))) { labelCol = c; break; }
    if (labelCol < 0) continue;
    const label = textOf(get(sheet, `${COLS[labelCol]}${r}`)).toLowerCase();
    const kind = sectionKind(label);
    if (!kind) continue;
    const months: { col: string; month: string }[] = [];
    for (let c = labelCol + 1; c < COLS.length; c++) {
      const m = monthOf(get(sheet, `${COLS[c]}${r}`));
      if (m) months.push({ col: COLS[c]!, month: m });
    }
    if (months.length < 3) continue;
    sections++;
    if (!start || months[0]!.month < start) start = months[0]!.month;
    const last = months[months.length - 1]!.month;
    if (!lastMonth || last > lastMonth) lastMonth = last;

    // the line rows under the header, until an empty label
    for (let rr = r + 1; rr <= sheet.maxRow; rr++) {
      const name = textOf(get(sheet, `${COLS[labelCol]}${rr}`));
      if (!name) break;
      if (sectionKind(name.toLowerCase())) break; // next section header
      const values = months.map((m) => ({ month: m.month, cell: get(sheet, `${m.col}${rr}`) }));
      if (COMPUTED_ROW.test(name)) {
        const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(name);
        if (pct && !ratePct) { ratePct = pct[1]!; rateFrom = `"${name}" (row ${rr})`; }
        const first = values.find((v) => typeof v.cell?.value === "number");
        if (first && /^acc|balance|saving/i.test(name) && !opening) { opening = Dec.of(first.cell!.raw).round(2).toString(); openingFrom = `"${name}" (row ${rr})`; }
        if (first && /^cloud/i.test(name) && !opening) { opening = Dec.of(first.cell!.raw).round(2).toString(); openingFrom = `"${name}" (row ${rr})`; }
        continue;
      }
      const filled = values.filter((v) => typeof v.cell?.value === "number" || amountOf(v.cell) !== null)
        .map((v) => ({ month: v.month, amount: Dec.of(typeof v.cell!.value === "number" ? v.cell!.raw : amountOf(v.cell)!).round(2) }));
      const bad = values.find((v) => v.cell?.value != null && typeof v.cell.value !== "number" && amountOf(v.cell) === null);
      if (bad) problems.push({ sheet: sheet.name, row: rr, message: `"${name}" ${bad.month}: "${textOf(bad.cell)}" is not a number.` });
      if (filled.some((f) => f.amount.isNegative())) { problems.push({ sheet: sheet.name, row: rr, message: `"${name}" has a negative amount.` }); continue; }
      if (filled.length === 0) continue;
      if (groups.has(name.toLowerCase())) { problems.push({ sheet: sheet.name, row: rr, message: `"${name}" appears twice.` }); continue; }

      // gaps between filled months -> one-off months (a bonus); otherwise a monthly line with changes
      const firstIdx = values.findIndex((v) => v.month === filled[0]!.month);
      const lastIdx = values.findIndex((v) => v.month === filled[filled.length - 1]!.month);
      const contiguous = lastIdx - firstIdx + 1 === filled.length;
      const g: Group = { name, kind, rec: "recurring", until: "", rows: [rr], amounts: [] };
      if (!contiguous && kind !== "asset") {
        g.rec = "one_off";
        g.amounts = filled.map((f) => ({ month: f.month, amount: f.amount.toString(), row: rr }));
      } else {
        let prev: Dec | null = null;
        for (const f of filled) {
          if (!prev || !f.amount.eq(prev)) g.amounts.push({ month: f.month, amount: f.amount.toString(), row: rr });
          prev = f.amount;
        }
        if (lastIdx < values.length - 1) g.until = filled[filled.length - 1]!.month;
      }
      groups.set(name.toLowerCase(), g);
    }
  }
  if (sections === 0 || !start || !lastMonth) return null;

  const [y1, m1] = start.split("-").map(Number);
  const [y2, m2] = lastMonth.split("-").map(Number);
  const horizon = Math.min(240, (y2! - y1!) * 12 + (m2! - m1!) + 1);
  notes.push(`Read "${sheet.name}" as a month grid: ${groups.size} lines, ${start} to ${lastMonth} (${horizon} months).`);
  if (opening) notes.push(`Opening savings ${Number(opening).toLocaleString("en-US")} EGP, taken from ${openingFrom}.`);
  else { opening = "0"; notes.push("No opening savings balance found, using 0. Change it in the plan editor after importing."); }
  if (ratePct) notes.push(`Interest rate ${ratePct}%, taken from ${rateFrom}.`);
  else { ratePct = "0"; notes.push("No interest rate found, using 0%. Change it in the plan editor after importing."); }
  notes.push("Balance, interest and totals rows are recalculated by Mizan, not imported.");
  return { groups, settings: { start, horizon, opening, ratePct }, problems, notes };
}
