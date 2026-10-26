import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Home, Mail, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { useMe } from '@/lib/queries';
import { useUi } from '@/store/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, PageHeader, Spinner } from '@/components/ui/misc';
import type { AcceptResult } from './Invite';

interface Invitation { id: string; householdId: string; householdName: string; invitedBy: string; role: string; expiresAt: string }

export function HomesCard() {
  const me = useMe();
  const navigate = useNavigate();
  const { householdId, setHousehold } = useUi();
  const invitations = useQuery({ queryKey: ['my-invitations'], queryFn: () => api<Invitation[]>('/api/v1/me/invitations'), enabled: me.data?.kind === 'user', refetchInterval: 30_000 });
  const open = (id: string) => { setHousehold(id); navigate('/'); };
  const accept = useMutation({
    mutationFn: (invitationId: string) => api<AcceptResult>('/api/v1/invitations/accept', { method: 'POST', body: { invitationId } }),
    onSuccess: async (r) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['me'] }), queryClient.invalidateQueries({ queryKey: ['my-invitations'] })]);
      if (r.alreadyMember && r.householdId) open(r.householdId);
      else if (r.joinRequest) navigate(`/join/${r.joinRequest.id}`);
    },
    onError: (e) => toast.error(e.message),
  });
  if (me.data?.kind !== 'user') return null;
  const memberships = me.data.memberships;
  const pending = me.data.joinRequests ?? [];
  return <Card>
    <CardHeader><CardTitle><Home className="h-5 w-5" /> My homes & invitations</CardTitle><Button size="icon" variant="ghost" aria-label="Refresh homes" onClick={() => { void me.refetch(); void invitations.refetch(); }}><RefreshCw /></Button></CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm leading-relaxed text-muted-foreground">One account, all your homes. Choose where you want to work. Each home keeps its own calendars, members and devices.</p>
      {memberships.map((m) => <div key={m.householdId} className="flex flex-wrap items-center gap-3 rounded-2xl border bg-muted/25 p-4">
        <div className="min-w-0 flex-1"><p className="break-words font-semibold">{m.householdName}</p><p className="text-xs text-muted-foreground">Already a member · {m.role.replaceAll('_', ' ').toLowerCase()}</p></div>
        <Button variant={m.householdId === householdId ? 'secondary' : 'outline'} onClick={() => open(m.householdId)}>{m.householdId === householdId && <Check />} Open home</Button>
      </div>)}
      {pending.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 p-4"><div className="min-w-0 flex-1"><p className="break-words font-semibold">{r.householdName}</p><p className="text-sm text-muted-foreground">{r.requesterVerified ? 'Waiting for household approval' : 'Confirm your emailed code to join'}</p></div><Button variant="outline" asChild><Link to={`/join/${r.id}`}>View request</Link></Button></div>)}
      {invitations.isPending && <Spinner />}
      {invitations.isError && <p role="alert" className="text-sm text-destructive">Couldn’t load invitations. Refresh to try again.</p>}
      {invitations.data?.map((i) => {
        const existing = memberships.some((m) => m.householdId === i.householdId);
        return <div key={i.id} className="space-y-3 rounded-2xl border border-primary/20 bg-primary/5 p-4"><div className="flex items-start gap-3"><Mail className="mt-1 h-5 w-5 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="break-words font-semibold">{i.householdName}</p><p className="text-sm leading-relaxed text-muted-foreground">Invited by {i.invitedBy} · expires {new Date(i.expiresAt).toLocaleDateString()}</p></div><Badge>{existing ? 'Already joined' : 'Invited'}</Badge></div><Button className="w-full sm:w-auto" disabled={accept.isPending} onClick={() => existing ? open(i.householdId) : accept.mutate(i.id)}>{existing ? 'Open home' : 'Join this home'}</Button>{!existing && <p className="text-xs leading-relaxed text-muted-foreground">Requires your emailed code and an admin’s code or approval on the home display.</p>}</div>;
      })}
      {!invitations.isPending && !invitations.isError && !invitations.data?.length && <p className="text-sm text-muted-foreground">No new invitations for {me.data.user?.email}. Invitations must match your signed-in email.</p>}
    </CardContent>
  </Card>;
}

export default function HomesPage() {
  const me = useMe().data;
  const logout = async () => { await api('/api/v1/auth/logout', { method: 'POST' }); queryClient.clear(); window.location.href = '/login'; };
  return <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6"><PageHeader title="Choose your home" subtitle="Your family, wherever you call home." actions={!me?.memberships.length ? <Button variant="outline" onClick={() => void logout()}>Sign out</Button> : undefined} /><HomesCard />{!me?.memberships.length && <Button variant="outline" asChild><Link to="/create-home">Create a new home instead</Link></Button>}</div>;
}
