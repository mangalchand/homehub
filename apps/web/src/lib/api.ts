import type { ApiError } from '@familyhub/shared';
import { enqueueMutation } from './offline';

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function getCsrf(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  const res = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
  const body = (await res.json()) as { csrfToken: string };
  csrfToken = body.csrfToken;
  return csrfToken;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Queue the mutation in IndexedDB if the network is unavailable (safe for idempotent mutations). */
  offlineQueue?: boolean;
  formData?: FormData;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await getCsrf();
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers,
      body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    if (opts.offlineQueue && method !== 'GET') {
      await enqueueMutation({ path, method, body: opts.body });
      return { queued: true } as T;
    }
    throw new ApiRequestError(0, 'NETWORK', 'You appear to be offline');
  }
  if (res.status === 403 && method !== 'GET' && !retried) {
    const clone = (await res.clone().json().catch(() => null)) as ApiError | null;
    if (clone?.error.code === 'CSRF') {
      await getCsrf(true);
      return api<T>(path, opts, true);
    }
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = (data as ApiError)?.error;
    throw new ApiRequestError(res.status, e?.code ?? 'ERROR', e?.message ?? res.statusText, e?.details);
  }
  return data as T;
}

export const resetCsrf = () => {
  csrfToken = null;
};

export const hh = (householdId: string, path: string) => `/api/v1/households/${householdId}${path}`;
