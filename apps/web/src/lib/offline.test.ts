import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { enqueueMutation, flushQueue, pendingCount, type QueuedMutation } from './offline';

const state = vi.hoisted(() => ({ queue: [] as QueuedMutation[] }));
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(),
  get: async () => state.queue,
  set: async (_key: string, value: QueuedMutation[]) => { state.queue = value; },
}));
beforeEach(() => {
  state.queue = [];
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('online-only household actions', () => {
  it.each(['/safety', '/safety/session/location', '/safety/session/stop', '/tasks/task/attachments'])('never queues %s', async (suffix) => {
    const path = `/api/v1/households/home${suffix}`;
    await expect(enqueueMutation({ path, method: 'POST', body: {} })).rejects.toThrow('online acknowledgement');
    await expect(api(path, { method: 'POST', body: {}, offlineQueue: true })).rejects.toMatchObject({ code: 'ONLINE_REQUIRED' });
    expect(await pendingCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('discards previously stored location mutations instead of replaying them', async () => {
    state.queue = [{ id: 'old', path: '/api/v1/households/home/safety/old/location', method: 'PATCH', body: {}, queuedAt: 0, attempts: 0 }];
    const result = vi.fn();
    await flushQueue(result);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }), 400);
    expect(await pendingCount()).toBe(0);
  });
});
