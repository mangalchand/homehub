import { Capacitor, registerPlugin } from '@capacitor/core';
import type { EmergencyLocation } from '@familyhub/shared';

type Position = { timestamp: number; coords: { latitude: number; longitude: number; accuracy: number | null } };
type Permission = { location: string; coarseLocation: string };
interface GeolocationPlugin {
  checkPermissions(): Promise<Permission>;
  requestPermissions(options: { permissions: string[] }): Promise<Permission>;
  watchPosition(options: { enableHighAccuracy: boolean; timeout: number; maximumAge: number }, callback: (position: Position | null, error?: unknown) => void): Promise<string>;
  clearWatch(options: { id: string }): Promise<void>;
}
const geolocation = registerPlugin<GeolocationPlugin>('Geolocation');
export type LocationState = 'waiting' | 'sharing' | 'denied' | 'unavailable' | 'stopped';

/** Foreground only. Cancellation also clears native watches that resolve after unmount/permission prompts. */
export function watchSafetyLocation(onFix: (fix: EmergencyLocation) => void, onState: (state: LocationState) => void): () => void {
  let cancelled = false;
  let nativeId: string | undefined;
  let browserId: number | undefined;
  const state = (s: LocationState) => { if (!cancelled) onState(s); };
  const fix = (p: Position) => {
    if (cancelled) return;
    const { latitude, longitude, accuracy } = p.coords;
    const locationAt = new Date(p.timestamp);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(locationAt.getTime()) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0))) return;
    state('sharing');
    onFix({ latitude, longitude, accuracyMeters: accuracy, locationAt: locationAt.toISOString() });
  };
  const error = (e: unknown) => {
    const code = (e as { code?: number | string } | null)?.code;
    const message = (e as { message?: string } | null)?.message ?? '';
    state(code === 1 || code === 'OS-PLUG-GLOC-0003' || /denied/i.test(message) ? 'denied' : 'unavailable');
  };
  state('waiting');
  if (Capacitor.isNativePlatform()) {
    void (async () => {
      if (!Capacitor.isPluginAvailable('Geolocation')) { state('unavailable'); return; }
      let permission = await geolocation.checkPermissions();
      if (cancelled) return;
      if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
        if (permission.location === 'denied' && permission.coarseLocation === 'denied') { state('denied'); return; }
        permission = await geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] });
      }
      if (cancelled) return;
      if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') { state('denied'); return; }
      const id = await geolocation.watchPosition({ enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }, (p, e) => { if (e) error(e); else if (p) fix(p); });
      if (cancelled) await geolocation.clearWatch({ id });
      else nativeId = id;
    })().catch(error);
  } else if (navigator.geolocation) {
    try {
      browserId = navigator.geolocation.watchPosition(fix, error, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
    } catch (e) { error(e); }
  } else state('unavailable');
  return () => {
    cancelled = true;
    if (browserId !== undefined) navigator.geolocation.clearWatch(browserId);
    if (nativeId !== undefined) void geolocation.clearWatch({ id: nativeId }).catch(() => undefined);
  };
}
