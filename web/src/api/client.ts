/**
 * Same-origin API client for the Massy Purchasing backend.
 *
 * - Cookies always sent (`credentials: "include"`).
 * - CSRF: a token is fetched lazily from GET /api/csrf and sent as the
 *   `x-csrf-token` header on every non-GET request (A.8.28). If the server
 *   rejects a stale token (403), the token is refreshed once and the request
 *   retried.
 * - Session expiry (A.8.5): any 401 invokes the globally registered
 *   unauthorized handler (unless the caller opts out), which returns the UI
 *   to the login page with a "session expired" message.
 */

const CSRF_HEADER = "x-csrf-token";

export class ApiError extends Error {
  readonly status: number;
  /** Per-item validation issues (e.g. DOA/budget upload or activation 422s). */
  readonly issues: string[];

  constructor(status: number, message?: string, issues: string[] = []) {
    super(message ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Registered once by the auth provider; fired on any notifying 401. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

let csrfToken: string | null = null;

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch("/api/csrf", { credentials: "include" });
  if (!response.ok) {
    throw new ApiError(response.status, "Could not obtain a CSRF token");
  }
  const body = (await response.json()) as { token: string };
  csrfToken = body.token;
  return body.token;
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serialisable request body. */
  body?: unknown;
  /**
   * "notify" (default): a 401 fires the global session-expired handler.
   * "silent": the caller interprets the 401 itself (e.g. the initial
   * GET /api/me probe, where 401 simply means "not signed in yet").
   */
  on401?: "notify" | "silent";
}

export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";

  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (method !== "GET") {
      headers[CSRF_HEADER] = csrfToken ?? (await fetchCsrfToken());
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return fetch(path, {
      method,
      credentials: "include",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  };

  let response = await attempt();

  // A 403 on a mutating request most likely means a stale CSRF token
  // (e.g. after a server restart) — refresh the token and retry once.
  if (response.status === 403 && method !== "GET") {
    csrfToken = null;
    response = await attempt();
  }

  if (response.status === 401) {
    if ((options.on401 ?? "notify") === "notify") {
      unauthorizedHandler?.();
    }
    throw new ApiError(401, "Not authenticated");
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let issues: string[] = [];
    try {
      const data = (await response.json()) as { message?: string; error?: string; issues?: unknown };
      message = data.message ?? data.error ?? message;
      // Validation-style errors carry the actual problems in `issues`;
      // swallowing them left users with a bare slug like "revalidation_failed"
      // and no idea what to fix (workflow-consistency review finding).
      if (Array.isArray(data.issues)) {
        issues = data.issues.filter((i): i is string => typeof i === "string");
        if (issues.length > 0) {
          const shown = issues.slice(0, 5);
          message = `${message}: ${shown.join("; ")}${issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : ""}`;
        }
      }
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(response.status, message, issues);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
