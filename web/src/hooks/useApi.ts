import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

export interface ApiQuery<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch (used after mutations and by the live-update streams). */
  refresh: () => void;
}

/** Small data-fetching hook: GET `path`, refetch on demand or when `path` changes. */
export function useApiQuery<T>(path: string | null): ApiQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const mine = ++generation.current;
    setLoading(true);
    api<T>(path)
      .then((result) => {
        if (generation.current === mine) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (generation.current === mine) {
          setError(err instanceof Error ? err.message : "Request failed");
          setLoading(false);
        }
      });
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refresh: load };
}

/** Upload one file plus fields as multipart/form-data (CSRF handled). */
export async function uploadFile<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<T> {
  const csrfRes = await fetch("/api/csrf", { credentials: "include" });
  const { token } = (await csrfRes.json()) as { token: string };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", file);
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "x-csrf-token": token },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string; issues?: string[] };
  if (!res.ok) {
    const detail = body.issues?.join("; ") ?? body.message ?? body.error ?? `Upload failed (${res.status})`;
    throw new Error(detail);
  }
  return body;
}
