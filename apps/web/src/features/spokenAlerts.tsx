import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Volume2, Square } from 'lucide-react';
import { api, hh } from '@/lib/api';
import { useHid, useMe } from '@/lib/queries';
import { currentVoiceSession, deviceNotifications, householdActor, notificationReading, readNotifications, readPoints, voiceError, voiceScope, type FeedNotification } from '@/lib/voice/household';
import { isListening, isSpeaking, speak, stopSpeaking } from '@/lib/voice/speech';
import { Button } from '@/components/ui/button';

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

/** Mount at most once in the paired display shell. Never listens to the microphone. */
export function SpokenAlertsControl() {
  const hid = useHid();
  const me = useMe().data;
  const actor = hid ? householdActor(me, hid) : null;
  if (!hid || actor?.kind !== 'device') return null;
  return <DeviceSpokenAlerts key={`${hid}:${actor.deviceId}`} householdId={hid} deviceId={actor.deviceId} />;
}

function DeviceSpokenAlerts({ householdId: hid, deviceId }: { householdId: string; deviceId: string }) {
  const key = spokenAlertKey(hid, deviceId);
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } });
  const [armed, setArmed] = useState(false);
  const [storageError, setStorageError] = useState('');
  const tracker = useRef(new SpokenAlertTracker());
  const speech = useReadAloud(key);
  const { read, stop, busy, error } = speech;
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
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    const pause = () => { tracker.current.reset(); setArmed(false); stop(); };
    const visibility = () => { if (document.hidden) pause(); };
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('offline', pause); document.removeEventListener('visibilitychange', visibility); };
  }, [stop]);

  useEffect(() => {
    if (notifications.isError || error) { tracker.current.reset(); setArmed(false); stop(); }
  }, [notifications.isError, error, stop]);

  useEffect(() => {
    if (!enabled || !armed || !notifications.data || notifications.isFetching) return;
    const fresh = tracker.current.accept(notifications.data);
    // Drop, rather than queue, arrivals while another read is in progress.
    if (fresh.length && !busyRef.current && !isSpeaking() && !isListening()) void read(() => notificationReading(fresh));
  }, [enabled, armed, notifications.data, notifications.dataUpdatedAt, notifications.isFetching, read]);

  const persist = (value: boolean) => {
    try { localStorage.setItem(key, String(value)); setStorageError(''); }
    catch { setStorageError('This browser could not save the setting. It applies only until this page closes.'); }
    setEnabled(value);
  };
  const pause = () => { setArmed(false); tracker.current.reset(); stop(); };
  const enable = () => { persist(true); tracker.current.reset(); setArmed(true); void read(() => 'Spoken household alerts enabled. Only new alerts will be read.'); };

  return <section aria-label="Spoken household alerts" className="space-y-2 rounded-xl border p-3">
    <p className="text-sm font-semibold">Spoken household alerts: {enabled && armed ? 'on' : enabled ? 'paused' : 'off'}</p>
    <p className="text-xs text-muted-foreground">Optional on this display only. Reads new household alerts, not personal inboxes. No microphone recording. Resume after reconnecting or returning to this screen.</p>
    <div className="flex flex-wrap gap-2">
      {(!enabled || !armed) && <Button size="sm" variant="outline" onClick={enable}>{enabled ? 'Resume spoken alerts' : 'Enable spoken alerts'}</Button>}
      {armed && <Button size="sm" variant="outline" onClick={pause}>Stop spoken alerts</Button>}
      {enabled && <Button size="sm" variant="outline" onClick={() => { persist(false); pause(); }}>Disable spoken alerts</Button>}
    </div>
    {(error || notifications.error || storageError) && <p role="alert" className="text-sm text-destructive">{error || (notifications.error ? voiceError(notifications.error) : storageError)}</p>}
  </section>;
}
