import { EventEmitter } from 'node:events';
import type { Response } from 'express';

export interface RealtimeMessage {
  type: string; // e.g. "lists.changed", "events.changed", "tasks.changed", "calendars.synced"
  entityId?: string;
  data?: Record<string, unknown>;
}

/**
 * In-process pub/sub keyed by household. A single API instance is the default deployment;
 * for multiple instances, swap this for Postgres LISTEN/NOTIFY or Redis pub/sub behind the same interface.
 */
class RealtimeBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(householdId: string, message: RealtimeMessage) {
    this.emitter.emit(householdId, { ...message, at: new Date().toISOString() });
  }
  subscribe(householdId: string, fn: (m: RealtimeMessage) => void) {
    this.emitter.on(householdId, fn);
    return () => this.emitter.off(householdId, fn);
  }
  listenerCount(householdId: string) {
    return this.emitter.listenerCount(householdId);
  }
  disconnectActor(householdId: string, actorId: string) {
    this.emitter.emit(`disconnect:${householdId}:${actorId}`);
  }
  onDisconnect(householdId: string, actorId: string, fn: () => void) {
    const key = `disconnect:${householdId}:${actorId}`;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }
}

export const realtime = new RealtimeBus();

export function openSseStream(res: Response, householdId: string, filter?: (m: RealtimeMessage) => boolean, actorId?: string) {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: 5000\n\n`);
  const send = (m: RealtimeMessage) => {
    if (filter && !filter(m)) return;
    res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  };
  const unsubscribe = realtime.subscribe(householdId, send);
  const stop = actorId ? realtime.onDisconnect(householdId, actorId, () => { send({ type: 'household.changed' }); res.end(); }) : undefined;
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    stop?.();
  });
}
