// Month calendar for every <input type="month">.
//
// Firefox (and Safari on Mac) show type="month" as a plain text box, so Mizan
// draws its own picker everywhere: a year header with ‹ › and a 4×3 grid of
// months. The input keeps its YYYY-MM value, so forms read it as before, and
// you can still type a month (2027-03, 3/2027, 03-2027).
//
// startMonthPickers() watches the page and upgrades every month input that
// appears, including inputs inside dialogs and lines added later.

const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

let open: { input: HTMLInputElement; pop: HTMLElement; close: (focusInput: boolean) => void } | null = null;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 2027-3, 3/2027, 03-2027, 2027/03 → 2027-03; anything else unchanged. */
export function normalizeMonth(text: string): string {
  const t = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(t);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${pad(Number(m[2]))}` : t;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${pad(Number(m[1]))}` : t;
  return t;
}

function setValue(input: HTMLInputElement, value: string): void {
  if (input.value === value) return;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function label(month: string): string {
  const [y, m] = month.split("-");
  return `${NAMES[Number(m) - 1]} ${y}`;
}

function openPicker(input: HTMLInputElement, wrap: HTMLElement): void {
  if (open?.input === input) return;
  open?.close(false);
  const min = input.dataset.min && MONTH_RE.test(input.dataset.min) ? input.dataset.min : null;
  const max = input.dataset.max && MONTH_RE.test(input.dataset.max) ? input.dataset.max : null;
  const value = MONTH_RE.test(normalizeMonth(input.value)) ? normalizeMonth(input.value) : null;
  const today = thisMonth();
  let year = Number((value ?? (min && min > today ? min : today)).slice(0, 4));

  const pop = document.createElement("div");
  pop.className = "mp-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Choose a month");

  const allowed = (m: string) => (!min || m >= min) && (!max || m <= max);
  const draw = (focusMonth?: string) => {
    const cells = NAMES.map((name, i) => {
      const m = `${year}-${pad(i + 1)}`;
      const cls = ["mp-month", m === value ? "on" : "", m === today ? "today" : ""].filter(Boolean).join(" ");
      return `<button type="button" class="${cls}" data-m="${m}" ${allowed(m) ? "" : "disabled"} aria-pressed="${m === value}" aria-label="${label(m)}" tabindex="-1">${name}</button>`;
    }).join("");
    pop.innerHTML = `
      <div class="mp-head">
        <button type="button" class="mp-nav" data-y="-1" aria-label="Previous year" ${min && year <= Number(min.slice(0, 4)) ? "disabled" : ""}>‹</button>
        <strong aria-live="polite">${year}</strong>
        <button type="button" class="mp-nav" data-y="1" aria-label="Next year" ${max && year >= Number(max.slice(0, 4)) ? "disabled" : ""}>›</button>
      </div>
      <div class="mp-grid" role="grid">${cells}</div>
      <div class="mp-foot">
        <button type="button" class="mp-link" data-act="today" ${allowed(today) ? "" : "disabled"}>This month</button>
        ${input.required ? "" : `<button type="button" class="mp-link" data-act="clear">Clear</button>`}
      </div>`;
    const target = pop.querySelector<HTMLButtonElement>(`.mp-month[data-m="${focusMonth ?? ""}"]:not([disabled])`)
      ?? pop.querySelector<HTMLButtonElement>(".mp-month.on:not([disabled])")
      ?? pop.querySelector<HTMLButtonElement>(".mp-month.today:not([disabled])")
      ?? pop.querySelector<HTMLButtonElement>(".mp-month:not([disabled])");
    if (target) target.tabIndex = 0;
    return target;
  };

  const close = (focusInput: boolean) => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    input.setAttribute("aria-expanded", "false");
    if (open?.pop === pop) open = null;
    if (focusInput) input.focus();
  };
  // fixed position: never clipped by a dialog or a scrolling card
  const place = () => {
    const box = input.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, gap = 6;
    const below = window.innerHeight - box.bottom - gap - 8;
    const top = below >= h || box.top - gap - 8 < h ? box.bottom + gap : box.top - gap - h;
    pop.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
    pop.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - w - 8))}px`;
  };
  const onScroll = (e: Event) => { if (!pop.contains(e.target as Node)) close(false); };
  const onResize = () => close(false);
  const outside = (e: Event) => {
    if (!pop.contains(e.target as Node) && !wrap.contains(e.target as Node)) close(false);
  };
  const pick = (m: string) => {
    setValue(input, m);
    close(true);
  };

  pop.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b || b.disabled) return;
    if (b.dataset.m) pick(b.dataset.m);
    else if (b.dataset.y) { year += Number(b.dataset.y); draw()?.focus({ preventScroll: true }); }
    else if (b.dataset.act === "today") pick(today);
    else if (b.dataset.act === "clear") { setValue(input, ""); close(true); }
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
    const cur = (document.activeElement as HTMLElement)?.dataset?.m;
    if (!cur) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const [y, m] = cur.split("-").map(Number) as [number, number];
    const idx = y * 12 + (m - 1) + step;
    const next = `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
    if (!allowed(next)) return;
    if (Math.floor(idx / 12) !== year) year = Math.floor(idx / 12);
    draw(next)?.focus({ preventScroll: true });
  });

  wrap.appendChild(pop);
  input.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  open = { input, pop, close };
  const first = draw();
  place();
  first?.focus({ preventScroll: true });
}

function enhance(input: HTMLInputElement): void {
  if (input.dataset.mp) return;
  input.dataset.mp = "1";
  if (input.min) input.dataset.min = input.min;
  if (input.max) input.dataset.max = input.max;
  input.type = "text";
  input.removeAttribute("min");
  input.removeAttribute("max");
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.placeholder ||= "YYYY-MM";
  input.classList.add("mp-input");
  input.setAttribute("aria-haspopup", "dialog");
  input.setAttribute("aria-expanded", "false");

  const wrap = document.createElement("span");
  wrap.className = "mp-wrap";
  input.replaceWith(wrap);
  wrap.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mp-btn";
  btn.tabIndex = -1;
  btn.setAttribute("aria-label", "Open month calendar");
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  wrap.appendChild(btn);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (open?.input === input) open.close(true);
    else openPicker(input, wrap);
  });
  input.addEventListener("click", () => openPicker(input, wrap));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.key === "Enter" && !open)) {
      // Enter in a text box would submit the form; open the calendar instead
      if (e.key === "Enter" && input.value && MONTH_RE.test(normalizeMonth(input.value))) return;
      e.preventDefault();
      openPicker(input, wrap);
    } else if (e.key === "Escape" && open?.input === input) {
      e.preventDefault();
      open.close(true);
    }
  });
  input.addEventListener("blur", () => {
    const n = normalizeMonth(input.value);
    if (n !== input.value) setValue(input, n);
  });
}

/** Upgrade every month input now and whenever the page adds new ones. */
export function startMonthPickers(root: HTMLElement = document.body): void {
  const scan = (node: ParentNode) => node.querySelectorAll<HTMLInputElement>('input[type="month"]').forEach(enhance);
  scan(root);
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof HTMLInputElement && n.type === "month") enhance(n);
        else if (n instanceof Element) scan(n);
      });
    }
    // a re-render may have removed the input whose calendar is open
    if (open && !open.input.isConnected) open.close(false);
  }).observe(root, { childList: true, subtree: true });
}
