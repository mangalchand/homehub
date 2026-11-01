import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { useHid, useMe } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/input';

const KEY = 'fh_alexa_link';
const PARAMS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method'] as const;

/** Alexa opens /alexa/link?...; remember the request across the sign-in screen. */
export function rememberAlexaLink(search: string) {
  if (new URLSearchParams(search).get('redirect_uri')) sessionStorage.setItem(KEY, search);
}
export const pendingAlexaLink = () => sessionStorage.getItem(KEY);

export function AlexaLinkPage() {
  const me = useMe().data;
  const params = new URLSearchParams(pendingAlexaLink() ?? '');
  const homes = me?.memberships ?? [];
  const [hid, setHid] = useState(homes[0]?.householdId ?? '');
  const [busy, setBusy] = useState(false);
  const done = () => {
    sessionStorage.removeItem(KEY);
    window.location.href = '/';
  };
  const linkNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ redirectTo: string }>('/api/v1/alexa/authorize', {
        method: 'POST',
        body: {
          clientId: params.get(PARAMS[0]) ?? '',
          redirectUri: params.get(PARAMS[1]) ?? '',
          state: params.get(PARAMS[2]) ?? '',
          householdId: hid,
          ...(params.get(PARAMS[3]) ? { codeChallenge: params.get(PARAMS[3]), codeChallengeMethod: params.get(PARAMS[4]) ?? 'S256' } : {}),
        },
      });
      sessionStorage.removeItem(KEY);
      window.location.href = r.redirectTo;
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md p-6">
      <Card>
        <CardHeader><CardTitle>Link FamilyHub to Alexa</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Alexa will be able to add tasks and list items, read today’s calendar, points, your notifications and the daily summary for the home you choose. It acts with your permissions, and you can unlink any time in Settings.
          </p>
          {homes.length > 1 && (
            <Field label="Home">
              <Select value={hid} onChange={(e) => setHid(e.target.value)}>
                {homes.map((m) => <option key={m.householdId} value={m.householdId}>{m.householdName}</option>)}
              </Select>
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !hid} onClick={() => void linkNow()}>Link to Alexa</Button>
            <Button variant="outline" disabled={busy} onClick={done}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

type Links = { configured: boolean; links: { id: string; createdAt: string; lastUsedAt: string | null }[] };

export function AlexaSection() {
  const hid = useHid();
  const q = useQuery({ queryKey: ['alexa-links', hid], queryFn: () => api<Links>(hh(hid!, '/alexa')), enabled: Boolean(hid) });
  const unlink = async (id: string) => {
    try {
      await api(hh(hid!, `/alexa/${id}`), { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['alexa-links', hid] });
      toast.success('Alexa unlinked');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!q.data) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Alexa</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!q.data.configured ? (
          <p className="text-muted-foreground">Not connected: the FamilyHub Alexa skill hasn’t been set up on this server yet.</p>
        ) : q.data.links.length ? (
          q.data.links.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <span>Linked {new Date(l.createdAt).toLocaleDateString()}{l.lastUsedAt ? `, last used ${new Date(l.lastUsedAt).toLocaleString()}` : ''}</span>
              <Button size="sm" variant="outline" onClick={() => void unlink(l.id)}>Unlink</Button>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">Not linked. In the Alexa app, open Skills, find FamilyHub and tap Enable to use, then sign in. Then say “Alexa, open family hub”.</p>
        )}
      </CardContent>
    </Card>
  );
}
