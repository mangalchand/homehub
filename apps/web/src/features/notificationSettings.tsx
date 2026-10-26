import { useEffect, useState } from 'react';
import { Bell, MessageCircle, Send, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { chime, currentPushSubscription, disablePush, enablePush, pushSupported, setSoundEnabled, soundEnabled, useNotificationSettings, useSaveNotificationSettings } from '@/lib/notifications';
import { useHid, useMe, useRole } from '@/lib/queries';
import { isNativeApp, registerNativePush } from '@/lib/nativePush';
import { queryClient } from '@/lib/queryClient';
import { Card, CardContent, CardHeader, CardTitle, IconTile } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/misc';

export function NotificationsSection() {
  const hid = useHid();
  const { isDevice } = useRole();
  const me = useMe().data;
  const settings = useNotificationSettings().data;
  const save = useSaveNotificationSettings();
  const [onThisDevice, setOnThisDevice] = useState(false);
  const [sound, setSound] = useState(soundEnabled());
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void currentPushSubscription().then((s) => setOnThisDevice(Boolean(s))); }, []);
  useEffect(() => { if (settings) setNumber(settings.whatsappNumber); }, [settings]);

  const togglePush = async (on: boolean) => {
    if (!hid || !settings) return;
    setBusy(true);
    try {
      if (on) { await enablePush(hid, settings.vapidPublicKey); toast.success('Push notifications are on for this device'); }
      else { await disablePush(hid); toast.success('Push notifications are off for this device'); }
      setOnThisDevice(on);
      await queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  const test = async () => {
    try {
      const r = await api<{ inApp: boolean; whatsapp: string }>(hh(hid!, '/notifications/test'), { method: 'POST' });
      toast.success(`Test sent${r.whatsapp !== 'off' ? ` · WhatsApp: ${r.whatsapp}` : ''}`);
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <Card>
      <CardHeader><CardTitle><IconTile className="bg-rose-500/10 text-rose-600"><Bell /></IconTile> Notifications</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        {isNativeApp() ? <Row icon={<Bell className="h-4 w-4" />} title="Push notifications (Android app)" body={`${settings?.pushDevices ? 'Registered for push. ' : 'Not registered yet. '}Allow notifications in Android Settings → Apps → FamilyHub Pro → Notifications.`}><Button variant="outline" size="sm" onClick={() => { if (hid) void registerNativePush(hid, (url) => { window.location.href = url; }, me?.device?.id ?? me?.user?.id).then(() => queryClient.invalidateQueries({ queryKey: ['notification-settings'] })).catch((e) => toast.error((e as Error).message)); }}>Enable</Button></Row> : isDevice ? <p className="text-sm text-muted-foreground">Tablet alerts work while this display is open. Install the Android APK for notifications when it is in the background.</p> : <Row icon={<Bell className="h-4 w-4" />} title="Push notifications on this device" body={pushSupported() ? `New events, reminders, chores, rewards, photos and notes — even when the app is closed.${settings?.pushDevices ? ` Active on ${settings.pushDevices} device${settings.pushDevices === 1 ? '' : 's'}.` : ''}` : 'Not supported in this browser. On Android use Chrome; on iPhone add FamilyHub to the Home Screen.'}>
          <Switch checked={onThisDevice} disabled={busy || !pushSupported() || !settings} onCheckedChange={(v) => void togglePush(v)} label="Push notifications" />
        </Row>}
        <Row icon={<Volume2 className="h-4 w-4" />} title="Chime sound" body="Ring when a new notification arrives while the app is open.">
          <Switch checked={sound} onCheckedChange={(v) => { setSound(v); setSoundEnabled(v); if (v) chime(); }} label="Chime sound" />
        </Row>
        {!isDevice && <div className="space-y-3 rounded-2xl border p-4">
          <Row icon={<MessageCircle className="h-4 w-4" />} title="WhatsApp" body={settings?.whatsappAvailable ? 'Get the same alerts on WhatsApp.' : 'Not connected on the server yet (needs a WhatsApp Business number). You can save your number now.'}>
            <Switch checked={Boolean(settings?.whatsapp)} disabled={!settings} onCheckedChange={(v) => save.mutate({ whatsapp: v, whatsappNumber: number }, { onError: (e) => toast.error((e as Error).message) })} label="WhatsApp notifications" />
          </Row>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ whatsappNumber: number }, { onSuccess: () => toast.success('Saved'), onError: (err) => toast.error((err as Error).message) }); }}>
            <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+14155550123" inputMode="tel" aria-label="WhatsApp number" />
            <Button type="submit" variant="outline">Save</Button>
          </form>
        </div>}
        <Button variant="outline" onClick={() => void test()}><Send /> Send me a test</Button>
      </CardContent>
    </Card>
  );
}

function Row({ icon, title, body, children }: { icon: React.ReactNode; title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 rounded-lg bg-muted p-1.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{title}</p><p className="text-xs text-muted-foreground">{body}</p></div>
      {children}
    </div>
  );
}
