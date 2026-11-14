import { esc } from "../lib/dom.ts";

export interface NavItem {
  route: string;
  label: string;
  icon: string;
  /** shown in the mobile bottom bar (max 5) */
  mobile: boolean;
}

// Simple inline SVG icons (stroke = currentColor) so they follow light/dark mode.
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const NAV: NavItem[] = [
  { route: "dashboard", label: "Dashboard", mobile: true, icon: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>') },
  { route: "plan", label: "Plan", mobile: true, icon: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>') },
  { route: "plan/log", label: "Log", mobile: true, icon: svg('<path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="9"/>') },
  { route: "gold", label: "Gold", mobile: true, icon: svg('<path d="M3 18h18l-3-6H6z"/><path d="M8 12l2-5h4l2 5"/>') },
  { route: "history", label: "History", mobile: true, icon: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') },
];

const logoutIcon = svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>');

const settingsIcon = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>');

export function shellHtml(active: string, userName: string): string {
  const link = (n: NavItem, cls: string) =>
    `<a class="${cls}${n.route === active ? " active" : ""}" href="#/${n.route}"${n.route === active ? ' aria-current="page"' : ""}>${n.icon}<span>${esc(n.label)}</span></a>`;
  return `
  <div class="layout">
    <aside class="sidebar" aria-label="Main">
      <div class="brand"><span class="logo" aria-hidden="true">⚖</span> Mizan</div>
      <nav>${NAV.filter((n) => n.route !== "plan/log").map((n) => link(n, "side-link")).join("")}</nav>
      <div class="side-account">
        <a class="side-link${active === "settings" ? " active" : ""}" href="#/settings">${settingsIcon}<span>${esc(userName)}</span></a>
        <button type="button" class="side-link logout" data-logout>${logoutIcon}<span>Sign out</span></button>
      </div>
    </aside>
    <div class="main-col">
      <header class="topbar">
        <div class="brand"><span class="logo" aria-hidden="true">⚖</span> Mizan</div>
        <div class="topbar-actions">
          <a class="icon-btn${active === "settings" ? " active" : ""}" href="#/settings" aria-label="Settings">${settingsIcon}</a>
          <button type="button" class="icon-btn" data-logout aria-label="Sign out" title="Sign out">${logoutIcon}</button>
        </div>
      </header>
      <main id="screen" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Main">${NAV.filter((n) => n.mobile).map((n) => link(n, "tab")).join("")}</nav>
  </div>`;
}

export function loadingHtml(text = "Loading…"): string {
  return `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
}
