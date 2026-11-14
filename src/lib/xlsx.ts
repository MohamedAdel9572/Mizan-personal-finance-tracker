/**
 * Minimal .xlsx reader with no dependencies.
 *
 * An .xlsx file is a zip of XML files. We read the zip directory ourselves and
 * inflate entries with the platform's DecompressionStream("deflate-raw")
 * (Chrome 103+, Safari 16.4+, Firefox 113+, Node 22). Cell values are returned
 * as the raw text stored in the file, so numbers stay exact: "12510.5" is never
 * turned into a float before it reaches Dec.
 */

export type CellValue = string | number | boolean | null;

export interface Sheet {
  name: string;
  /** "A1" -> value. Numbers are kept as their exact text in `raw`. */
  cells: Map<string, { value: CellValue; raw: string }>;
  maxRow: number;
}

export class XlsxError extends Error {}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITY[e] ?? m;
  });
}

/** Drop namespace prefixes on tags (<x:c> -> <c>) so files from any generator parse the same way. */
const unprefix = (xml: string) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, "<$1");

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new XlsxError("This browser can't read Excel files. Please update it.");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read every file inside a zip. */
export async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  // End of central directory: search backwards (a zip comment may follow it)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("This is not an Excel (.xlsx) file.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new XlsxError("The Excel file is damaged.");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflateRaw(data));
    else throw new XlsxError("The Excel file uses an unsupported compression.");
  }
  return out;
}

function text(files: Map<string, Uint8Array>, path: string): string | null {
  const f = files.get(path);
  return f ? unprefix(new TextDecoder().decode(f)) : null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]!) : null;
}

/** Text of an <si> or <is> element (plain or rich text runs). */
function richText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) out += decode(m[1] ?? "");
  return out;
}

export async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const files = await unzip(buf);
  const workbook = text(files, "xl/workbook.xml");
  if (!workbook) throw new XlsxError("This is not an Excel (.xlsx) file.");
  const rels = text(files, "xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const shared: string[] = [];
  const sst = text(files, "xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\s*\/>/g)) shared.push(richText(m[1] ?? ""));

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name") ?? "";
    const rid = attr(m[0], "r:id") ?? attr(m[0], "id");
    const path = rid ? targets.get(rid) : undefined;
    const xml = path ? text(files, path) : null;
    const cells = new Map<string, { value: CellValue; raw: string }>();
    let maxRow = 0;
    if (xml) {
      for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1]!, "r");
        if (!ref) continue;
        const type = attr(c[1]!, "t") ?? "n";
        const body = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: CellValue = null;
        let raw = "";
        if (type === "s" && v != null) raw = shared[Number(v)] ?? "";
        else if (type === "inlineStr") raw = richText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
        else if (v != null) raw = decode(v);
        if (type === "n" && raw !== "") value = Number(raw);
        else if (type === "b") value = raw === "1";
        else if (type === "e") value = null;
        else value = raw;
        if (value === "" ) value = null;
        cells.set(ref, { value, raw: value === null ? "" : raw });
        const row = Number(/\d+$/.exec(ref)?.[0] ?? 0);
        if (value !== null && row > maxRow) maxRow = row;
      }
    }
    sheets.push({ name, cells, maxRow });
  }
  return sheets;
}

/** Excel stores dates as days since 1899-12-30. */
export function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}
