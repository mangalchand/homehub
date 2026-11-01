import { PointsReadAloudButton } from '@/features/spokenAlerts';
import { useState } from 'react';
import { Camera, Check, Gift, Plus, Sparkles, X } from 'lucide-react';
import { queryClient } from '@/lib/queryClient';
import { useUi } from '@/store/ui';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { useApprovals, useHhMutation, useMembers, usePoints, useRewards, useRole, type Reward } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Avatar, EmptyState, PageHeader } from '@/components/ui/misc';

export default function RewardsPage() {
  const members = useMembers().data ?? [];
  const rewards = useRewards().data ?? [];
  const points = usePoints().data ?? [];
  const { isAdult, memberId, role } = useRole();
  const approvals = useApprovals(isAdult).data;
  const [newOpen, setNewOpen] = useState(false);
  const [redeemFor, setRedeemFor] = useState<string>(role === 'CHILD' && memberId ? memberId : '');
  const [nf, setNf] = useState({ title: '', cost: 50 });
  const earners = members.filter((m) => points.some((p) => p.memberId === m.id && (p.balance || p.pending)) || m.role === 'CHILD');

  const { householdId } = useUi();
  const [nfFile, setNfFile] = useState<File | null>(null);
  const uploadImage = async (rewardId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    await api(hh(householdId!, `/rewards/${rewardId}/image`), { method: 'POST', formData });
    await queryClient.invalidateQueries({ queryKey: ['rewards'] });
  };
  const create = useHhMutation<void>(async (hid) => {
    const r = await api<Reward>(hh(hid, '/rewards'), { method: 'POST', body: nf });
    if (nfFile) await uploadImage(r.id, nfFile).catch(() => toast.error('Reward saved, but the picture could not be uploaded'));
  }, [['rewards']]);
  const redeem = useHhMutation<{ rewardId: string }>((hid, v) => api(hh(hid, `/rewards/${v.rewardId}/redeem`), { method: 'POST', body: { memberId: redeemFor } }), [['points'], ['approvals']]);
  const review = useHhMutation<{ kind: 'chore' | 'redemption'; id: string; approve: boolean }>(
    (hid, v) => api(hh(hid, v.kind === 'chore' ? `/completions/${v.id}/review` : `/redemptions/${v.id}/review`), { method: 'POST', body: { approve: v.approve } }),
    [['approvals'], ['points'], ['tasks']],
  );
  const name = (id: string) => members.find((m) => m.id === id);
  const pending = (approvals?.chores.length ?? 0) + (approvals?.redemptions.length ?? 0);

  return (
    <div>
      <PageHeader title="Rewards" subtitle="Points earned from chores can be traded for family rewards." actions={isAdult && <Button onClick={() => setNewOpen(true)}><Plus /> Reward</Button>} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {earners.map((m) => {
          const p = points.find((x) => x.memberId === m.id);
          return (
            <Card key={m.id}><CardContent className="flex items-center gap-3 p-4">
              <Avatar name={m.displayName} color={m.color} src={m.avatarUrl} size={44} />
              <div><p className="font-semibold">{m.displayName}</p><p className="flex items-center gap-1 text-2xl font-bold"><Sparkles className="h-5 w-5 text-amber-500" />{p?.available ?? 0}</p>
                {!!p && p.balance !== p.available && <p className="text-xs text-muted-foreground">{p.balance - p.available} reserved for requests</p>}
                <PointsReadAloudButton memberId={m.id} /></div>
            </CardContent></Card>
          );
        })}
      </div>
      {isAdult && pending > 0 && (
        <Card className="mb-6 border-amber-500/40">
          <CardHeader><CardTitle>Waiting for approval ({pending})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {[...(approvals?.chores.map((c) => ({ ...c, kind: 'chore' as const, label: `finished “${c.title}”`, pts: `+${c.points}` })) ?? []), ...(approvals?.redemptions.map((r) => ({ ...r, kind: 'redemption' as const, label: `wants “${r.title}”`, pts: `−${r.points}` })) ?? [])].map((a) => {
              const m = name(a.memberId);
              return (
                <div key={a.id} className="flex items-center gap-3 rounded-xl bg-muted/50 p-2.5">
                  {m && <Avatar name={m.displayName} color={m.color} src={m.avatarUrl} size={30} />}
                  <p className="flex-1 text-sm"><b>{m?.displayName}</b> {a.label} <span className="text-muted-foreground">({a.pts} pts)</span></p>
                  <Button size="sm" variant="outline" aria-label="Decline" onClick={() => review.mutate({ kind: a.kind, id: a.id, approve: false })}><X /></Button>
                  <Button size="sm" aria-label="Approve" onClick={() => review.mutate({ kind: a.kind, id: a.id, approve: true }, { onSuccess: () => toast.success('Approved') })}><Check /> Approve</Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle><Gift className="h-5 w-5" /> Reward shop</CardTitle>
          {role !== 'CHILD' && (
            <Select className="w-44" value={redeemFor} onChange={(e) => setRedeemFor(e.target.value)} aria-label="Redeem for">
              <option value="">Redeem for…</option>
              {earners.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </Select>
          )}
        </CardHeader>
        <CardContent>
          {rewards.length === 0 ? <EmptyState icon={<Gift />} title="No rewards yet" body="Add rewards like extra screen time or choosing Friday dinner." /> : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rewards.map((r) => {
                const avail = points.find((p) => p.memberId === redeemFor)?.available ?? 0;
                return (
                  <div key={r.id} className="flex flex-col gap-3 rounded-2xl border p-4">
                    <div className="relative">
                      {r.imageUrl ? (
                        <img src={r.imageUrl} alt={r.title} loading="lazy" className="aspect-[4/3] w-full rounded-xl object-cover" />
                      ) : (
                        <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl bg-gradient-to-br from-amber-100 via-rose-50 to-indigo-100 text-amber-600"><Gift className="h-10 w-10" /></div>
                      )}
                      {isAdult && (
                        <label className="absolute bottom-2 right-2 flex cursor-pointer items-center gap-1 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium shadow">
                          <Camera className="h-3.5 w-3.5" /> {r.imageUrl ? 'Change' : 'Add picture'}
                          <input type="file" accept="image/*" className="sr-only" aria-label={`Picture for ${r.title}`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadImage(r.id, f).then(() => toast.success('Picture saved'), (er) => toast.error((er as Error).message)); }} />
                        </label>
                      )}
                    </div>
                    <div className="flex items-start justify-between gap-2"><p className="font-semibold">{r.title}</p><span className="flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-sm font-semibold text-amber-700 dark:text-amber-400"><Sparkles className="h-3.5 w-3.5" />{r.cost}</span></div>
                    {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
                    <Button variant="secondary" disabled={!redeemFor || avail < r.cost || redeem.isPending} onClick={() => redeem.mutate({ rewardId: r.id }, { onSuccess: () => toast.success('Request sent to a parent'), onError: (e) => toast.error((e as Error).message) })}>
                      {redeemFor && avail < r.cost ? `${r.cost - avail} more points needed` : 'Request'}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <Dialog open={newOpen} onOpenChange={setNewOpen} title="New reward">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: () => { setNewOpen(false); setNfFile(null); }, onError: (er) => toast.error((er as Error).message) }); }}>
          <Field label="Reward"><Input value={nf.title} onChange={(e) => setNf({ ...nf, title: e.target.value })} required autoFocus /></Field>
          <Field label="Cost (points)"><Input type="number" min={1} value={nf.cost} onChange={(e) => setNf({ ...nf, cost: Number(e.target.value) })} /></Field>
          <Field label="Picture (optional)"><Input type="file" accept="image/*" onChange={(e) => setNfFile(e.target.files?.[0] ?? null)} /></Field>
          <Button className="w-full" type="submit" disabled={create.isPending}>Save</Button>
        </form>
      </Dialog>
    </div>
  );
}
