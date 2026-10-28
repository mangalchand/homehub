import { useEffect, useState } from 'react';
import { queryClient } from './queryClient';
import { hh } from './api';

const INVALIDATIONS: Record<string, string[][]> = {
  events: [['events'], ['conflicts']],
  calendars: [['calendars'], ['events']],
  calendar: [['calendars'], ['events'], ['sync']],
  sync: [['calendars'], ['events'], ['sync']],
  tasks: [['tasks'], ['approvals']],
  points: [['points'], ['approvals'], ['points-history']],
  rewards: [['rewards']],
  lists: [['lists']],
  photos: [['photos']],
  announcements: [['announcements']],
  notes: [['notes']],
  attachments: [['attachments']],
  summaries: [['summaries']],
  'family-call': [['family-call']],
  dashboard: [['dashboard']],
  notifications: [['notifications']],
  members: [['members'], ['household']],
  household: [['household'], ['me']],
  join: [['join'], ['me']],
};

/** Subscribes to the household SSE stream and invalidates affected queries. Reconnects with backoff. */
export function useRealtime(householdId: string | null) {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!householdId) return;
    let es: EventSource | null = null;
    let retry = 1000;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource(hh(householdId, '/stream'), { withCredentials: true });
      es.onopen = () => {
        setConnected(true);
        retry = 1000;
        void queryClient.invalidateQueries();
      };
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string };
          const prefix = msg.type.split('.')[0]!;
          for (const key of INVALIDATIONS[prefix] ?? []) void queryClient.invalidateQueries({ queryKey: key });
        } catch {
          /* heartbeat */
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) timer = window.setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      es?.close();
    };
  }, [householdId]);
  return connected;
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
