// Number boxes accept only what they can hold, as you type or paste.
//
// Every <input inputmode="decimal"> is filtered:
//   data-num="pct"         0-999 with up to 2 decimals (5, 7.5, 17.25)
//   data-num="signed-pct"  same, may start with + or - (gold adjustment)
//   data-num="grams"       digits with up to 3 decimals (2.125)
//   data-num="rate"        0-9999 with up to 4 decimals (17, 0.0465)
//   data-num="signed-money" money that may start with + or - (a profit or a loss);
//                          filtered even without inputmode="decimal" (phone number pads have no minus key)
//   anything else          money: digits, thousands commas, up to 2 decimals
// Letters and other characters are dropped and the caret stays where it was.

export type NumKind = "pct" | "signed-pct" | "grams" | "money" | "rate" | "signed-money";

/** Keeps only the characters a number box of this kind allows. */
export function cleanNumber(raw: string, kind: NumKind): string {
  let sign = "";
  let s = raw;
  if (kind === "signed-pct" || kind === "signed-money") {
    const m = /^\s*([+\-−])/.exec(s);
    if (m) sign = m[1] === "−" ? "-" : m[1]!;
  }
  s = s.replace(kind === "money" || kind === "signed-money" ? /[^\d.,]/g : /[^\d.]/g, "");
  // one decimal point, at most 2 decimals (3 for grams)
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/[.,]/g, "").slice(0, kind === "grams" ? 3 : kind === "rate" ? 4 : 2);
  if (kind === "pct" || kind === "signed-pct" || kind === "rate") {
    const [int = "", dec] = s.split(".");
    s = int.slice(0, kind === "rate" ? 4 : 3) + (dec !== undefined ? "." + dec : "");
  }
  return sign + s;
}

function kindOf(input: HTMLInputElement): NumKind {
  const k = input.dataset.num;
  return k === "pct" || k === "signed-pct" || k === "grams" || k === "rate" || k === "signed-money" ? k : "money";
}

function filter(input: HTMLInputElement): void {
  const before = input.value;
  const after = cleanNumber(before, kindOf(input));
  if (after === before) return;
  // keep the caret after the same allowed character it was after
  const caret = input.selectionStart ?? before.length;
  const keptBeforeCaret = cleanNumber(before.slice(0, caret), kindOf(input)).length;
  input.value = after;
  const pos = Math.min(keptBeforeCaret, after.length);
  try { input.setSelectionRange(pos, pos); } catch { /* some input types don't support selection */ }
}

/** Filter every decimal box on the page, now and later (one listener for the whole page). */
export function startNumberInputs(): void {
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && (t.inputMode === "decimal" || t.dataset.num === "signed-money")) filter(t);
  }, true);
}
