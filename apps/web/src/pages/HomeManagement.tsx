import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Home, Lock, Radio, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { useHhMutation, useHid, useHousehold, useMembers, useRole } from '@/lib/queries';
import { HomesCard } from './Homes';
import { DevicesSection, DisplaySection, SecuritySection } from './Settings';
import { NotificationsSection } from '@/features/notificationSettings';
import { FamilyCallCard } from '@/features/familyCall';
import { JoinRequestsCard } from '@/features/join';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Badge, PageHeader } from '@/components/ui/misc';

const ZONES = ['UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? []).filter((z) => z !== 'UTC')];

function HomeDetails() {
  const home = useHousehold().data;
  const { role, isDevice } = useRole();
  const [name, setName] = useState(home?.name ?? '');
  const [timezone, setTimezone] = useState(home?.timezone ?? 'UTC');
  const save = useHhMutation<void>(
    (hid) => api(hh(hid, ''), { method: 'PATCH', body: { name, timezone } }),
    [['household'], ['me']],
  );
  if (!home) return null;
  const canManage = role === 'OWNER' && !isDevice;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Home className="h-5 w-5" /> {home.name}
        </CardTitle>
        <Badge>{isDevice ? 'Home display' : role.replaceAll('_', ' ').toLowerCase()}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(undefined, {
                onSuccess: () => toast.success('Home details saved'),
                onError: (er) => toast.error((er as Error).message),
              });
            }}
          >
            <Field label="Home name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
            </Field>
            <Field label="Time zone">
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={save.isPending}>
              Save home details
            </Button>
          </form>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Time zone: {home.timezone}. Only this home’s owner can rename it, change the PIN, export all data
            or pair/revoke displays.
          </p>
        )}
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" /> Household PIN {home.hasPin ? 'is set' : 'has not been set'}
        </p>
      </CardContent>
    </Card>
  );
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}
function PendingInvitations() {
  const hid = useHid();
  const invitations = useQuery({
    queryKey: ['invitations', hid],
    queryFn: () => api<Invitation[]>(hh(hid!, '/invitations')),
  });
  const revoke = useHhMutation<string>(
    (h, id) => api(hh(h, `/invitations/${id}`), { method: 'DELETE' }),
    [['invitations']],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <UserPlus className="h-5 w-5" /> Invitations sent
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {invitations.isPending && <p className="text-sm text-muted-foreground">Loading invitations…</p>}
        {invitations.isError && (
          <p role="alert" className="text-sm text-destructive">
            Couldn’t load invitations.
          </p>
        )}
        {invitations.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No invitations waiting to be opened.</p>
        )}
        {invitations.data?.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm font-medium">{i.email}</p>
              <p className="text-xs text-muted-foreground">
                Expires {new Date(i.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={revoke.isPending}
              onClick={() =>
                confirm(`Revoke the invitation for ${i.email}?`) &&
                revoke.mutate(i.id, { onError: (e) => toast.error((e as Error).message) })
              }
            >
              Revoke
            </Button>
          </div>
        ))}
        <Button variant="outline" asChild>
          <Link to="/family">Add or invite a member</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function HomeManagementPage() {
  const hid = useHid();
  const home = useHousehold();
  const { isAdmin, isDevice, role } = useRole();
  const members = useMembers().data ?? [];
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Home Management"
        subtitle="Homes, people, displays and household controls in one place."
      />
      <nav aria-label="Home management sections" className="flex flex-wrap gap-2">
        {['homes', 'members', 'devices', 'display', 'notifications', 'communication', 'automation'].map(
          (s) => (
            <a
              key={s}
              href={`#${s}`}
              className="rounded-full border bg-card px-4 py-2 text-sm font-medium capitalize hover:bg-muted"
            >
              {s}
            </a>
          ),
        )}
      </nav>
      <section id="homes" className="scroll-mt-24 space-y-5">
        {!isDevice && <HomesCard />}
        {home.data && <HomeDetails key={hid} />}
        {home.isError && (
          <p role="alert" className="text-destructive">
            Couldn’t load this home. Refresh homes to check your access.
          </p>
        )}
      </section>
      <section id="members" className="scroll-mt-24 space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>
              <Users className="h-5 w-5" /> Family & access
            </CardTitle>
            <Badge>{members.filter((m) => m.isActive).length} active</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {isDevice
                ? 'Unlock with the PIN to invite or remove adult, child and guest members. Owners and parent admins are protected on shared displays.'
                : isAdmin
                  ? 'Add profiles, invite existing accounts or remove access without deleting household history.'
                  : 'You can view the family. Ask the owner or a parent admin to invite or remove members.'}
            </p>
            <Button asChild variant="outline">
              <Link to="/family">{isAdmin ? 'Manage members & invitations' : 'View family'}</Link>
            </Button>
          </CardContent>
        </Card>
        {(isAdmin || isDevice) && <JoinRequestsCard isDevice={isDevice} />}
        {isAdmin && <PendingInvitations />}
      </section>
      <section id="devices" className="scroll-mt-24">
        <DevicesSection allHomes />
      </section>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <section id="display" className="scroll-mt-24">
          <DisplaySection />
        </section>
        <section id="notifications" className="scroll-mt-24">
          <NotificationsSection />
        </section>
      </div>
      <section id="communication" className="scroll-mt-24 space-y-5">
        <FamilyCallCard />
        <Card>
          <CardHeader>
            <CardTitle>Evening task & points summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              By default, a summary arrives at 8:30 PM in this home’s time zone. Preview pending tasks and
              points, review delivery history, or change the schedule.
            </p>
            <Button variant="outline" asChild>
              <Link to="/summaries">Summary & schedule</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/announcements">Family announcements</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
      {role === 'OWNER' && !isDevice && <SecuritySection />}
      <section id="automation" className="scroll-mt-24">
        <Card>
          <CardHeader>
            <CardTitle>
              <Radio className="h-5 w-5" /> Home automation
            </CardTitle>
            <Badge tone="muted">Not connected</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="font-semibold">Connect a smart-home platform before controlling accessories.</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              No lights, plugs, locks, cameras, sensors or thermostats are connected to FamilyHub yet. This
              page lists FamilyHub displays, not discovered smart-home accessories.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Home Assistant is a practical hub for supported devices. These links open setup information;
              they do not connect devices to FamilyHub or enable remote commands.
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
                href="https://www.home-assistant.io/getting-started/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Set up Home Assistant
              </a>
              <a
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
                href="https://www.home-assistant.io/integrations/ring/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Ring setup
              </a>
              <a
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
                href="https://www.home-assistant.io/integrations/blink/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Blink setup
              </a>
              <a
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
                href="https://github.com/fuatakgun/eufy_security"
                target="_blank"
                rel="noopener noreferrer"
              >
                Eufy Security community integration
              </a>
              <a
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
                href="https://www.home-assistant.io/integrations/matter/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Matter switches
              </a>
              <a
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
                href="https://www.home-assistant.io/integrations/zha/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Zigbee switches
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              Ring/Blink/Eufy and switch support depends on the exact model and may require a hub. Share each
              model number and the Home Assistant address/platform before we add a real FamilyHub connection.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
