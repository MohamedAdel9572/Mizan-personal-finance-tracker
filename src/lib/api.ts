/**
 * Minimal PostgREST client. We only call RPC functions, with the session token
 * in the x-mizan-session header (same pattern as skn-clinic). supabase-js
 * would add an auth layer we don't use, so a small typed fetch wrapper is enough.
 */

export type ApiErrorKind = "network" | "timeout" | "auth" | "validation" | "server";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const SIGNED_OUT_MESSAGE = "Please sign in first.";
const TIMEOUT_MS = 20_000;

/** Postgres error codes we can explain to a person; anything else gets a generic message. */
function friendly(code: string | undefined, message: string | undefined): ApiError {
  if (message === SIGNED_OUT_MESSAGE) return new ApiError("auth", "Your session has ended. Please sign in again.", code);
  // P0001 = raise exception in our SQL functions: those messages are written for people
  if (code === "P0001" && message) return new ApiError("validation", message, code);
  switch (code) {
    case "23505": return new ApiError("validation", "That already exists.", code);
    case "23514":
    case "23502":
    case "22P02":
    case "22008": return new ApiError("validation", "Some of the values are not allowed. Please check the form.", code);
    case "42501": return new ApiError("auth", "You don't have access to that.", code);
    case "PGRST202": return new ApiError("server", "The app and the database are out of sync. Run the latest SQL migrations.", code);
    default: return new ApiError("server", "Something went wrong. Please try again.", code);
  }
}

export class Api {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly getToken: () => string,
  ) {}

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const headers: Record<string, string> = { apikey: this.key, "Content-Type": "application/json" };
    const token = this.getToken();
    if (token) headers["x-mizan-session"] = token;

    let res: Response;
    try {
      res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new ApiError("timeout", "The server took too long to answer. Please try again.");
      console.error(`rpc ${fn} network error`, e);
      throw new ApiError("network", "Can't reach the server. Check your internet connection.");
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        console.error(`rpc ${fn}: not JSON`, text.slice(0, 200));
        throw new ApiError("server", "The server sent an unexpected answer. Please try again.");
      }
    }
    if (!res.ok) {
      const err = (body ?? {}) as { code?: string; message?: string };
      console.error(`rpc ${fn} failed`, res.status, err);
      throw friendly(err.code, err.message);
    }
    return body as T;
  }
}
