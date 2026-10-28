import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EmergencySessionDTO } from '@familyhub/shared';
import { AlertTriangle, MapPin } from 'lucide-react';
import { api, ApiRequestError, hh } from '@/lib/api';
import { useHid, useMe } from '@/lib/queries';
import { householdActor } from '@/lib/voice/household';
import { watchSafetyLocation, type LocationState } from '@/lib/safetyLocation';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

export interface SafetySession extends EmergencySessionDTO {
  sender: string;
  status: 'active' | 'stopped' | 'expired';
  locationStatus: 'live' | 'stale' | 'unavailable' | 'stopped';
  isOrigin: boolean;
  canStop: boolean;
}
const WARNING =
  'Not monitored emergency dispatch. Delivery is not guaranteed. If you need emergency services, contact them directly.';
export const SAFETY_POLL_INTERVAL_MS = 15_000;
export const SAFETY_FIX_STALE_MS = 2 * 60_000;
export const safetyLocationConsentKey = (householdId: string, actorId: string) =>
  `familyhub-safety-location-consent:${householdId}:${actorId}`;
const Context = createContext<{
  householdId: string | null;
  sessions: SafetySession[];
  error: string | null;
  connected: boolean;
  verified: boolean;
  locationState: LocationState;
  sharingId: string | null;
  start: (share: boolean) => Promise<void>;
  stop: (id: string) => Promise<void>;
  share: (id: string) => void;
} | null>(null);

function online() {
  return navigator.onLine;
}
function isForeground() {
  return document.visibilityState !== 'hidden';
}

/** Mount once INSIDE the authenticated shell, outside route elements. Never persists locations to QueryClient/IndexedDB. */
export function SafetyProvider({ children }: { children: ReactNode }) {
  const householdId = useHid();
  // Keyed child guarantees immediate home-change teardown, including outstanding native permission prompts.
  return (
    <SafetyHouseholdProvider key={householdId ?? 'none'} householdId={householdId}>
      {children}
    </SafetyHouseholdProvider>
  );
}

function SafetyHouseholdProvider({
  householdId,
  children,
}: {
  householdId: string | null;
  children: ReactNode;
}) {
  const [sessions, setSessions] = useState<SafetySession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [verified, setVerified] = useState(false);
  const [consentId, setConsentId] = useState<string | null>(null);
  const [locationState, setLocationState] = useState<LocationState>('stopped');
  const [foreground, setForeground] = useState(document.visibilityState !== 'hidden');
  const [network, setNetwork] = useState(online);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const serverOffset = useRef(0);
  const stopWatch = useRef<(() => void) | null>(null);
  const startPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopWatch.current?.();
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!householdId || !online() || !isForeground()) return;
    const version = ++requestVersion.current;
    try {
      const data = await api<{ sessions: SafetySession[]; serverTime: string }>(hh(householdId, '/safety'));
      if (!mounted.current || version !== requestVersion.current || !online() || !isForeground()) return;
      serverOffset.current = Date.parse(data.serverTime) - Date.now();
      setNow(Date.now() + serverOffset.current);
      setSessions(data.sessions);
      setVerified(true);
      setError(null);
    } catch (e) {
      if (!mounted.current || version !== requestVersion.current) return;
      setSessions([]);
      setVerified(false);
      setError(`Cannot verify household alerts: ${(e as Error).message}`);
      if (e instanceof ApiRequestError && [401, 403, 404].includes(e.status)) {
        stopWatch.current?.();
        setConsentId(null);
      }
    }
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    let stream: EventSource | null = null;
    let retryTimer: number | undefined;
    let disposed = false;
    let retry = 1000;
    const connect = () => {
      if (
        disposed ||
        !online() ||
        document.visibilityState === 'hidden' ||
        typeof EventSource === 'undefined'
      )
        return;
      stream = new EventSource(hh(householdId, '/stream'), { withCredentials: true });
      stream.onopen = () => {
        setConnected(true);
        retry = 1000;
        void refresh();
      };
      stream.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type: string };
          if (message.type === 'safety.changed' || message.type === 'household.changed') void refresh();
        } catch {
          /* Ignore non-message heartbeats. */
        }
      };
      stream.onerror = () => {
        setConnected(false);
        stream?.close();
        if (!disposed) retryTimer = window.setTimeout(connect, (retry = Math.min(retry * 2, 30_000)));
      };
    };
    const pause = () => {
      setForeground(document.visibilityState !== 'hidden');
      setNetwork(online());
      window.clearTimeout(retryTimer);
      stream?.close();
      setConnected(false);
      if (!online() || document.visibilityState === 'hidden') {
        requestVersion.current++;
        stopWatch.current?.();
        setLocationState('stopped');
        setSessions([]);
        setVerified(false);
      } else {
        void refresh();
        connect();
      }
    };
    connect();
    void refresh();
    const clock = window.setInterval(() => setNow(Date.now() + serverOffset.current), 1_000);
    const poll = window.setInterval(() => {
      void refresh();
    }, SAFETY_POLL_INTERVAL_MS);
    window.addEventListener('online', pause);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', pause);
    return () => {
      disposed = true;
      stream?.close();
      window.clearTimeout(retryTimer);
      window.clearInterval(poll);
      window.clearInterval(clock);
      window.removeEventListener('online', pause);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', pause);
    };
  }, [householdId, refresh]);

  const origin = sessions.find(
    (s) => s.id === consentId && s.isOrigin && s.status === 'active' && Date.parse(s.expiresAt) > now,
  );
  const sharingId = origin?.id ?? null;
  const expiresAt = origin?.expiresAt;
  useEffect(() => {
    if (!sharingId || !householdId || !foreground || !network || !expiresAt) return;
    let closed = false;
    let lastSent = 0;
    let sending = false;
    const stop = watchSafetyLocation(
      (fix) => {
        if (
          closed ||
          sending ||
          !online() ||
          Date.now() - lastSent < 6_000 ||
          Date.now() + serverOffset.current >= Date.parse(expiresAt)
        )
          return;
        sending = true;
        lastSent = Date.now();
        void api<SafetySession>(hh(householdId, `/safety/${sharingId}/location`), {
          method: 'PATCH',
          body: fix,
        })
          .then(() => {
            if (!closed) {
              setLocationState('sharing');
              void refresh();
            }
          })
          .catch((e: unknown) => {
            if (closed) return;
            setLocationState('unavailable');
            if (e instanceof ApiRequestError && [401, 403, 404, 409].includes(e.status)) {
              setConsentId(null);
              stopWatch.current?.();
              void refresh();
            }
          })
          .finally(() => {
            sending = false;
          });
      },
      (s) => {
        if (!closed && s !== 'sharing') setLocationState(s);
      },
    );
    const cancel = () => {
      if (!closed) {
        closed = true;
        stop();
      }
    };
    stopWatch.current = cancel;
    const expiry = window.setTimeout(
      () => {
        cancel();
        setConsentId(null);
        setLocationState('stopped');
        void refresh();
      },
      Math.max(0, Date.parse(expiresAt) - Date.now() - serverOffset.current),
    );
    return () => {
      cancel();
      window.clearTimeout(expiry);
      if (stopWatch.current === cancel) stopWatch.current = null;
    };
  }, [sharingId, householdId, expiresAt, foreground, network, refresh]);

  const start = async (share: boolean) => {
    if (!householdId || !online())
      throw new Error(
        'Offline: an alert cannot be activated. Contact emergency services directly if needed.',
      );
    if (startPending.current) return;
    startPending.current = true;
    try {
      // Activate first. Permission prompts and GPS are NEVER prerequisites for an alert.
      const session = await api<SafetySession>(hh(householdId, '/safety'), { method: 'POST', body: {} });
      if (!mounted.current) return;
      setSessions((all) => [session, ...all.filter((s) => s.id !== session.id)]);
      if (share) setConsentId(session.id);
      await refresh();
    } finally {
      startPending.current = false;
    }
  };
  const stop = async (id: string) => {
    if (id === consentId) {
      stopWatch.current?.();
      setConsentId(null);
      setLocationState('stopped');
    }
    if (!householdId || !online())
      throw new Error(
        'Offline: updates stopped on this device, but the alert may remain active until expiry.',
      );
    await api(hh(householdId, `/safety/${id}/stop`), { method: 'POST', body: {} });
    if (!mounted.current) return;
    setSessions((all) =>
      all.map((s) =>
        s.id !== id
          ? s
          : {
              ...s,
              status: 'stopped',
              locationStatus: 'stopped',
              latitude: null,
              longitude: null,
              accuracyMeters: null,
              locationAt: null,
            },
      ),
    );
    await refresh();
  };
  // Hide ended/stale fixes even between polls. Coordinates live only in this scoped, volatile state.
  const visible = sessions.map((s): SafetySession => {
    const ended = s.status !== 'active' || Date.parse(s.expiresAt) <= now;
    const stale = s.locationAt && now - Date.parse(s.locationAt) > SAFETY_FIX_STALE_MS;
    return ended || stale
      ? {
          ...s,
          status: ended && s.status === 'active' ? 'expired' : s.status,
          locationStatus: ended ? 'stopped' : 'stale',
          latitude: null,
          longitude: null,
          accuracyMeters: null,
          locationAt: ended ? null : s.locationAt,
        }
      : s;
  });
  return (
    <Context.Provider
      value={{
        householdId,
        sessions: visible,
        error,
        connected,
        verified,
        locationState,
        sharingId,
        start,
        stop,
        share: setConsentId,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useSafety() {
  const value = useContext(Context);
  if (!value) throw new Error('Mount SafetyProvider inside the authenticated household shell');
  return value;
}

/** All authenticated personal roles AND paired displays; never gate SOS behind an adult capability/PIN. */
export function SafetyEntry() {
  const safety = useSafety();
  const me = useMe().data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const count = safety.sessions.filter((s) => s.status === 'active').length;
  const actor = safety.householdId ? householdActor(me, safety.householdId) : null;
  const consentKey =
    actor && safety.householdId
      ? safetyLocationConsentKey(
          safety.householdId,
          actor.kind === 'device' ? actor.deviceId : actor.memberId,
        )
      : null;
  const activate = async () => {
    if (busy || count) return;
    setBusy(true);
    setError('');
    setNotice('');
    let shareLocation = false;
    try {
      shareLocation = Boolean(consentKey && localStorage.getItem(consentKey) === 'true');
    } catch {
      /* Location remains off if consent cannot be read. */
    }
    try {
      await safety.start(shareLocation);
      setNotice(
        shareLocation
          ? 'SOS activated. Location sharing is enabled for this alert.'
          : 'SOS activated. Location is not shared; enable it in Settings before an emergency if desired.',
      );
    } catch (e) {
      setError(`Could not confirm SOS activation: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      {count > 0 ? (
        <Link
          className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-3 font-bold text-white shadow-lg"
          to="/safety"
          role="alert"
        >
          <AlertTriangle /> SOS active — view alert
        </Link>
      ) : (
        <Button
          variant="destructive"
          size="lg"
          onClick={() => void activate()}
          disabled={!safety.householdId || busy}
        >
          <AlertTriangle />
          {busy ? 'Sending SOS…' : 'Panic / SOS'}
        </Button>
      )}
      {error && (
        <p role="alert" className="max-w-xs rounded bg-black/70 p-2 text-sm text-white">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="max-w-xs rounded bg-black/70 p-2 text-sm text-white">
          {notice}
        </p>
      )}
    </div>
  );
}

/** Location consent is configured in Settings, never inserted into the emergency activation flow. */
export function SafetyLocationSetting() {
  const hid = useHid();
  const me = useMe().data;
  const actor = hid ? householdActor(me, hid) : null;
  const actorId = actor ? (actor.kind === 'device' ? actor.deviceId : actor.memberId) : null;
  const key = hid && actorId ? safetyLocationConsentKey(hid, actorId) : null;
  const [enabled, setEnabled] = useState(() => {
    try {
      return Boolean(key && localStorage.getItem(key) === 'true');
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      setEnabled(Boolean(key && localStorage.getItem(key) === 'true'));
    } catch {
      setEnabled(false);
    }
  }, [key]);
  const update = (value: boolean) => {
    try {
      if (key) localStorage.setItem(key, String(value));
      setEnabled(value);
    } catch {
      setEnabled(false);
    }
  };
  return (
    <section aria-label="SOS location sharing" className="space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">SOS location sharing</h2>
      <p className="text-sm text-muted-foreground">
        When enabled, pressing Panic / SOS starts sharing the latest location with this household after the
        alert is activated. Sharing is foreground-only, stops when this app is hidden or the alert ends, and
        is never stored as a location trail. This setting applies to this browser or paired display.
      </p>
      <label className="flex items-center justify-between gap-3 text-sm">
        Share location during SOS{' '}
        <input
          aria-label="Share location during SOS"
          type="checkbox"
          checked={enabled}
          disabled={!key}
          onChange={(event) => update(event.target.checked)}
        />
      </label>
    </section>
  );
}

const locationLabels: Record<LocationState, string> = {
  waiting: 'Waiting for GPS permission / location',
  sharing: 'Sharing latest location while this app is visible',
  denied: 'GPS permission denied — SOS remains active without GPS',
  unavailable: 'GPS or location upload unavailable — SOS remains active',
  stopped: 'Location updates stopped on this device',
};

export function SafetyPanel() {
  const { sessions, error, connected, verified, locationState, sharingId, stop, share } = useSafety();
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [consent, setConsent] = useState<SafetySession | null>(null);
  return (
    <section className="space-y-4" aria-label="Household safety alerts">
      <p className="rounded-xl border border-destructive p-4 font-semibold">{WARNING}</p>
      <p className="text-sm text-muted-foreground">
        {connected
          ? 'Live household updates connected'
          : 'Live updates disconnected; checking every 15 seconds while online'}
      </p>
      {!navigator.onLine && (
        <p role="alert">Offline — cannot verify or send alerts. Delivery is not guaranteed.</p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-destructive">
          {actionError}
        </p>
      )}
      {!error && navigator.onLine && !verified && <p>Checking household alerts…</p>}
      {!error && navigator.onLine && verified && !sessions.some((s) => s.status === 'active') && (
        <p>No active household alerts.</p>
      )}
      {sessions.map((session) => (
        <article key={session.id} className="space-y-3 rounded-2xl border p-4">
          <h2 className="text-lg font-bold">
            {session.sender} —{' '}
            {session.status === 'active'
              ? 'SOS active'
              : session.status === 'expired'
                ? 'Alert expired'
                : 'Alert ended'}
          </h2>
          <p className="text-sm">
            Started {new Date(session.createdAt).toLocaleString()} · Expires{' '}
            {new Date(session.expiresAt).toLocaleTimeString()}
          </p>
          <p>
            {session.status !== 'active'
              ? 'Location sharing stopped; latest location erased.'
              : session.locationStatus === 'live'
                ? `Latest GPS update ${new Date(session.locationAt!).toLocaleTimeString()}${session.accuracyMeters !== null ? ` · accuracy ±${Math.round(session.accuracyMeters)} m` : ''}`
                : session.locationStatus === 'stale'
                  ? 'Location is stale — no current GPS fix available.'
                  : 'GPS unavailable or not shared. The alert is active without location.'}
          </p>
          {session.id === sharingId && <p role="status">{locationLabels[locationState]}</p>}
          {session.status === 'active' &&
            session.locationStatus === 'live' &&
            session.latitude !== null &&
            session.longitude !== null && (
              <Button
                variant="outline"
                onClick={() => {
                  // The map provider receives coordinates only after this explicit user action; no embedded map or prefetch.
                  window.open(
                    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${session.latitude},${session.longitude}`)}`,
                    '_blank',
                    'noopener,noreferrer',
                  );
                }}
              >
                <MapPin />
                Open location in external map
              </Button>
            )}
          {session.status === 'active' && session.isOrigin && session.id !== sharingId && (
            <Button variant="outline" onClick={() => setConsent(session)}>
              Share my location…
            </Button>
          )}
          {session.status === 'active' && session.canStop && (
            <Button
              variant="destructive"
              disabled={pending === session.id}
              onClick={() => {
                setPending(session.id);
                setActionError('');
                void stop(session.id)
                  .catch((e: Error) =>
                    setActionError(`Could not confirm stop: ${e.message} The alert may remain active.`),
                  )
                  .finally(() => setPending(null));
              }}
            >
              Stop alert &amp; location sharing
            </Button>
          )}
        </article>
      ))}
      <Dialog
        open={Boolean(consent)}
        onOpenChange={(v) => {
          if (!v) setConsent(null);
        }}
        title="Share your location?"
        description="Only your current household can view your latest point. No background tracking or location trail."
      >
        <p className="mb-4">
          Updates stop when this app is hidden, closed or switches homes. The latest fix is hidden after two
          minutes without updates; stopping or expiry erases it.
        </p>
        <Button
          onClick={() => {
            if (consent) share(consent.id);
            setConsent(null);
          }}
        >
          I consent — share while app is open
        </Button>
      </Dialog>
    </section>
  );
}
