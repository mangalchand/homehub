import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { openSseStream, realtime } from '../../src/lib/realtime.js';

describe('revoking realtime access', () => {
  it('closes only the removed actor’s household stream and unsubscribes it', () => {
    const events = new EventEmitter();
    const res = Object.assign(events, { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(() => events.emit('close')) });
    openSseStream(res as unknown as Response, 'home', undefined, 'member');
    realtime.disconnectActor('another-home', 'member');
    realtime.disconnectActor('home', 'another-member');
    expect(res.end).not.toHaveBeenCalled();
    realtime.disconnectActor('home', 'member');
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('household.changed'));
    expect(realtime.listenerCount('home')).toBe(0);
    res.write.mockClear();
    realtime.publish('home', { type: 'lists.changed' });
    expect(res.write).not.toHaveBeenCalled();
  });
});
