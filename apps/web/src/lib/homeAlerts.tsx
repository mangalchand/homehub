import { useEffect, useState } from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { BellRing } from 'lucide-react';
import { api, hh } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface HomeAlert {
  source: string;
  title: string;
  text: string;
  postedAt: number;
}
interface HomeAlertsPlugin {
  isEnabled(): Promise<{ enabled: boolean }>;
  openSettings(): Promise<void>;
  addListener(event: 'alert', cb: (a: HomeAlert) => void): Promise<PluginListenerHandle>;
}
const HomeAlerts = registerPlugin<HomeAlertsPlugin>('HomeAlerts');
const KEY = 'familyhub-home-alerts';
export const homeAlertsAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('HomeAlerts');
export const homeAlertsOptedIn = () => localStorage.getItem(KEY) === 'on';

/** Forwards Ring/Blink/myQ notifications seen on this Android display to the selected home. */
export function useHomeAlertForwarding(householdId: string | null | undefined) {
  useEffect(() => {
    if (!householdId || !homeAlertsAvailable() || !homeAlertsOptedIn()) return;
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    void HomeAlerts.addListener('alert', (a) => {
      void api(hh(householdId, '/device-alerts'), { method: 'POST', body: { source: a.source, title: a.title, text: a.text } }).catch(() => undefined);
    }).then((h) => (cancelled ? void h.remove() : (handle = h)));
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [householdId]);
}

export function HomeAlertsSetting() {
  const [on, setOn] = useState(homeAlertsOptedIn);
  const [granted, setGranted] = useState<boolean | null>(null);
  const available = homeAlertsAvailable();
  useEffect(() => {
    if (!available) return;
    const check = () => void HomeAlerts.isEnabled().then((r) => setGranted(r.enabled)).catch(() => setGranted(false));
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [available]);
  const toggle = () => {
    const next = !on;
    localStorage.setItem(KEY, next ? 'on' : 'off');
    setOn(next);
    if (next && granted === false) void HomeAlerts.openSettings();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <BellRing className="h-5 w-5" /> Ring, Blink and myQ alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Shows alerts from the Ring, Blink, myQ, Eufy, Nest, Arlo, SimpliSafe and Wyze apps installed on this tablet at the top of
          FamilyHub for the whole home. Only those apps are read; FamilyHub cannot control the devices.
        </p>
        {!available ? (
          <p>Available in the FamilyHub Android app (version 1.4 or later), on the tablet where those apps are installed and signed in.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant={on ? 'default' : 'outline'} onClick={toggle} aria-pressed={on}>
                {on ? 'Mirroring on' : 'Turn on mirroring'}
              </Button>
              <Button variant="outline" onClick={() => void HomeAlerts.openSettings()}>
                Android notification access
              </Button>
            </div>
            <p role="status">
              {granted === null ? 'Checking permission…' : granted ? 'Notification access granted.' : 'Allow “FamilyHub home alerts” in Android notification access.'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
