// Dashboard (basic until step 4), Gold and History (steps 5 and 6) and Settings.
import { Dec } from "../engine/decimal.ts";
import { currentMonth } from "../engine/month.ts";
import { ApiError } from "../lib/api.ts";
import { busy, emptyState, esc, formError, formValues, toast } from "../lib/dom.ts";
import { egp, monthLabel, signed } from "../lib/format.ts";
import { passwordProblem, setToken } from "../lib/session.ts";
import type { Ctx } from "./context.ts";

export function renderDashboard(root: HTMLElement, ctx: Ctx): void {
  const t = ctx.data.timeline;
  if (!t) {
    root.innerHTML = `<div class="page-head"><h1>Hi ${esc(ctx.data.profile.full_name.split(" ")[0])}</h1></div>` +
      emptyState("Let's set up your plan", "Add your income, installments and savings account first.", { href: "#/plan", label: "Create my plan" });
    return;
  }
  const now = currentMonth();
  const last = ctx.data.comparisons.filter((c) => !c.assumed).at(-1);
  const lastActual = ctx.data.actuals.filter((a) => !a.assumed).at(-1);
  const plannedNow = t.planned(now < t.start ? t.start : now);
  const netWorth = lastActual?.netWorth ?? plannedNow?.netWorth ?? Dec.ZERO;
  const notLogged = now >= t.start && !ctx.data.checkins.some((c) => c.month === now);

  root.innerHTML = `
    <div class="page-head"><h1>Hi ${esc(ctx.data.profile.full_name.split(" ")[0])}</h1></div>
    ${notLogged ? `<div class="alert info notice-row"><span><strong>${esc(monthLabel(now, true))}</strong> isn't logged yet.</span><a class="btn primary small" href="#/log/${now}">Log it</a></div>` : ""}
    <div class="stats-grid">
      <div class="card stat"><span class="stat-label">Net worth</span><span class="stat-value num">${egp(netWorth)}</span>
        <span class="small muted">${lastActual ? `actual, ${esc(monthLabel(lastActual.month, true))}${ctx.data.goldValue ? ", gold at today's price" : ""}` : "planned"}</span></div>
      ${ctx.data.goldValue ? `<a class="card stat link-card" href="#/gold"><span class="stat-label">Gold now</span><span class="stat-value num">${egp(ctx.data.goldValue)}</span><span class="small muted">at your price per gram</span></a>` : ""}
      ${last ? `
      <div class="card stat"><span class="stat-label">Last month vs plan</span><span class="stat-value num ${last.net.gap.isNegative() ? "neg" : "pos"}">${signed(last.net.gap)}</span>
        <span class="small muted">${esc(monthLabel(last.month, true))} net</span></div>
      <div class="card stat"><span class="stat-label">Cumulative gap</span><span class="stat-value num ${last.cumulative.net.isNegative() ? "neg" : "pos"}">${signed(last.cumulative.net)}</span>
        <span class="small muted">since ${esc(monthLabel(t.start, true))}</span></div>` : ""}
    </div>
    <div class="quick-actions">
      <a class="btn ghost" href="#/compare">Plan vs actual</a>
      <a class="btn ghost" href="#/plan">Plan</a>
      <a class="btn ghost" href="#/plan/import">Import Excel</a>
    </div>
    <p class="muted small">Goal progress, alerts and charts arrive with the full dashboard (step 4).</p>`;
}

export function renderComingSoon(title: string, text: string): (root: HTMLElement) => void {
  return (root) => {
    root.innerHTML = `<div class="page-head"><h1>${esc(title)}</h1></div>` + emptyState("Coming soon", text);
  };
}

export function renderSettings(root: HTMLElement, ctx: Ctx, onSignedOut: () => void): void {
  const p = ctx.data.profile;
  const theme = localStorageGet("mizan_theme") || "system";
  root.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="settings">
      <section class="card">
        <h2>Account</h2>
        <div class="kv"><span>Name</span><span>${esc(p.full_name)}</span></div>
        <div class="kv"><span>Mobile</span><span>${esc(p.mobile)}</span></div>
        <button class="btn ghost block" id="signout">Sign out</button>
      </section>
      <section class="card">
        <h2>Appearance</h2>
        <div class="segmented" role="radiogroup" aria-label="Theme">
          ${["system", "light", "dark"].map((t) => `<label><input type="radio" name="theme" value="${t}"${t === theme ? " checked" : ""}><span>${t[0]!.toUpperCase() + t.slice(1)}</span></label>`).join("")}
        </div>
      </section>
      <form class="card" id="pw" novalidate>
        <h2>Change password</h2>
        <label>Current password<input type="password" name="old" autocomplete="current-password"></label>
        <label>New password<input type="password" name="new1" autocomplete="new-password"></label>
        <label>Repeat new password<input type="password" name="new2" autocomplete="new-password"></label>
        <p class="muted small">Other devices will be signed out.</p>
        <button class="btn primary" type="submit">Change password</button>
      </form>
      <form class="card danger-zone" id="del" novalidate>
        <h2>Delete account</h2>
        <p class="muted small">Deletes your plan, every version, all actuals, gold and history. This can't be undone.</p>
        <label>Type your password to confirm<input type="password" name="password" autocomplete="current-password"></label>
        <button class="btn danger" type="submit">Delete my account</button>
      </form>
    </div>`;

  root.querySelector("#signout")!.addEventListener("click", async () => {
    try {
      await ctx.api.rpc("app_logout");
    } catch {
      // signing out locally is enough if the server is unreachable
    }
    setToken(null);
    onSignedOut();
  });

  root.querySelectorAll<HTMLInputElement>("input[name=theme]").forEach((r) => r.addEventListener("change", () => {
    localStorageSet("mizan_theme", r.value === "system" ? "" : r.value);
    applyTheme();
  }));

  const pw = root.querySelector<HTMLFormElement>("#pw")!;
  pw.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formValues(pw);
    const problem = (!f.old ? "Enter your current password." : null) ?? passwordProblem(f.new1 ?? "") ??
      (f.new1 !== f.new2 ? "The two new passwords don't match." : null);
    formError(pw, problem);
    if (problem) return;
    await busy(pw, async () => {
      try {
        await ctx.api.rpc("app_change_password", { p_old: f.old, p_new: f.new1 });
        pw.reset();
        toast("Password changed. Other devices were signed out.", "ok");
      } catch (err) {
        if (err instanceof ApiError && err.kind === "auth") ctx.fail(err);
        else formError(pw, err instanceof ApiError ? err.message : "Could not change the password.");
      }
    });
  });

  const del = root.querySelector<HTMLFormElement>("#del")!;
  del.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formValues(del);
    if (!f.password) return formError(del, "Type your password to confirm.");
    if (!confirm("Delete your account and all your data permanently?")) return;
    await busy(del, async () => {
      try {
        await ctx.api.rpc("app_delete_account", { p_password: f.password });
        setToken(null);
        toast("Your account was deleted.", "ok");
        onSignedOut();
      } catch (err) {
        if (err instanceof ApiError && err.kind === "auth") ctx.fail(err);
        else formError(del, err instanceof ApiError ? err.message : "Could not delete the account.");
      }
    });
  });
}

function localStorageGet(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}

function localStorageSet(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    // ignore: theme just won't be remembered
  }
}

export function applyTheme(): void {
  const t = localStorageGet("mizan_theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
