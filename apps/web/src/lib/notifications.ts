import { api, hh } from './api';
import { useHhMutation, useHid } from './queries';
import { useQuery } from '@tanstack/react-query';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: { url?: string } & Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
export interface NotificationSettings {
  push: boolean;
  whatsapp: boolean;
  whatsappNumber: string;
  muted: string[];
  pushDevices: number;
  vapidPublicKey: string;
  whatsappAvailable: boolean;
}

export function useNotifications(enabled = true) {
  const hid = useHid();
  return useQuery({
    queryKey: ['notifications', hid],
    queryFn: () => api<AppNotification[]>(hh(hid!, '/notifications')),
    enabled: Boolean(hid) && enabled,
    refetchInterval: 15_000,
  });
}

export function useMarkRead() {
  return useHhMutation((h, ids: string[] | undefined) => api(hh(h, '/notifications/read'), { method: 'POST', body: ids ? { ids } : {} }), [['notifications']]);
}

export function useNotificationSettings(enabled = true) {
  const hid = useHid();
  return useQuery({ queryKey: ['notification-settings', hid], queryFn: () => api<NotificationSettings>(hh(hid!, '/notifications/settings')), enabled: Boolean(hid) && enabled });
}

export function useSaveNotificationSettings() {
  return useHhMutation(
    (h, body: Partial<Pick<NotificationSettings, 'push' | 'whatsapp' | 'whatsappNumber' | 'muted'>>) => api(hh(h, '/notifications/settings'), { method: 'PATCH', body }),
    [['notification-settings']],
  );
}

const b64ToBytes = (b64: string) => {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks permission, subscribes this browser and registers it with the API. */
export async function enablePush(householdId: string, vapidPublicKey: string) {
  if (!pushSupported()) throw new Error('This browser does not support push notifications. On iPhone, add FamilyHub to the Home Screen first.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in the browser/site settings.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidPublicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api(hh(householdId, '/push/subscribe'), { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
}

export async function disablePush(householdId: string) {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await api(hh(householdId, '/push/unsubscribe'), { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe();
}

const SOUND_KEY = 'fh-sound';
export const soundEnabled = () => localStorage.getItem(SOUND_KEY) !== 'off';
export const setSoundEnabled = (on: boolean) => localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');

let ctx: AudioContext | null = null;
/** Call from a user gesture; browsers otherwise keep notification audio suspended. */
export function unlockNotificationAudio() {
  if (!soundEnabled()) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch { /* audio is optional */ }
}
/** Short two-tone chime, synthesized so it works offline with no audio asset. */
export function chime() {
  if (!soundEnabled()) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.6);
      o.connect(g).connect(ctx!.destination);
      o.start(now + i * 0.16);
      o.stop(now + i * 0.16 + 0.65);
    });
  } catch {
    /* audio not available */
  }
}
