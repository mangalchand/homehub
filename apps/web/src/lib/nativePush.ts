import { api, hh } from './api';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { queryClient } from './queryClient';

interface PushPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  createChannel(c: { id: string; name: string; importance: number; sound?: string; vibration?: boolean }): Promise<void>;
  addListener(event: string, cb: (data: never) => void): Promise<{ remove: () => void }>;
}
export const isNativeApp = () => Capacitor.isNativePlatform();
const push = registerPlugin<PushPlugin>('PushNotifications');
let target: { householdId: string; identity: string; onOpen: (url: string) => void } | null = null;
let listeners: Promise<void> | null = null;
let token: string | null = null;

async function saveToken() {
  if (target && token) await api(hh(target.householdId, '/push/fcm-token'), { method: 'POST', body: { token } });
}

/** Register for the current member or paired display, including after switching household/account. */
export async function registerNativePush(householdId: string, onOpen: (url: string) => void, identity = householdId) {
  if (!isNativeApp() || !Capacitor.isPluginAvailable('PushNotifications')) return;
  target = { householdId, identity, onOpen };
  let perm = await push.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await push.requestPermissions();
  if (perm.receive !== 'granted') return;
  await push.createChannel({ id: 'familyhub', name: 'FamilyHub', importance: 5, vibration: true }).catch(() => undefined);
  if (!listeners) listeners = (async () => {
    await push.addListener('registration', ((t: { value: string }) => {
      token = t.value;
      void saveToken().catch(() => undefined);
    }) as never);
    await push.addListener('pushNotificationReceived', (() => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }) as never);
    await push.addListener('pushNotificationActionPerformed', ((a: { notification: { data?: { url?: string } } }) => {
      const url = a.notification?.data?.url;
      if (url?.startsWith('/') && !url.startsWith('//')) target?.onOpen(url);
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }) as never);
  })().catch((err) => { listeners = null; throw err; });
  await listeners;
  await saveToken();
  await push.register();
}
