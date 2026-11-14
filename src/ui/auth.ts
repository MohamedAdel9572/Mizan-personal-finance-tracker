import { ApiError, type Api } from "../lib/api.ts";
import { busy, esc, formError, formValues } from "../lib/dom.ts";
import { normMobile, passwordProblem, setToken } from "../lib/session.ts";

function authPage(title: string, sub: string, body: string): string {
  return `<main class="auth">
    <div class="auth-card card">
      <div class="brand big"><span class="logo" aria-hidden="true">⚖</span> Mizan</div>
      <h1>${esc(title)}</h1>
      <p class="muted">${esc(sub)}</p>
      ${body}
    </div>
  </main>`;
}

function mobileProblem(raw: string): string | null {
  const m = normMobile(raw);
  return m.length < 8 || m.length > 15 ? "Please enter a valid mobile number." : null;
}

export function renderLogin(root: HTMLElement, api: Api, onSignedIn: () => void): void {
  root.innerHTML = authPage("Sign in", "Track your plan, your real numbers and your goal.", `
    <form id="login" novalidate>
      <label>Mobile number<input name="mobile" type="tel" inputmode="tel" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary block" type="submit">Sign in</button>
    </form>
    <p class="center small">No account yet? <a href="#/signup">Create one</a></p>`);

  const form = root.querySelector<HTMLFormElement>("#login")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formValues(form);
    const problem = mobileProblem(f.mobile ?? "") ?? (f.password ? null : "Please enter your password.");
    formError(form, problem);
    if (problem) return;
    await busy(form, async () => {
      try {
        const res = await api.rpc<{ token?: string; error?: string }>("app_login", {
          p_mobile: normMobile(f.mobile ?? ""),
          p_password: f.password,
        });
        if (!res.token) {
          formError(form, res.error ?? "Sign in failed.");
          return;
        }
        setToken(res.token);
        onSignedIn();
      } catch (err) {
        formError(form, err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    });
  });
}

export function renderSignup(root: HTMLElement, api: Api, onSignedIn: () => void): void {
  root.innerHTML = authPage("Create account", "Your data is private: only you can ever see it.", `
    <form id="signup" novalidate>
      <label>Full name<input name="full_name" autocomplete="name" maxlength="80" required></label>
      <label>Mobile number<input name="mobile" type="tel" inputmode="tel" autocomplete="username" required></label>
      <label>Password <span class="muted small">(8 or more characters)</span>
        <input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required></label>
      <label>Repeat password<input name="password2" type="password" autocomplete="new-password" required></label>
      <button class="btn primary block" type="submit">Create account</button>
    </form>
    <p class="center small">Already registered? <a href="#/login">Sign in</a></p>`);

  const form = root.querySelector<HTMLFormElement>("#signup")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formValues(form);
    const problem =
      (!(f.full_name ?? "").trim() ? "Please enter your name." : null) ??
      mobileProblem(f.mobile ?? "") ??
      passwordProblem(f.password ?? "") ??
      (f.password !== f.password2 ? "The two passwords don't match." : null);
    formError(form, problem);
    if (problem) return;
    await busy(form, async () => {
      try {
        const token = await api.rpc<string>("app_signup", {
          p_full_name: (f.full_name ?? "").trim(),
          p_mobile: normMobile(f.mobile ?? ""),
          p_password: f.password,
        });
        setToken(token);
        onSignedIn();
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
        formError(form, msg.startsWith("Sign-up is closed") ? "Sign-up is closed." : msg);
      }
    });
  });
}
