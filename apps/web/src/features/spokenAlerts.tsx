import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Volume2, Square } from 'lucide-react';
import { api, hh } from '@/lib/api';
import { useHid, useMe } from '@/lib/queries';
import { currentVoiceSession, deviceNotifications, householdActor, notificationReading, readNotifications, readPoints, voiceError, voiceScope, type FeedNotification } from '@/lib/voice/household';
import { isListening, isSpeaking, speak, stopSpeaking } from '@/lib/voice/speech';
import { Button } from '@/components/ui/button';
import { isNativeApp } from '@/lib/nativePush';

/** Scope changes invalidate pending fetches as well as cancelling speech. */
export function useReadAloud(scope: string | null) {
  const operation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const cancel = useCallback(() => { operation.current++; stopSpeaking(); }, []);
  const stop = useCallback(() => { cancel(); setBusy(false); }, [cancel]);
  useEffect(() => {
    cancel();
    setBusy(false); setError(''); setText('');
    return cancel;
  }, [scope, cancel]);
  const read = useCallback(async (load: () => string | Promise<string>) => {
    if (!scope) return;
    const op = ++operation.current;
    stopSpeaking(); setBusy(true); setError(''); setText('');
    try {
      const value = await load();
      if (operation.current !== op) return;
      setText(value);
      await speak(value);
    } catch (e) {
      if (operation.current === op) setError(voiceError(e));
    } finally { if (operation.current === op) setBusy(false); }
  }, [scope]);
  return { read, stop, busy, error, text };
}

export function ReadAloudButton({ scope, load, label = 'Read aloud' }: { scope: string | null; load: () => string | Promise<string>; label?: string }) {
  const speech = useReadAloud(scope);
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!scope || speech.busy} onClick={() => void speech.read(load)}><Volume2 />{label}</Button>
      {speech.busy && <Button size="sm" variant="outline" onClick={speech.stop}><Square />Stop reading</Button>}
    </div>
    {speech.error && <p role="alert" className="text-sm text-destructive">{speech.error}</p>}
    {speech.text && <p className="max-h-32 overflow-auto text-sm text-muted-foreground">{speech.text}</p>}
  </div>;
}

/** Place on a rewards member card; omit memberId for the signed-in user's own points. */
export function PointsReadAloudButton({ memberId }: { memberId?: string }) {
  const hid = useHid();
  const me = useMe().data;
  return <ReadAloudButton scope={hid ? voiceScope(me, hid) : null} load={() => readPoints(hid!, { memberId })} label="Read points aloud" />;
}

/** Loads the current session's feed, never a previously cached personal inbox. */
export function NotificationsReadAloudButton() {
  const hid = useHid();
  const me = useMe().data;
  return <ReadAloudButton scope={hid ? voiceScope(me, hid) : null} load={() => readNotifications(hid!)} label="Read notifications aloud" />;
}

export const spokenAlertKey = (hid: string, deviceId: string) => `familyhub-spoken-alerts:${hid}:${deviceId}`;

/** Only fresh, unread arrivals after a baseline, never initial/reconnected history. */
export class SpokenAlertTracker {
  private seen: Set<string> | null = null;
  private watermark = 0;
  reset() { this.seen = null; this.watermark = 0; }
  accept(items: FeedNotification[], now = Date.now()) {
    const first = this.seen === null;
    const seen = this.seen ?? new Set<string>();
    const fresh = first ? [] : items.filter((n) => !seen.has(n.id) && !n.readAt && Date.parse(n.createdAt) > this.watermark && now - Date.parse(n.createdAt) < 60_000 && Date.parse(n.createdAt) <= now);
    for (const n of items) seen.add(n.id);
    this.seen = seen;
    this.watermark = Math.max(this.watermark, ...items.map((n) => Date.parse(n.createdAt)).filter(Number.isFinite));
    return fresh.slice(0, 3);
  }
}

type AlertsState = { enabled: boolean; armed: boolean; error: string };
const alertListeners = new Set<() => void>();
let alertState: AlertsState = { enabled: false, armed: false, error: '' };
const setAlertState = (patch: Partial<AlertsState>) => { alertState = { ...alertState, ...patch }; alertListeners.forEach((l) => l()); };
const subscribeAlerts = (l: () => void) => { alertListeners.add(l); return () => { alertListeners.delete(l); }; };
const useAlertState = () => useSyncExternalStore(subscribeAlerts, () => alertState);
const readStored = (key: string) => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } };

function useDisplayActor() {
  const hid = useHid();
  const me = useMe().data;
  const actor = hid ? householdActor(me, hid) : null;
  return hid && actor?.kind === 'device' ? { hid, deviceId: actor.deviceId } : null;
}

/** Mount once in the display shell so alerts keep being read on every page and after the screen wakes. Never listens to the microphone. */
export function SpokenAlertsRunner() {
  const d = useDisplayActor();
  return d ? <DeviceSpokenAlerts key={d.hid + ':' + d.deviceId} householdId={d.hid} deviceId={d.deviceId} /> : null;
}

function DeviceSpokenAlerts({ householdId: hid, deviceId }: { householdId: string; deviceId: string }) {
  const key = spokenAlertKey(hid, deviceId);
  const { enabled, armed } = useAlertState();
  const tracker = useRef(new SpokenAlertTracker());
  const { read, stop, busy, error } = useReadAloud(key);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const notifications = useQuery({
    queryKey: ['spoken-household-alerts', hid, deviceId],
    queryFn: async () => {
      const me = await currentVoiceSession(hid);
      if (me.kind !== 'device' || me.device?.id !== deviceId) throw new Error('The display session changed. Spoken alerts stopped.');
      return deviceNotifications(await api<FeedNotification[]>(hh(hid, '/notifications')), hid);
    },
    enabled: enabled && armed,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    setAlertState({ enabled: readStored(key), armed: false, error: '' });
    return () => setAlertState({ enabled: false, armed: false, error: '' });
  }, [key]);

  useEffect(() => { tracker.current.reset(); }, [armed]);

  // The native app speaks without a gesture, so it re-arms whenever the screen wakes or the network returns.
  // Browsers block audio until the first tap on the page.
  useEffect(() => {
    if (!enabled || armed) return;
    const arm = () => { if (!document.hidden && navigator.onLine !== false) setAlertState({ armed: true, error: '' }); };
    if (isNativeApp()) {
      if (!alertState.error) arm();
      document.addEventListener('visibilitychange', arm);
      window.addEventListener('online', arm);
      return () => { document.removeEventListener('visibilitychange', arm); window.removeEventListener('online', arm); };
    }
    window.addEventListener('pointerdown', arm);
    return () => window.removeEventListener('pointerdown', arm);
  }, [enabled, armed]);

  useEffect(() => {
    const pause = () => { setAlertState({ armed: false }); stop(); };
    const visibility = () => { if (document.hidden) pause(); };
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('offline', pause); document.removeEventListener('visibilitychange', visibility); };
  }, [stop]);

  useEffect(() => {
    if (notifications.isError || error) { setAlertState({ armed: false, error: error || voiceError(notifications.error) }); stop(); }
  }, [notifications.isError, notifications.error, error, stop]);

  useEffect(() => {
    if (!enabled || !armed || !notifications.data || notifications.isFetching) return;
    const fresh = tracker.current.accept(notifications.data);
    // Drop, rather than queue, arrivals while another read is in progress.
    if (fresh.length && !busyRef.current && !isSpeaking() && !isListening()) void read(() => notificationReading(fresh));
  }, [enabled, armed, notifications.data, notifications.dataUpdatedAt, notifications.isFetching, read]);
  return null;
}

/** Settings control for the display-wide spoken alerts runner. */
export function SpokenAlertsControl() {
  const d = useDisplayActor();
  return d ? <SpokenAlertsSettings key={d.hid + ':' + d.deviceId} householdId={d.hid} deviceId={d.deviceId} /> : null;
}

function SpokenAlertsSettings({ householdId: hid, deviceId }: { householdId: string; deviceId: string }) {
  const key = spokenAlertKey(hid, deviceId);
  const { enabled, armed, error } = useAlertState();
  const [storageError, setStorageError] = useState('');
  const persist = (value: boolean) => {
    try { localStorage.setItem(key, String(value)); setStorageError(''); }
    catch { setStorageError('This browser could not save the setting. It applies only until this page closes.'); }
    setAlertState({ enabled: value, armed: value, error: '' });
    if (!value) stopSpeaking();
  };
  const enable = () => {
    persist(true);
    void speak('Spoken household alerts are on. New alerts and the daily summary will be read on every screen.').catch((e) => setAlertState({ error: voiceError(e) }));
  };
  return <section aria-label="Spoken household alerts" className="space-y-2 rounded-xl border p-3">
    <p className="text-sm font-semibold">Spoken household alerts: {enabled && armed ? 'on' : enabled ? 'waiting' : 'off'}</p>
    <p className="text-xs text-muted-foreground">On this display only, new household alerts, announcements and the daily summary are read aloud on every screen, including the photo screensaver. Personal inboxes are never read. The microphone is not used.{enabled && !armed ? ' Tap the screen to resume after the display wakes.' : ''}</p>
    <div className="flex flex-wrap gap-2">
      {(!enabled || !armed) && <Button size="sm" variant="outline" onClick={enable}>{enabled ? 'Resume spoken alerts' : 'Enable spoken alerts'}</Button>}
      {enabled && <Button size="sm" variant="outline" onClick={() => persist(false)}>Disable spoken alerts</Button>}
    </div>
    {(error || storageError) && <p role="alert" className="text-sm text-destructive">{error || storageError}</p>}
  </section>;
}
