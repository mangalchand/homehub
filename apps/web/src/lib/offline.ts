import { createStore, get, set } from 'idb-keyval';

/** Durable FIFO of mutations made while offline; replayed in order when connectivity returns. */
export interface QueuedMutation {
  id: string;
  path: string;
  method: string;
  body?: unknown;
  queuedAt: number;
  attempts: number;
}

const store = createStore('familyhub-offline', 'mutations');
const KEY = 'queue';
const listeners = new Set<(n: number) => void>();

export const requiresOnlineAcknowledgement = (path: string) => /\/(safety|attachments)(?:\/|$|\?)/.test(path);

async function read(): Promise<QueuedMutation[]> {
  return ((await get(KEY, store)) as QueuedMutation[] | undefined) ?? [];
}
async function write(q: QueuedMutation[]) {
  await set(KEY, q, store);
  listeners.forEach((l) => l(q.length));
}

export async function enqueueMutation(m: { path: string; method: string; body?: unknown }) {
  if (requiresOnlineAcknowledgement(m.path)) throw new Error('Safety actions and image uploads require an online acknowledgement');
  const q = await read();
  q.push({ ...m, id: crypto.randomUUID(), queuedAt: Date.now(), attempts: 0 });
  await write(q);
}

export async function pendingCount() {
  return (await read()).length;
}

export function onQueueChange(fn: (n: number) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let flushing = false;
/** Replays queued mutations. Conflicts (409) and validation errors are dropped and reported; network errors stop the flush. */
export async function flushQueue(onResult?: (m: QueuedMutation, status: number) => void) {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const { api, ApiRequestError } = await import('./api');
    let q = await read();
    while (q.length) {
      const m = q[0]!;
      try {
        if (requiresOnlineAcknowledgement(m.path)) onResult?.(m, 400);
        else {
          await api(m.path, { method: m.method as 'POST', body: m.body });
          onResult?.(m, 200);
        }
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 0) break;
        onResult?.(m, err instanceof ApiRequestError ? err.status : 500);
      }
      q = (await read()).filter((x) => x.id !== m.id);
      await write(q);
    }
  } finally {
    flushing = false;
  }
}
