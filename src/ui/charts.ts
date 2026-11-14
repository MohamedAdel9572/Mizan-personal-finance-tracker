/**
 * Small SVG charts with no library: line (with crosshair tooltip), grouped bars
 * (per-group tooltip) and diverging horizontal bars. They are drawn at the
 * container's real width so text stays readable on phones, and redrawn when
 * the window size changes. Colors come from CSS variables (light/dark aware).
 * Rules followed: one y-axis, 2px lines, rounded bar ends on the data side,
 * a legend for 2+ series, recessive grid, numbers in text colors (not series colors).
 */
import { esc } from "../lib/dom.ts";

export interface LineSeries {
  name: string;
  values: (number | null)[];
  color: string; // CSS color, e.g. "var(--series-1)"
  dashed?: boolean;
}

export interface LineOpts {
  labels: string[];
  series: LineSeries[];
  format: (n: number) => string;
  height?: number;
  /** index of "today" to draw a light marker line */
  marker?: number;
  /** y-axis starts at 0 (default true) */
  zero?: boolean;
}

export interface BarOpts {
  labels: string[];
  series: { name: string; values: number[]; color: string }[];
  format: (n: number) => string;
  height?: number;
}

export interface DivergingItem { label: string; value: number; note?: string }

const M = { top: 12, right: 12, bottom: 28, left: 56 };

/** "1.55M", "250k", "-3.2k", "900" */
export function compact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}${trim(a / 1_000_000)}M`;
  if (a >= 1_000) return `${sign}${trim(a / 1_000)}k`;
  return `${sign}${Math.round(a)}`;
}
function trim(x: number): string {
  return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

function legend(items: { name: string; color: string; dashed?: boolean }[]): string {
  if (items.length < 2) return "";
  return `<div class="chart-legend">${items.map((s) => `<span><svg width="18" height="10" aria-hidden="true"><line x1="1" y1="5" x2="17" y2="5" stroke="${s.color}" stroke-width="3" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="4 3"' : ""}/></svg>${esc(s.name)}</span>`).join("")}</div>`;
}

function tipEl(): HTMLElement {
  let t = document.getElementById("chart-tip");
  if (!t) {
    t = document.createElement("div");
    t.id = "chart-tip";
    t.className = "grid-tip";
    t.setAttribute("role", "tooltip");
    document.body.append(t);
  }
  return t;
}

function placeTip(t: HTMLElement, x: number, y: number): void {
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  t.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2))}px`;
  t.style.top = `${y - h - 12 < 8 ? y + 16 : y - h - 12}px`;
}

function xLabelEvery(n: number, width: number): number {
  const fit = Math.max(2, Math.floor(width / 56));
  return Math.max(1, Math.ceil(n / fit));
}

/** Draw now and again on resize. Returns a cleanup function. */
function responsive(el: HTMLElement, draw: (width: number) => void): void {
  let last = 0;
  const run = () => {
    const w = Math.floor(el.clientWidth);
    if (w > 0 && w !== last) {
      last = w;
      draw(w);
    }
  };
  run();
  const ro = new ResizeObserver(() => run());
  ro.observe(el);
}

export function lineChart(el: HTMLElement, o: LineOpts): void {
  responsive(el, (W) => {
    const H = o.height ?? 240;
    const n = o.labels.length;
    const all = o.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const lo = Math.min(o.zero === false ? Math.min(...all) : 0, ...all);
    const hi = Math.max(...all, 0);
    const ticks = niceTicks(lo, hi);
    const y0 = ticks[0]!;
    const y1 = ticks[ticks.length - 1]!;
    const pw = W - M.left - M.right;
    const ph = H - M.top - M.bottom;
    const x = (i: number) => M.left + (n === 1 ? pw / 2 : (i * pw) / (n - 1));
    const y = (v: number) => M.top + ph - ((v - y0) / (y1 - y0)) * ph;
    const every = xLabelEvery(n, pw);

    const path = (vals: (number | null)[]) => {
      let d = "";
      let pen = false;
      vals.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const lonely = (vals: (number | null)[]) => vals.map((v, i) =>
      v !== null && (vals[i - 1] ?? null) === null && (vals[i + 1] ?? null) === null ? i : -1).filter((i) => i >= 0);

    el.innerHTML = legend(o.series) + `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.series.map((s) => s.name).join(", "))} by month">
      ${ticks.map((t) => `<line class="grid-line" x1="${M.left}" x2="${W - M.right}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${M.left - 8}" y="${y(t) + 4}" text-anchor="end">${esc(o.format(t))}</text>`).join("")}
      ${o.labels.map((l, i) => (i % every === 0 || i === n - 1) && !(i === n - 1 && i % every !== 0 && i - Math.floor(i / every) * every < every * 0.8)
        ? `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : "").join("")}
      ${o.marker !== undefined && o.marker >= 0 && o.marker < n ? `<line class="today-line" x1="${x(o.marker)}" x2="${x(o.marker)}" y1="${M.top}" y2="${M.top + ph}"/>` : ""}
      ${o.series.map((s) => `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="5 4"' : ""}/>
        ${lonely(s.values).map((i) => `<circle cx="${x(i)}" cy="${y(s.values[i]!)}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join("")}`).join("")}
      <line class="cross" x1="0" x2="0" y1="${M.top}" y2="${M.top + ph}" visibility="hidden"/>
      ${o.series.map((s, k) => `<circle class="cross-dot" data-k="${k}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`).join("")}
      <rect class="hit" x="${M.left}" y="${M.top}" width="${pw}" height="${ph}" fill="transparent"/>
    </svg>`;

    const svg = el.querySelector<SVGSVGElement>(".chart-svg")!;
    const cross = svg.querySelector<SVGLineElement>(".cross")!;
    const dots = [...svg.querySelectorAll<SVGCircleElement>(".cross-dot")];
    const tip = tipEl();
    const hit = svg.querySelector<SVGRectElement>(".hit")!;
    const move = (clientX: number) => {
      const r = svg.getBoundingClientRect();
      const px = clientX - r.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - M.left) / pw) * (n - 1))));
      cross.setAttribute("x1", String(x(i)));
      cross.setAttribute("x2", String(x(i)));
      cross.setAttribute("visibility", "visible");
      let top = Infinity;
      dots.forEach((d, k) => {
        const v = o.series[k]!.values[i];
        if (v === null || v === undefined) return d.setAttribute("visibility", "hidden");
        d.setAttribute("cx", String(x(i)));
        d.setAttribute("cy", String(y(v)));
        d.setAttribute("visibility", "visible");
        top = Math.min(top, y(v));
      });
      tip.innerHTML = `<strong>${esc(o.labels[i]!)}</strong>` + o.series.map((s) => {
        const v = s.values[i];
        return v === null || v === undefined ? "" : `<div class="tip-row"><svg width="14" height="8" aria-hidden="true"><line x1="1" y1="4" x2="13" y2="4" stroke="${s.color}" stroke-width="3"${s.dashed ? ' stroke-dasharray="3 2"' : ""}/></svg>${esc(s.name)}<b>${esc(o.format(v))}</b></div>`;
      }).join("");
      tip.className = "grid-tip chart-tip show";
      placeTip(tip, r.left + x(i), r.top + (top === Infinity ? M.top : top));
    };
    const leave = () => {
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
      tip.className = "grid-tip chart-tip";
    };
    hit.addEventListener("mousemove", (e) => move(e.clientX));
    hit.addEventListener("mouseleave", leave);
    hit.addEventListener("touchstart", (e) => move(e.touches[0]!.clientX), { passive: true });
    hit.addEventListener("touchmove", (e) => move(e.touches[0]!.clientX), { passive: true });
    hit.addEventListener("touchend", () => setTimeout(leave, 1500));
  });
}

export function barChart(el: HTMLElement, o: BarOpts): void {
  responsive(el, (W) => {
    const H = o.height ?? 240;
    const n = o.labels.length;
    const k = o.series.length;
    const all = o.series.flatMap((s) => s.values);
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const y0 = ticks[0]!;
    const y1 = ticks[ticks.length - 1]!;
    const pw = W - M.left - M.right;
    const ph = H - M.top - M.bottom;
    const band = pw / n;
    const gap = 2;
    const bw = Math.max(2, Math.min(18, (band * 0.72 - gap * (k - 1)) / k));
    const groupW = bw * k + gap * (k - 1);
    const y = (v: number) => M.top + ph - ((v - y0) / (y1 - y0)) * ph;
    const every = xLabelEvery(n, pw);
    const r = Math.min(4, bw / 2);
    const bar = (cx: number, v: number, color: string) => {
      const top = y(Math.max(v, 0));
      const bottom = y(Math.min(v, 0));
      const h = Math.max(0, bottom - top);
      if (h < 0.5) return "";
      // rounded on the data end only, square on the baseline
      return v >= 0
        ? `<path d="M${cx},${bottom} V${top + r} q0,-${r} ${r},-${r} H${cx + bw - r} q${r},0 ${r},${r} V${bottom} Z" fill="${color}"/>`
        : `<path d="M${cx},${top} V${bottom - r} q0,${r} ${r},${r} H${cx + bw - r} q${r},0 ${r},-${r} V${top} Z" fill="${color}"/>`;
    };
    el.innerHTML = legend(o.series) + `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.series.map((s) => s.name).join(" and "))} by month">
      ${ticks.map((t) => `<line class="grid-line${t === 0 ? " zero-line" : ""}" x1="${M.left}" x2="${W - M.right}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${M.left - 8}" y="${y(t) + 4}" text-anchor="end">${esc(o.format(t))}</text>`).join("")}
      ${o.labels.map((l, i) => {
        const gx = M.left + i * band + (band - groupW) / 2;
        return `<g>${o.series.map((s, j) => bar(gx + j * (bw + gap), s.values[i] ?? 0, s.color)).join("")}</g>
          ${i % every === 0 ? `<text class="axis" x="${M.left + i * band + band / 2}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : ""}
          <rect class="hit" data-i="${i}" x="${M.left + i * band}" y="${M.top}" width="${band}" height="${ph}" fill="transparent"/>`;
      }).join("")}
    </svg>`;
    const tip = tipEl();
    el.querySelectorAll<SVGRectElement>(".hit").forEach((h) => {
      const show = () => {
        const i = Number(h.dataset.i);
        tip.innerHTML = `<strong>${esc(o.labels[i]!)}</strong>` + o.series.map((s) =>
          `<div class="tip-row"><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="${s.color}"/></svg>${esc(s.name)}<b>${esc(o.format(s.values[i] ?? 0))}</b></div>`).join("");
        tip.className = "grid-tip chart-tip show";
        const rr = h.getBoundingClientRect();
        placeTip(tip, rr.left + rr.width / 2, rr.top + 20);
        h.classList.add("on");
      };
      const hide = () => { tip.className = "grid-tip chart-tip"; h.classList.remove("on"); };
      h.addEventListener("mouseenter", show);
      h.addEventListener("mouseleave", hide);
      h.addEventListener("touchstart", show, { passive: true });
      h.addEventListener("touchend", () => setTimeout(hide, 1500));
    });
  });
}

/** Horizontal bars around zero: right = helps your savings (good), left = hurts (bad). Labels say it too. */
export function divergingBars(el: HTMLElement, items: DivergingItem[], format: (n: number) => string): void {
  responsive(el, (W) => {
    const rowH = 30;
    const labelW = Math.min(150, Math.floor(W * 0.34));
    const valueW = 70;
    const H = items.length * rowH + 8;
    const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
    const span = W - labelW - valueW - 8;
    const mid = labelW + span / 2;
    const scale = (span / 2 - 4) / max;
    el.innerHTML = `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gap by line">
      <line class="zero-line" x1="${mid}" x2="${mid}" y1="0" y2="${H}"/>
      ${items.map((it, i) => {
        const cy = i * rowH + rowH / 2 + 4;
        const len = Math.max(2, Math.abs(it.value) * scale);
        const good = it.value >= 0;
        const x0 = good ? mid : mid - len;
        const r = Math.min(4, len / 2);
        const d = good
          ? `M${x0},${cy - 7} H${x0 + len - r} q${r},0 ${r},${r} V${cy + 7 - r} q0,${r} -${r},${r} H${x0} Z`
          : `M${x0 + len},${cy - 7} H${x0 + r} q-${r},0 -${r},${r} V${cy + 7 - r} q0,${r} ${r},${r} H${x0 + len} Z`;
        return `<g><title>${esc(it.label)}: ${esc(format(it.value))}${it.note ? ` (${esc(it.note)})` : ""}</title>
          <text class="axis label" x="${labelW - 8}" y="${cy + 4}" text-anchor="end">${esc(it.label.length > 20 ? it.label.slice(0, 19) + "…" : it.label)}</text>
          <path d="${d}" fill="var(--${good ? "good" : "bad"})"/>
          <text class="value" x="${W - 4}" y="${cy + 4}" text-anchor="end">${esc(format(it.value))}</text></g>`;
      }).join("")}
    </svg>`;
  });
}
