import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { whatsappCallUrlSchema } from '@familyhub/shared';
import { ExternalLink, Phone } from 'lucide-react';
import { api, hh } from '@/lib/api';
import { useHid, useRole } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, IconTile } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';

export interface CallGroup {
  id: string;
  name: string;
  url: string;
}
export interface FamilyCallSettings {
  whatsappCallUrl: string | null;
  groups?: CallGroup[];
}
export const familyCallQueryKey = (householdId: string) => ['family-call', householdId] as const;

export function FamilyCallCard() {
  const hid = useHid();
  const { isAdmin } = useRole();
  if (!hid) return null;
  return <HouseholdFamilyCallCard key={hid} householdId={hid} canManage={isAdmin} />;
}

function HouseholdFamilyCallCard({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const id = useId();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [notifying, setNotifying] = useState(false);
  const settings = useQuery({
    queryKey: familyCallQueryKey(householdId),
    queryFn: () => api<FamilyCallSettings>(hh(householdId, '/family-call')),
    staleTime: 0,
    gcTime: 0,
  });
  const save = useMutation({
    mutationFn: (whatsappCallUrl: string | null) =>
      api<FamilyCallSettings>(hh(householdId, '/family-call'), {
        method: 'PATCH',
        body: { whatsappCallUrl },
      }),
    onSuccess: (data) => {
      qc.setQueryData(familyCallQueryKey(householdId), data);
      setDraft(null);
      setError('');
      setStatus(data.whatsappCallUrl ? 'Call link saved.' : 'Call link removed from FamilyHub.');
      void qc.invalidateQueries({ queryKey: familyCallQueryKey(householdId) });
    },
    onError: (err: Error) => {
      setError(err.message);
      setStatus('');
    },
  });
  const notifyHousehold = async () => {
    if (notifying) return;
    setNotifying(true);
    setError('');
    setStatus('');
    try {
      await api(hh(householdId, '/family-call/notify'), { method: 'POST', body: {} });
      setStatus(
        'FamilyHub notification sent; WhatsApp delivery requires WhatsApp to be connected. Each person must tap Join in WhatsApp.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNotifying(false);
    }
  };
  const parsed = whatsappCallUrlSchema.safeParse(settings.data?.whatsappCallUrl);
  const url = !settings.isError && parsed.success ? parsed.data : null;
  const ready = settings.isSuccess;
  const value = draft ?? settings.data?.whatsappCallUrl ?? '';

  const submit = () => {
    const result = whatsappCallUrlSchema.safeParse(value);
    setStatus('');
    if (!result.success) {
      setError(
        'Paste an exact https://call.whatsapp.com/voice/… or /video/… link without spaces, query parameters or fragments (maximum 500 characters).',
      );
      return;
    }
    setError('');
    save.mutate(result.data);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <IconTile className="bg-emerald-500/10 text-emerald-600">
            <Phone />
          </IconTile>{' '}
          Family call
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Open the family’s WhatsApp call link, then tap Join in WhatsApp. Everyone joins individually; this
          does not automatically ring or join the whole family. Use Notify household to invite everyone with
          an account; each person must tap Join.
        </p>
        {settings.isPending && <p role="status">Loading family call…</p>}
        {settings.isError && (
          <div role="alert" className="space-y-2 text-sm">
            <p>Could not load the family call link. {settings.error.message}</p>
            <Button variant="outline" onClick={() => void settings.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {url && (
          <div className="flex flex-wrap gap-2">
            <Button asChild size="lg">
              <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                <Phone /> Join family {url.includes('/video/') ? 'video' : 'voice'} call <ExternalLink />
              </a>
            </Button>
            {canManage && (
              <Button variant="outline" size="lg" disabled={notifying} onClick={() => void notifyHousehold()}>
                {notifying ? 'Sending invitation…' : 'Notify household'}
              </Button>
            )}
          </div>
        )}
        {status && (
          <p role="status" className="text-sm">
            {status}
          </p>
        )}
        {ready && !settings.data.whatsappCallUrl && (
          <p className="text-sm">
            No family call link yet.{' '}
            {canManage
              ? 'Set one up below.'
              : 'Ask a household owner or admin to add one, or unlock this home display with the household PIN.'}
          </p>
        )}
        {ready && settings.data.whatsappCallUrl && !url && (
          <p role="alert" className="text-sm text-destructive">
            The saved link is invalid. Ask an owner or admin to replace or clear it.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Privacy: anyone with the link may join. Only share it with people you trust. Links expire after 30
          days without use and may be revoked by WhatsApp. Replace the saved link if it stops working.
        </p>
        {canManage && ready && (
          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <p className="text-sm">
              In WhatsApp, open Calls &gt; Create call link (or Create new call link), choose Voice or Video,
              then Copy link and paste it here. FamilyHub does not create the call.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor={id}>WhatsApp call link</Label>
              <Input
                id={id}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={500}
                value={value}
                disabled={save.isPending}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${id}-error` : undefined}
                placeholder="https://call.whatsapp.com/voice/…"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError('');
                  setStatus('');
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={save.isPending || !value}>
                Save call link
              </Button>
              {settings.data.whatsappCallUrl && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() => {
                    setError('');
                    setStatus('');
                    save.mutate(null);
                  }}
                >
                  Clear call link
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Clearing only removes the shortcut from FamilyHub; it does not revoke the WhatsApp link or end a
              call.
            </p>
          </form>
        )}
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <a
          className="inline-flex items-center gap-1 text-xs text-primary underline"
          href="https://faq.whatsapp.com/456694046556486/"
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          WhatsApp call-link help <ExternalLink className="h-3 w-3" />
        </a>
        {ready && (
          <CallGroups
            householdId={householdId}
            canManage={canManage}
            groups={settings.data.groups ?? []}
          />
        )}
      </CardContent>
    </Card>
  );
}

const slug = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'group'}-${Date.now().toString(36).slice(-6)}`;

/** Extra named call links (Friends, Grandparents, Cousins…). People outside FamilyHub join with the WhatsApp link itself. */
function CallGroups({ householdId, canManage, groups }: { householdId: string; canManage: boolean; groups: CallGroup[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const save = useMutation({
    mutationFn: (next: CallGroup[]) =>
      api<FamilyCallSettings>(hh(householdId, '/family-call/groups'), { method: 'PUT', body: { groups: next } }),
    onSuccess: (data) => {
      qc.setQueryData(familyCallQueryKey(householdId), data);
      setName('');
      setLink('');
      setError('');
    },
    onError: (err: Error) => setError(err.message),
  });
  const invite = useMutation({
    mutationFn: (groupId: string) =>
      api(hh(householdId, '/family-call/notify'), { method: 'POST', body: { groupId } }),
    onSuccess: () => setStatus('Household members were notified. Share the link in your WhatsApp group for friends; each person taps Join.'),
    onError: (err: Error) => setError(err.message),
  });
  const add = () => {
    const parsed = whatsappCallUrlSchema.safeParse(link.trim());
    if (!name.trim()) return setError('Give the group a name, for example Friends.');
    if (!parsed.success) return setError('Paste a https://call.whatsapp.com/voice/… or /video/… link.');
    if (groups.length >= 10) return setError('Up to 10 call groups.');
    save.mutate([...groups, { id: slug(name), name: name.trim().slice(0, 40), url: parsed.data }]);
  };
  if (!groups.length && !canManage) return null;
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Call groups">
      <h3 className="text-sm font-semibold">Other call groups</h3>
      <p className="text-xs text-muted-foreground">
        Keep separate WhatsApp call links for friends, grandparents or other groups. Friends don’t need a FamilyHub account.
      </p>
      {groups.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {groups.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 rounded-xl border p-3">
              <span className="flex-1 font-semibold">{g.name}</span>
              <Button asChild size="sm">
                <a href={g.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                  <Phone /> Join
                </a>
              </Button>
              {canManage && (
                <>
                  <Button size="sm" variant="outline" disabled={invite.isPending} onClick={() => invite.mutate(g.id)}>
                    Notify
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${g.name}`}
                    disabled={save.isPending}
                    onClick={() => save.mutate(groups.filter((x) => x.id !== g.id))}
                  >
                    Remove
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {status && <p role="status" className="text-sm">{status}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {canManage && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input aria-label="Group name" placeholder="Friends" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="Group call link" placeholder="https://call.whatsapp.com/video/…" value={link} onChange={(e) => setLink(e.target.value)} />
          <Button type="submit" disabled={save.isPending}>Add group</Button>
        </form>
      )}
    </section>
  );
}
