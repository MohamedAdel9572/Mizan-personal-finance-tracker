/** Escape text for HTML. Every user-provided value goes through this. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function qs<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((v, k) => {
    out[k] = typeof v === "string" ? v : "";
  });
  return out;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, kind: "ok" | "error" | "info" = "info"): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el?.classList.remove("show"), kind === "error" ? 6000 : 3000);
}

/** Disable a form while an async action runs; re-enable afterwards. */
export async function busy<T>(form: HTMLFormElement, action: () => Promise<T>): Promise<T | undefined> {
  const controls = [...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input, select, textarea")];
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  const label = submit?.textContent;
  controls.forEach((c) => (c.disabled = true));
  if (submit) submit.textContent = "Saving…";
  try {
    return await action();
  } finally {
    controls.forEach((c) => (c.disabled = false));
    if (submit && label != null) submit.textContent = label;
  }
}

/** Show an inline error under a form (and announce it). */
export function formError(form: HTMLFormElement, message: string | null): void {
  let el = form.querySelector<HTMLElement>(".form-error");
  if (!el) {
    el = document.createElement("p");
    el.className = "form-error";
    el.setAttribute("role", "alert");
    form.append(el);
  }
  el.textContent = message ?? "";
  el.hidden = !message;
}

export function openDialog(html: string, onReady: (dialog: HTMLDialogElement) => void): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "sheet";
  dialog.innerHTML = html;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // click on the backdrop
  });
  dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));
  dialog.showModal();
  onReady(dialog);
  return dialog;
}

export function emptyState(title: string, text: string, action?: { href: string; label: string }): string {
  return `<div class="empty">
    <div class="empty-icon" aria-hidden="true">◎</div>
    <h2>${esc(title)}</h2>
    <p class="muted">${esc(text)}</p>
    ${action ? `<a class="btn primary" href="${esc(action.href)}">${esc(action.label)}</a>` : ""}
  </div>`;
}
