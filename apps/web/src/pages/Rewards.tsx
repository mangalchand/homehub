import { PointsReadAloudButton } from '@/features/spokenAlerts';
import { useState } from 'react';
import { Camera, Check, ExternalLink, Gift, Pencil, Plus, Sparkles, X } from 'lucide-react';
import { queryClient } from '@/lib/queryClient';
import { useUi } from '@/store/ui';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { useApprovals, useHhMutation, useMembers, usePoints, useRewards, useRole, type Reward } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { REWARD_CURRENCIES } from '@familyhub/shared';
import { Avatar, EmptyState, PageHeader } from '@/components/ui/misc';

const CURRENCY_SYMBOL: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', AED: 'AED ', SGD: 'S$' };
export const formatPrice = (cents: number, currency: string) =>
  `${CURRENCY_SYMBOL[currency] ?? currency + ' '}${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

interface RewardForm { title: string; description: string; cost: number; price: string; currency: string; linkUrl: string; isActive: boolean }
const emptyForm = (): RewardForm => ({ title: '', description: '', cost: 50, price: '', currency: 'INR', linkUrl: '', isActive: true });
const toForm = (r: Reward): RewardForm => ({ title: r.title, description: r.description ?? '', cost: r.cost, price: r.priceCents == null ? '' : String(r.priceCents / 100), currency: r.currency ?? 'INR', linkUrl: r.linkUrl ?? '', isActive: r.isActive });
/** Converts the form into the API body; the price is entered in whole currency units and stored as cents. */
export const toBody = (f: RewardForm) => ({
  title: f.title.trim(),
  description: f.description.trim() || null,
  cost: f.cost,
  isActive: f.isActive,
  priceCents: f.price.trim() === '' ? null : Math.round(Number(f.price) * 100),
  currency: f.currency,
  linkUrl: f.linkUrl.trim() || null,
});

export default function RewardsPage() {
  const members = useMembers().data ?? [];
  const rewards = useRewards().data ?? [];
  const points = usePoints().data ?? [];
  const { isAdult, canManageRewards, memberId, role } = useRole();
  const approvals = useApprovals(isAdult).data;
  const [newOpen, setNewOpen] = useState(false);
  const [redeemFor, setRedeemFor] = useState<string>(role === 'CHILD' && memberId ? memberId : '');
  const [nf, setNf] = useState<RewardForm>(emptyForm);
  const [editing, setEditing] = useState<Reward | null>(null);
  const [ef, setEf] = useState<RewardForm>(emptyForm);
  const [adjust, setAdjust] = useState<{ memberId: string; points: string; note: string } | null>(null);
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
    const r = await api<Reward>(hh(hid, '/rewards'), { method: 'POST', body: toBody(nf) });
    if (nfFile) await uploadImage(r.id, nfFile).catch(() => toast.error('Reward saved, but the picture could not be uploaded'));
  }, [['rewards']]);
  const update = useHhMutation<void>((hid) => api(hh(hid, `/rewards/${editing!.id}`), { method: 'PATCH', body: toBody(ef) }), [['rewards']]);
  const adjustPoints = useHhMutation<void>((hid) => api(hh(hid, '/points/adjust'), { method: 'POST', body: { memberId: adjust!.memberId, points: Number(adjust!.points), note: adjust!.note.trim() || undefined } }), [['points'], ['points-history']]);
  const redeem = useHhMutation<{ rewardId: string }>((hid, v) => api(hh(hid, `/rewards/${v.rewardId}/redeem`), { method: 'POST', body: { memberId: redeemFor } }), [['points'], ['approvals']]);
  const review = useHhMutation<{ kind: 'chore' | 'redemption'; id: string; approve: boolean }>(
    (hid, v) => api(hh(hid, v.kind === 'chore' ? `/completions/${v.id}/review` : `/redemptions/${v.id}/review`), { method: 'POST', body: { approve: v.approve } }),
    [['approvals'], ['points'], ['tasks']],
  );
  const name = (id: string) => members.find((m) => m.id === id);
  const pending = (approvals?.chores.length ?? 0) + (approvals?.redemptions.length ?? 0);

  return (
    <div>
      <PageHeader title="Rewards" subtitle="Points earned from chores can be traded for family rewards." actions={canManageRewards && <Button onClick={() => setNewOpen(true)}><Plus /> Reward</Button>} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {earners.map((m) => {
          const p = points.find((x) => x.memberId === m.id);
          return (
            <Card key={m.id}><CardContent className="flex items-center gap-3 p-4">
              <Avatar name={m.displayName} color={m.color} src={m.avatarUrl} size={44} />
              <div><p className="font-semibold">{m.displayName}</p><p className="flex items-center gap-1 text-2xl font-bold"><Sparkles className="h-5 w-5 text-amber-500" />{p?.available ?? 0}</p>
                {!!p && p.balance !== p.available && <p className="text-xs text-muted-foreground">{p.balance - p.available} reserved for requests</p>}
                <div className="flex flex-wrap items-center gap-1"><PointsReadAloudButton memberId={m.id} />
                  {canManageRewards && <Button size="sm" variant="ghost" onClick={() => setAdjust({ memberId: m.id, points: '', note: '' })}>Adjust points</Button>}</div></div>
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
                      {canManageRewards && (
                        <label className="absolute bottom-2 right-2 flex cursor-pointer items-center gap-1 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium shadow">
                          <Camera className="h-3.5 w-3.5" /> {r.imageUrl ? 'Change' : 'Add picture'}
                          <input type="file" accept="image/*" className="sr-only" aria-label={`Picture for ${r.title}`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadImage(r.id, f).then(() => toast.success('Picture saved'), (er) => toast.error((er as Error).message)); }} />
                        </label>
                      )}
                    </div>
                    <div className="flex items-start justify-between gap-2"><p className="font-semibold">{r.title}</p><span className="flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-sm font-semibold text-amber-700 dark:text-amber-400"><Sparkles className="h-3.5 w-3.5" />{r.cost}</span></div>
                    {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
                    {(r.priceCents != null || r.linkUrl) && (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        {r.priceCents != null && <span className="font-medium">Costs {formatPrice(r.priceCents, r.currency ?? 'INR')}</span>}
                        {r.linkUrl && <a href={r.linkUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"><ExternalLink className="h-3.5 w-3.5" /> View link</a>}
                      </p>
                    )}
                    {!r.isActive && <p className="text-xs font-medium text-muted-foreground">Hidden from the shop</p>}
                    {canManageRewards && <Button size="sm" variant="outline" onClick={() => { setEditing(r); setEf(toForm(r)); }}><Pencil /> Edit</Button>}
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
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: () => { setNewOpen(false); setNf(emptyForm()); setNfFile(null); }, onError: (er) => toast.error((er as Error).message) }); }}>
          <RewardFields f={nf} setF={setNf} />
          <Field label="Picture (optional)"><Input type="file" accept="image/*" onChange={(e) => setNfFile(e.target.files?.[0] ?? null)} /></Field>
          <Button className="w-full" type="submit" disabled={create.isPending}>Save</Button>
        </form>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }} title="Edit reward">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); update.mutate(undefined, { onSuccess: () => { setEditing(null); toast.success('Reward updated'); }, onError: (er) => toast.error((er as Error).message) }); }}>
          <RewardFields f={ef} setF={setEf} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ef.isActive} onChange={(e) => setEf({ ...ef, isActive: e.target.checked })} /> Show in the reward shop</label>
          <Button className="w-full" type="submit" disabled={update.isPending}>Save changes</Button>
        </form>
      </Dialog>
      <Dialog open={!!adjust} onOpenChange={(o) => { if (!o) setAdjust(null); }} title={`Adjust points for ${adjust ? name(adjust.memberId)?.displayName ?? 'member' : ''}`}>
        {adjust && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); adjustPoints.mutate(undefined, { onSuccess: () => { setAdjust(null); toast.success('Points updated'); }, onError: (er) => toast.error((er as Error).message) }); }}>
            <p className="text-sm text-muted-foreground">Add bonus points for a good deed, or remove points. Use a minus sign to take points away.</p>
            <Field label="Points (for example 20 or -10)"><Input type="number" step={1} min={-100000} max={100000} required autoFocus value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} /></Field>
            <Field label="Reason (optional)"><Input maxLength={200} value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} placeholder="Helped with the groceries" /></Field>
            <Button className="w-full" type="submit" disabled={adjustPoints.isPending || !adjust.points.trim() || Number(adjust.points) === 0 || !Number.isInteger(Number(adjust.points))}>Apply</Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}

function RewardFields({ f, setF }: { f: RewardForm; setF: (f: RewardForm) => void }) {
  return (
    <>
      <Field label="Reward"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required autoFocus maxLength={100} /></Field>
      <Field label="Description (optional)"><Textarea rows={2} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Cost (points)"><Input type="number" min={1} max={100000} required value={f.cost} onChange={(e) => setF({ ...f, cost: Number(e.target.value) })} /></Field>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <Field label="Price (optional)"><Input type="number" min={0} step="0.01" inputMode="decimal" placeholder="0.00" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
        <Field label="Currency"><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{REWARD_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
      </div>
      <Field label="Link (optional)"><Input type="url" inputMode="url" placeholder="https://" maxLength={500} value={f.linkUrl} onChange={(e) => setF({ ...f, linkUrl: e.target.value })} /></Field>
    </>
  );
}
