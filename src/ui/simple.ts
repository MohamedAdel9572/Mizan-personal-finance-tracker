// Dashboard (basic until step 4), Gold and History (steps 5 and 6) and Settings.
import { Dec } from "../engine/decimal.ts";
import { currentMonth } from "../engine/month.ts";
import { ApiError } from "../lib/api.ts";
import { busy, emptyState, esc, formError, formValues, toast } from "../lib/dom.ts";
import { egp, money, monthLabel, signed } from "../lib/format.ts";
import { passwordProblem, setToken } from "../lib/session.ts";
import type { Ctx } from "./context.ts";

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
      <form class="card" id="plan-colours" novalidate>
        <div class="section-head"><h2>Plan colours</h2><a class="small" href="#/plan/actual">See the Actual tab →</a></div>
        <p class="muted small">Every line you log gets a dot that compares what happened with the plan.</p>
        <label class="pc-limit">How much worse is still yellow?
          <span class="suffix"><input name="warn" inputmode="decimal" data-num="pct" maxlength="5" value="${esc(Dec.of(ctx.data.settings.warnPct).toString())}" aria-describedby="pc-rules"><span>%</span></span></label>
        <div class="pc-bar" aria-hidden="true">
          <span class="pc-seg good"></span><span class="pc-seg warn"></span><span class="pc-seg bad"></span>
        </div>
        <div class="pc-ticks small" aria-hidden="true"><span class="good"></span><span class="warn"></span><span class="bad"></span></div>
        <ul class="pc-rules" id="pc-rules" aria-live="polite"></ul>
        <p class="muted small">Examples use a Car payment planned at 8,000. For income it's the other way round: earning less than planned is worse.</p>
        <button class="btn primary" type="submit">Save</button>
        <p class="form-error" hidden></p>
      </form>
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

  const pc = root.querySelector<HTMLFormElement>("#plan-colours")!;
  // live preview of the three colours for the % being typed
  const warnInput = pc.querySelector<HTMLInputElement>("input[name=warn]")!;
  const drawRules = () => {
    const raw = warnInput.value.trim();
    const ok = /^\d{1,2}(\.\d{1,2})?$/.test(raw) && Number(raw) <= 50;
    const pct = ok ? Dec.of(raw) : Dec.of(ctx.data.settings.warnPct);
    const plan = Dec.of(8000);
    const limit = plan.plus(plan.times(pct).div(100)).round(0);
    const p = pct.toString();
    const off = pct.isZero();
    const grow = off ? "0" : String(Math.max(0.35, Math.min(2.5, Number(p) / 4)));
    pc.querySelectorAll<HTMLElement>(".pc-seg.warn, .pc-ticks .warn").forEach((el) => (el.style.flexGrow = grow));
    pc.querySelector<HTMLElement>(".pc-ticks .good")!.textContent = money(plan);
    pc.querySelector<HTMLElement>(".pc-ticks .warn")!.textContent = off ? "" : money(limit);
    pc.querySelector("#pc-rules")!.innerHTML = `
      <li class="good"><span class="dot-status good"></span><div><strong>On plan or better</strong><span>Spent no more than planned, or earned at least the plan.</span></div><span class="pc-eg">paid up to ${money(plan)}</span></li>
      <li class="warn${off ? " off" : ""}"><span class="dot-status warn"></span><div><strong>A little worse</strong><span>${off ? "Off: with 0% there is no yellow." : `Up to ${esc(p)}% worse than the plan.`}</span></div><span class="pc-eg">${off ? "–" : `${money(plan.plus(1))} to ${money(limit)}`}</span></li>
      <li class="bad"><span class="dot-status bad"></span><div><strong>Behind plan</strong><span>${off ? "Anything worse than the plan." : `More than ${esc(p)}% worse.`}</span></div><span class="pc-eg">above ${money(limit)}</span></li>`;
    if (!ok && raw !== "") pc.querySelector("#pc-rules")!.insertAdjacentHTML("afterbegin", `<li class="pc-note small">Enter 0 to 50. Showing your saved ${esc(Dec.of(ctx.data.settings.warnPct).toString())}% until then.</li>`);
  };
  warnInput.addEventListener("input", drawRules);
  drawRules();
  pc.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = (formValues(pc).warn ?? "").trim();
    const problem = !/^\d{1,2}(\.\d{1,2})?$/.test(raw) || Number(raw) > 50 ? "Enter a number from 0 to 50 (for example 5 or 7.5)." : null;
    formError(pc, problem);
    if (problem) return;
    if (Dec.of(raw).toString() === Dec.of(ctx.data.settings.warnPct).toString()) return toast("Nothing changed.", "info");
    await busy(pc, async () => {
      try {
        await ctx.api.rpc("set_settings", { p_warn_threshold_pct: raw, p_gold_adjust_pct: null });
        await ctx.reload();
        toast(`Saved. Yellow now means up to ${Dec.of(raw).toString()}% worse than the plan.`, "ok");
      } catch (err) {
        if (err instanceof ApiError && err.kind === "auth") ctx.fail(err);
        else formError(pc, err instanceof ApiError ? err.message : "Could not save.");
      }
    });
  });

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
