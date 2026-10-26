import { api, hh } from './api';

interface PushPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  createChannel(c: { id: string; name: string; importance: number; sound?: string; vibration?: boolean }): Promise<void>;
  addListener(event: string, cb: (data: never) => void): Promise<{ remove: () => void }>;
}
interface CapacitorGlobal { isNativePlatform?: () => boolean; Plugins?: { PushNotifications?: PushPlugin } }

const cap = () => (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
export const isNativeApp = () => Boolean(cap()?.isNativePlatform?.());

let started = false;
/** In the Android app: ask permission, get the FCM token and register it for this member. */
export async function registerNativePush(householdId: string, onOpen: (url: string) => void) {
  const push = cap()?.Plugins?.PushNotifications;
  if (!isNativeApp() || !push || started) return;
  started = true;
  let perm = await push.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await push.requestPermissions();
  if (perm.receive !== 'granted') return;
  await push.createChannel({ id: 'familyhub', name: 'FamilyHub', importance: 5, vibration: true }).catch(() => undefined);
  await push.addListener('registration', ((t: { value: string }) => {
    void api(hh(householdId, '/push/fcm-token'), { method: 'POST', body: { token: t.value } }).catch(() => undefined);
  }) as never);
  await push.addListener('pushNotificationActionPerformed', ((a: { notification: { data?: { url?: string } } }) => {
    const url = a.notification?.data?.url;
    if (url) onOpen(url);
  }) as never);
  await push.register();
}
