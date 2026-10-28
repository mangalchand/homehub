import { useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  CalendarPlus,
  Download,
  LogOut,
  MonitorSmartphone,
  Palette,
  RefreshCw,
  Shield,
  Trash2,
  Upload,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import {
  useActiveLayout,
  useCalendars,
  useHhMutation,
  useHid,
  useHousehold,
  useMe,
  useRole,
} from '@/lib/queries';
import { useUi } from '@/store/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Badge, PageHeader, Switch } from '@/components/ui/misc';
import { NotificationsSection } from '@/features/notificationSettings';
import { SafetyLocationSetting } from '@/features/safety';
import { SpokenAlertsControl } from '@/features/spokenAlerts';

interface Provider {
  key: string;
  name: string;
  configured: boolean;
  status?: string;
  description?: string;
}
interface Device {
  id: string;
  name: string;
  type: string;
  lastSeenAt: string | null;
  pairedAt: string | null;
  revokedAt: string | null;
  pairingPending: boolean;
}

function CalendarsSection() {
  const { isAdmin } = useRole();
  const hid = useHid();
  const calendars = useCalendars().data ?? [];
  const providers =
    useQuery({
      queryKey: ['providers', hid],
      queryFn: () => api<Provider[]>(hh(hid!, '/integrations/providers')),
    }).data ?? [];
  const [ics, setIcs] = useState({ url: '', name: '' });
  const [icsOpen, setIcsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const subscribe = useHhMutation<void>(
    (h) => api(hh(h, '/calendars/subscribe'), { method: 'POST', body: ics }),
    [['calendars'], ['events']],
  );
  const sync = useHhMutation<string>(
    (h, id) => api(hh(h, `/calendars/${id}/sync`), { method: 'POST' }),
    [['calendars'], ['events']],
  );
  const remove = useHhMutation<string>(
    (h, id) => api(hh(h, `/calendars/${id}`), { method: 'DELETE' }),
    [['calendars'], ['events']],
  );
  const connect = async (key: string) => {
    try {
      const r = await api<{ url?: string; authorizationUrl?: string; accountId?: string }>(
        hh(hid!, key === 'demo' ? '/integrations/demo/connect' : `/integrations/${key}/start`),
        { method: 'POST' },
      );
      const url = r.url ?? r.authorizationUrl;
      if (url) window.location.href = url;
      else {
        toast.success('Connected');
        void queryClient.invalidateQueries({ queryKey: ['calendars'] });
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const importFile = async (f: File) => {
    const fd = new FormData();
    fd.append('file', f);
    fd.append('name', f.name.replace(/\.ics$/i, ''));
    try {
      await api(hh(hid!, '/calendars/import'), { method: 'POST', formData: fd });
      toast.success('Calendar imported');
      void queryClient.invalidateQueries({ queryKey: ['calendars'] });
      void queryClient.invalidateQueries({ queryKey: ['events'] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <CalendarPlus className="h-5 w-5" /> Calendars
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {calendars.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
              <span className="h-3 w-3 rounded-full" style={{ background: c.color }} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{c.name}</p>
                <p className="text-xs text-muted-foreground">
                  {c.source.replace('_', ' ').toLowerCase()} · {c.visibility.toLowerCase().replace('_', ' ')}
                  {c.sync?.lastSuccessAt
                    ? ` · synced ${formatDistanceToNow(new Date(c.sync.lastSuccessAt))} ago`
                    : ''}
                </p>
                {c.sync?.lastError && <p className="text-xs text-destructive">{c.sync.lastError}</p>}
              </div>
              {c.readOnlyReason && <Badge tone="muted">read-only</Badge>}
              {c.sync && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sync.mutate(c.id, { onSuccess: () => toast.success('Sync started') })}
                >
                  <RefreshCw /> Sync
                </Button>
              )}
              {c.access === 'WRITE' || c.sync || isAdmin || ['ICS_URL', 'ICS_FILE'].includes(c.source) ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${c.name}`}
                  onClick={() =>
                    confirm(
                      `Remove “${c.name}” and its events from FamilyHub?${c.source.startsWith('ICS') ? ' (The original calendar is not affected.)' : ''}`,
                    ) &&
                    remove.mutate(c.id, {
                      onSuccess: () => toast.success('Calendar removed'),
                      onError: (e) => toast.error((e as Error).message),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {providers
            .filter((p) => !['ics', 'ics_file'].includes(p.key))
            .map((p) => (
              <Button
                key={p.key}
                variant="outline"
                disabled={!p.configured}
                title={p.configured ? undefined : 'Not configured on this server (see docs/integrations.md)'}
                onClick={() => void connect(p.key)}
              >
                Connect {p.name}
              </Button>
            ))}
          <Button variant="outline" onClick={() => setIcsOpen(true)}>
            Subscribe to ICS link
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload /> Import .ics file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".ics,text/calendar"
            hidden
            onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Apple/iCloud: share a calendar publicly in the Calendar app and paste its webcal:// link here
          (read-only).
        </p>
      </CardContent>
      <Dialog
        open={icsOpen}
        onOpenChange={setIcsOpen}
        title="Subscribe to a calendar link"
        description="School, sports and iCloud public calendars. Read-only; refreshed automatically."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            subscribe.mutate(undefined, {
              onSuccess: () => {
                setIcsOpen(false);
                toast.success('Subscribed');
              },
              onError: (er) => toast.error((er as Error).message),
            });
          }}
        >
          <Field label="Link (https:// or webcal://)">
            <Input
              value={ics.url}
              onChange={(e) => setIcs({ ...ics, url: e.target.value })}
              required
              autoFocus
            />
          </Field>
          <Field label="Name">
            <Input value={ics.name} onChange={(e) => setIcs({ ...ics, name: e.target.value })} required />
          </Field>
          <Button type="submit" className="w-full" disabled={subscribe.isPending}>
            Subscribe
          </Button>
        </form>
      </Dialog>
    </Card>
  );
}

export function DevicesSection({ allHomes = false }: { allHomes?: boolean }) {
  const hid = useHid();
  const me = useMe().data;
  const { role, isDevice } = useRole();
  const homes = (me?.memberships ?? []).filter((m) => allHomes || m.householdId === hid);
  const rosters = useQueries({
    queries: homes.map((m) => ({
      queryKey: ['devices', m.householdId],
      queryFn: () => api<Device[]>(hh(m.householdId, '/devices')),
      refetchInterval: 30_000,
    })),
  });
  const [name, setName] = useState('Kitchen display');
  const [code, setCode] = useState<string | null>(null);
  const create = useHhMutation<void, { pairingCode: string }>(
    (h) => api(hh(h, '/devices'), { method: 'POST', body: { name } }),
    [['devices']],
  );
  const revoke = useHhMutation<{ homeId: string; id: string }>(
    (_h, v) => api(hh(v.homeId, `/devices/${v.id}`), { method: 'DELETE' }),
    [['devices']],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <MonitorSmartphone className="h-5 w-5" /> Paired displays {allHomes ? 'across your homes' : ''}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed text-muted-foreground">
          FamilyHub wall tablets and displays. Last seen reports recent activity, not a guaranteed live
          connection. Smart-home accessories appear only after an automation integration is connected.
        </p>
        {homes.map((home, i) => (
          <div key={home.householdId} className="space-y-2">
            {allHomes && <p className="break-words text-sm font-semibold">{home.householdName}</p>}
            {rosters[i]?.isPending && <p className="text-sm text-muted-foreground">Loading displays…</p>}
            {rosters[i]?.isError && (
              <p role="alert" className="text-sm text-destructive">
                Couldn’t load displays for {home.householdName}.
              </p>
            )}
            {rosters[i]?.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">No displays registered.</p>
            )}
            {rosters[i]?.data?.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">
                    {d.name}
                    {me?.device?.id === d.id ? ' · this display' : ''}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone={d.revokedAt ? 'danger' : d.pairedAt ? 'success' : 'muted'}>
                      {d.revokedAt
                        ? 'Revoked'
                        : d.pairedAt
                          ? 'Paired'
                          : d.pairingPending
                            ? 'Pairing pending'
                            : 'Pairing expired'}
                    </Badge>
                    {d.lastSeenAt && (
                      <span className="text-xs text-muted-foreground">
                        Last seen {formatDistanceToNow(new Date(d.lastSeenAt))} ago
                      </span>
                    )}
                  </div>
                </div>
                {home.role === 'OWNER' && !isDevice && !d.revokedAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revoke.isPending}
                    onClick={() =>
                      confirm(`Revoke ${d.name} in ${home.householdName}? It will be signed out.`) &&
                      revoke.mutate(
                        { homeId: home.householdId, id: d.id },
                        { onError: (e) => toast.error((e as Error).message) },
                      )
                    }
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        ))}
        {role === 'OWNER' && !isDevice && (
          <form
            className="flex flex-wrap gap-2 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: (r) => setCode(r.pairingCode),
                onError: (er) => toast.error((er as Error).message),
              });
            }}
          >
            <Input
              className="min-w-0 flex-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Display name"
              maxLength={100}
              required
            />
            <Button type="submit" disabled={create.isPending}>
              Pair a display
            </Button>
          </form>
        )}
        {code && (
          <div className="rounded-xl bg-primary/10 p-4 text-center">
            <p className="text-sm text-muted-foreground">
              On the tablet, open FamilyHub → “Wall display” and enter:
            </p>
            <p className="mt-1 font-mono text-3xl font-bold tracking-widest">{code}</p>
            <p className="text-xs text-muted-foreground">Expires in 15 minutes.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SecuritySection() {
  const hid = useHid();
  const household = useHousehold().data;
  const [pin, setPin] = useState('');
  const setPinM = useHhMutation<void>(
    (h) => api(hh(h, '/pin'), { method: 'PUT', body: { pin } }),
    [['household']],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Shield className="h-5 w-5" /> Privacy & security
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPinM.mutate(undefined, {
              onSuccess: () => {
                setPin('');
                toast.success('PIN saved');
              },
              onError: (er) => toast.error((er as Error).message),
            });
          }}
        >
          <Field
            label={household?.hasPin ? 'Change household PIN' : 'Set household PIN'}
            hint="Unlocks adult actions on shared wall displays."
          >
            <Input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              maxLength={8}
            />
          </Field>
          <Button type="submit" disabled={pin.length < 4}>
            Save
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={hh(hid!, '/export')}>
              <Download /> Export all household data (JSON)
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function DisplaySection() {
  const ui = useUi();
  const layout = useActiveLayout().data;
  const { isAdmin } = useRole();
  const save = useHhMutation<{ id: string; widgets: unknown }>(
    (h, v) =>
      api(hh(h, `/dashboard-layouts/${v.id}`), {
        method: 'PUT',
        body: {
          name: layout!.name,
          preset: layout!.preset,
          isDefault: layout!.isDefault,
          deviceId: layout!.deviceId,
          widgets: v.widgets,
        },
      }),
    [['dashboard']],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Palette className="h-5 w-5" /> Display
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Theme">
          <Select value={ui.theme} onChange={(e) => ui.setTheme(e.target.value as 'light')}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </Field>
        <label className="flex items-center justify-between text-sm">
          Automatic night mode{' '}
          <Switch checked={ui.autoNight} onCheckedChange={(v) => ui.setNight({ autoNight: v })} />
        </label>
        {ui.autoNight && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Dim from">
              <Select
                value={ui.nightStart}
                onChange={(e) => ui.setNight({ nightStart: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{`${h}:00`}</option>
                ))}
              </Select>
            </Field>
            <Field label="Until">
              <Select value={ui.nightEnd} onChange={(e) => ui.setNight({ nightEnd: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{`${h}:00`}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {isAdmin && layout && (
          <div>
            <p className="mb-2 text-sm font-medium">Dashboard widgets</p>
            <div className="space-y-1">
              {layout.widgets.map((w, i) => (
                <label
                  key={w.id}
                  className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm capitalize hover:bg-muted"
                >
                  {w.type}
                  <Switch
                    checked={w.visible}
                    onCheckedChange={(v) =>
                      save.mutate({
                        id: layout.id,
                        widgets: layout.widgets.map((x, j) => (j === i ? { ...x, visible: v } : x)),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const me = useMe().data;
  const { role, isDevice } = useRole();
  const logout = async () => {
    await api('/api/v1/auth/logout', { method: 'POST' });
    await queryClient.resetQueries();
    window.location.href = '/login';
  };
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Settings"
        subtitle={
          me?.user
            ? `Signed in as ${me.user.email}`
            : me?.device
              ? `Wall display: ${me.device.name}`
              : undefined
        }
        actions={
          <Button variant="outline" onClick={() => void logout()}>
            <LogOut /> Sign out
          </Button>
        }
      />
      <DisplaySection />
      <NotificationsSection />
      <SafetyLocationSetting />
      <SpokenAlertsControl />
      {!isDevice && <CalendarsSection />}
      <DevicesSection />
      {role === 'OWNER' && !isDevice && <SecuritySection />}
    </div>
  );
}
