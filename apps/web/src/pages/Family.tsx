import { useState } from 'react';
import { Copy, MessageCircle, Plus, Share2, UserMinus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { assignableRoles, DEVICE_ASSIGNABLE_ROLES, type MemberDTO, type MemberRole } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { useHhMutation, useMembers, usePoints, useRole } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, PageHeader } from '@/components/ui/misc';
import { JoinRequestsCard } from '@/features/join';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];
const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADULT_ADMIN: 'Parent (admin)', ADULT: 'Adult', CHILD: 'Child', GUEST: 'Guest / caregiver' };

function MemberDialog({ member, inviteOnly = false, onClose }: { member: MemberDTO | null; inviteOnly?: boolean; onClose: () => void }) {
  const { role, isDevice } = useRole();
  const assignable: string[] = isDevice ? DEVICE_ASSIGNABLE_ROLES : assignableRoles(role as MemberRole);
  const [f, setF] = useState({ firstName: member?.firstName ?? '', displayName: member?.displayName ?? '', role: member?.role ?? 'CHILD', color: member?.color ?? COLORS[3]!, birthDate: member?.birthDate?.slice(0, 10) ?? '' });
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = useHhMutation<void>((hid) => api(hh(hid, `/members/${member!.id}`), { method: 'DELETE' }), [['members'], ['me'], ['points'], ['join']]);
  const save = useHhMutation<void, { id?: string }>((hid) => {
    const body = { ...f, displayName: f.displayName || f.firstName, birthDate: f.birthDate || null };
    return member ? api(hh(hid, `/members/${member.id}`), { method: 'PATCH', body }) : api(hh(hid, '/members'), { method: 'POST', body });
  }, [['members']]);
  const invite = useHhMutation<string | undefined, { acceptUrl: string; emailSent?: boolean }>((hid, memberId) => api(hh(hid, '/invitations'), { method: 'POST', body: { email, role: f.role, memberId } }), [['members']]);
  const sendInvite = (memberId?: string) => invite.mutate(memberId, { onSuccess: (r) => { setLink(r.acceptUrl); setEmailed(Boolean(r.emailSent)); setEmail(''); }, onError: (er) => toast.error((er as Error).message) });
  const shareText = link ? `Join our family on FamilyHub: ${link}` : '';
  if (removing && member) return <Dialog open onOpenChange={(o) => !o && onClose()} title={`Remove ${member.displayName}?`} description="This removes their access to this home, not their account or their other homes. Past tasks, events and history are kept. Outstanding invitations to this home are revoked."><div className="grid grid-cols-2 gap-3"><Button variant="outline" disabled={remove.isPending} onClick={() => setRemoving(false)}>Keep member</Button><Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => { toast.success('Member removed from this home'); onClose(); }, onError: (e) => toast.error((e as Error).message) })}>Remove member</Button></div></Dialog>;
  if (link) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title="Invitation ready" description={`${emailed ? 'We also emailed this link to them. ' : ''}Send this link to them. They sign up with the email you entered and confirm it with a code. Then you approve them here with a code we email you, or tap Approve on the home display. The link works once and expires in 7 days.`}>
        <div className="space-y-3">
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <div className="grid gap-2 sm:grid-cols-3">
            <Button asChild className="bg-[#25D366] text-white hover:bg-[#1ebe5b]"><a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer"><MessageCircle /> WhatsApp</a></Button>
            <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success('Link copied'))}><Copy /> Copy link</Button>
            {'share' in navigator && <Button variant="secondary" onClick={() => void navigator.share({ title: 'FamilyHub invitation', text: shareText }).catch(() => undefined)}><Share2 /> Share…</Button>}
          </div>
          <Button variant="ghost" className="w-full" onClick={onClose}>Done</Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={member ? `Edit ${member.displayName}` : inviteOnly ? 'Invite by email' : 'Add family member'} description={inviteOnly ? 'Already have an account? They can sign in and choose this home. New members can create an account. Both need the join code and household approval.' : 'Profiles don’t need an email. Invite someone to give them their own login.'}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (inviteOnly) return sendInvite(); save.mutate(undefined, { onSuccess: (r) => (!member && email && r?.id ? sendInvite(r.id) : onClose()), onError: (er) => toast.error((er as Error).message) }); }}>
        {!inviteOnly && <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} required autoFocus /></Field>
          <Field label="Display name"><Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={f.firstName} /></Field>
        </div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as MemberDTO['role'] })} disabled={member?.role === 'OWNER'}>{Object.entries(ROLE_LABEL).filter(([r]) => r === member?.role || assignable.includes(r)).map(([r, l]) => <option key={r} value={r}>{l}</option>)}</Select></Field>
          {!inviteOnly && <Field label="Birthday"><Input type="date" value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} /></Field>}
        </div>
        {!inviteOnly && <Field label="Color"><div className="flex gap-2">{COLORS.map((c) => <button key={c} type="button" aria-label={c} onClick={() => setF({ ...f, color: c })} className="h-8 w-8 rounded-full ring-offset-2 ring-offset-card" style={{ background: c, boxShadow: f.color === c ? `0 0 0 3px ${c}55` : undefined, outline: f.color === c ? '2px solid currentColor' : undefined }} />)}</div></Field>}
        {!member && <Field label={inviteOnly ? 'Email' : 'Email (optional)'} hint="Use their existing FamilyHub email if they already have an account."><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" required={inviteOnly} /></Field>}
        <Button type="submit" disabled={save.isPending || invite.isPending} className="w-full">{inviteOnly ? 'Create invite link' : !member && email ? 'Save & create invite link' : 'Save'}</Button>
      </form>
      {member && !member.hasLogin && (
        <form className="mt-6 space-y-2 border-t pt-4" onSubmit={(e) => { e.preventDefault(); sendInvite(member.id); }}>
          <Field label="Invite to sign in" hint="You’ll get a link to send them on WhatsApp or anywhere."><div className="flex gap-2"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" required /><Button type="submit" variant="secondary">Invite</Button></div></Field>
        </form>
      )}
      {member?.isActive && member.role !== 'OWNER' && assignable.includes(member.role) && <Button variant="outline" className="mt-5 w-full text-destructive" onClick={() => setRemoving(true)}><UserMinus /> Remove from this home</Button>}
    </Dialog>
  );
}

export default function FamilyPage() {
  const members = useMembers().data ?? [];
  const points = usePoints().data ?? [];
  const { isAdmin, isDevice } = useRole();
  const [editing, setEditing] = useState<MemberDTO | 'new' | 'invite' | null>(null);
  return (
    <div>
      <PageHeader title="Family" subtitle="Profiles, colors and who can do what." actions={isAdmin && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setEditing('invite')}>Invite by email</Button><Button onClick={() => setEditing('new')}><Plus /> Add member</Button></div>} />
      {isDevice && !isAdmin && <p className="mb-5 rounded-xl border bg-muted/50 p-4 text-sm">Unlock with the household PIN using the lock icon to add, invite or remove members. Owners and parent admins cannot be removed from a home display.</p>}
      {isAdmin && <JoinRequestsCard isDevice={isDevice} className="mb-5" />}
      {members.length === 0 ? <Card><EmptyState icon={<Users />} title="No members" /></Card> : (
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {members.map((m) => (
            <Card key={m.id} className={isAdmin ? 'cursor-pointer transition-shadow hover:shadow-md' : ''} onClick={() => isAdmin && setEditing(m)}>
              <CardContent className="flex items-center gap-4 p-4">
                <Avatar name={m.displayName} color={m.color} size={48} />
                <div className="min-w-0 flex-1">
                  <p className="text-[17px] font-semibold leading-snug">{m.displayName}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5"><Badge tone="muted">{ROLE_LABEL[m.role]}</Badge>{m.hasLogin && <Badge tone="success">Has login</Badge>}{!m.isActive && <Badge tone="danger">Inactive</Badge>}</div>
                </div>
                {(points.find((p) => p.memberId === m.id)?.balance ?? 0) > 0 && <span className="text-sm font-semibold text-amber-600">{points.find((p) => p.memberId === m.id)!.balance} pts</span>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing && <MemberDialog member={typeof editing === 'string' ? null : editing} inviteOnly={editing === 'invite'} onClose={() => setEditing(null)} />}
    </div>
  );
}
