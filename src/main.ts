import "./styles.css";
import { Api, ApiError } from "./lib/api.ts";
import { esc, toast } from "./lib/dom.ts";
import { getToken, setToken } from "./lib/session.ts";
import { loadData, loadProfile, type AppData } from "./lib/store.ts";
import { renderLogin, renderSignup } from "./ui/auth.ts";
import type { Ctx } from "./ui/context.ts";
import { renderGold } from "./ui/gold.ts";
import { renderHistory } from "./ui/history.ts";
import { discardPlanDraft, hasUnsavedPlan, renderPlan } from "./ui/plan.ts";
import { loadingHtml, shellHtml } from "./ui/shell.ts";
import { renderDashboard } from "./ui/dashboard.ts";
import { applyTheme, renderSettings } from "./ui/simple.ts";
import { startMonthPickers } from "./ui/monthPicker.ts";

const app = document.getElementById("app")!;
const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

applyTheme();
startMonthPickers();

const SCREENS: Record<string, (root: HTMLElement, ctx: Ctx) => void> = {
  dashboard: renderDashboard,
  plan: renderPlan,
  gold: renderGold,
  history: renderHistory,
};

if (!url || !key) {
  app.innerHTML = `<main class="auth"><div class="card auth-card"><h1>Almost there</h1>
    <p>Set <code>SUPABASE_URL</code> and <code>SUPABASE_KEY</code> (Vercel env vars) or <code>.env.local</code> for local development, then rebuild.</p></div></main>`;
} else {
  start(new Api(url, key, getToken));
}

function start(api: Api): void {
  let data: AppData | null = null;
  let lastHash = location.hash;

  const parse = () => {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    return { name: parts[0] ?? "dashboard", params: parts.slice(1) };
  };

  const navigate = (hash: string) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  const signedOut = (message?: string) => {
    data = null;
    discardPlanDraft();
    setToken(null);
    if (message) toast(message, "info");
    navigate("#/login");
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.kind === "auth") return signedOut(e.message);
    console.error(e);
    toast(e instanceof ApiError ? e.message : "Something went wrong. Please try again.", "error");
  };

  const showLoadError = (e: unknown) => {
    const msg = e instanceof ApiError ? e.message : "Something went wrong.";
    app.innerHTML = `<main class="auth"><div class="card auth-card"><h1>Can't load your data</h1>
      <p class="muted">${esc(msg)}</p><button class="btn primary block" id="retry">Try again</button></div></main>`;
    app.querySelector("#retry")!.addEventListener("click", () => void boot());
  };

  const reload = async () => {
    if (!data) return;
    try {
      data = await loadData(api, data.profile);
    } catch (e) {
      fail(e);
      return;
    }
    render();
  };

  const render = () => {
    const { name, params } = parse();
    if (!data) {
      if (name === "signup") return renderSignup(app, api, () => void boot());
      return renderLogin(app, api, () => void boot());
    }
    if (name === "login" || name === "signup") return navigate("#/dashboard");
    // Log and Plan vs actual now live on the Plan page
    if (name === "log") return void location.replace(`#/plan/log/${params[0] ?? ""}`);
    if (name === "compare") return void location.replace(params[0] ? `#/plan/log/${params[0]}` : "#/plan");

    // a route change closes open panels/dialogs (marked so they don't navigate back)
    document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((d) => { d.dataset.closing = "route"; d.close(); });
    document.getElementById("grid-tip")?.classList.remove("show");
    document.getElementById("chart-tip")?.classList.remove("show");

    const active = name === "settings" || SCREENS[name] ? name : "dashboard";
    app.innerHTML = shellHtml(active, data.profile.full_name);
    const screen = app.querySelector<HTMLElement>("#screen")!;
    const ctx: Ctx = { api, data, params, reload, navigate, fail };
    try {
      if (active === "settings") renderSettings(screen, ctx, () => signedOut());
      else SCREENS[active]!(screen, ctx);
    } catch (e) {
      console.error(e);
      screen.innerHTML = `<div class="alert danger">This screen hit a problem. Try reloading the page.</div>`;
    }
    screen.focus({ preventScroll: true });
  };

  async function boot(): Promise<void> {
    if (!getToken()) {
      data = null;
      render();
      return;
    }
    app.innerHTML = loadingHtml();
    try {
      const profile = await loadProfile(api);
      if (!profile) return signedOut("Your session has ended. Please sign in again.");
      data = await loadData(api, profile);
      if (parse().name === "login" || parse().name === "signup" || !location.hash) location.replace("#/dashboard");
      render();
    } catch (e) {
      if (e instanceof ApiError && e.kind === "auth") return signedOut(e.message);
      console.error(e);
      showLoadError(e);
    }
  }

  // close an open "More" menu when clicking anywhere else
  document.addEventListener("click", (e) => {
    document.querySelectorAll<HTMLDetailsElement>("details.menu[open]").forEach((m) => {
      if (!m.contains(e.target as Node) || (e.target as HTMLElement).closest(".menu-list button")) m.open = false;
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll<HTMLDetailsElement>("details.menu[open]").forEach((m) => (m.open = false));
  });

  // Sign out from the sidebar (desktop) or the top bar (phone)
  app.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-logout]");
    if (!btn) return;
    if (hasUnsavedPlan() && !confirm("You have unsaved plan changes. Sign out and discard them?")) return;
    btn.disabled = true;
    try {
      await api.rpc("app_logout");
    } catch {
      // the server may be unreachable; signing out on this device is still correct
    }
    signedOut("Signed out.");
  });

  window.addEventListener("hashchange", () => {
    // leaving the plan editor with unsaved changes
    if (lastHash.startsWith("#/plan/edit") && !location.hash.startsWith("#/plan/edit") && hasUnsavedPlan()) {
      if (!confirm("You have unsaved plan changes. Leave and discard them?")) {
        history.replaceState(null, "", lastHash);
        return;
      }
      discardPlanDraft();
    }
    lastHash = location.hash;
    render();
    window.scrollTo(0, 0);
  });
  window.addEventListener("beforeunload", (e) => {
    if (hasUnsavedPlan()) e.preventDefault();
  });
  window.addEventListener("unhandledrejection", (e) => fail(e.reason));

  void boot();
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker not registered", e));
  });
}
