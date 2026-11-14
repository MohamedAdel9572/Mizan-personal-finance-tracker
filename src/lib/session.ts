// The session token lives in this browser only. The database stores just its sha256.
const TOKEN_KEY = "mizan_session";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode / storage blocked: the user just has to sign in again next time
  }
}

/** Same rules as private.norm_mobile() in SQL. */
export function normMobile(input: string): string {
  const d = input.replace(/\D/g, "");
  if (/^201\d{9}$/.test(d)) return "0" + d.slice(2);
  if (/^1\d{9}$/.test(d)) return "0" + d;
  return d;
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 72) return "Password must be at most 72 characters.";
  return null;
}
