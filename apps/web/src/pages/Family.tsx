import { useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { MemberDTO } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { useHhMutation, useMembers, usePoints, useRole } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, PageHeader } from '@/components/ui/misc';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];
const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADULT_ADMIN: 'Parent (admin)', ADULT: 'Adult', CHILD: 'Child', GUEST: 'Guest / caregiver' };

function MemberDialog({ member, onClose }: { member: MemberDTO | null; onClose: () => void }) {
  const [f, setF] = useState({ firstName: member?.firstName ?? '', displayName: member?.displayName ?? '', role: member?.role ?? 'CHILD', color: member?.color ?? COLORS[3]!, birthDate: member?.birthDate?.slice(0, 10) ?? '' });
  const [email, setEmail] = useState('');
  const save = useHhMutation<void>((hid) => {
    const body = { ...f, displayName: f.displayName || f.firstName, birthDate: f.birthDate || null };
    return member ? api(hh(hid, `/members/${member.id}`), { method: 'PATCH', body }) : api(hh(hid, '/members'), { method: 'POST', body });
  }, [['members']]);
  const invite = useHhMutation<void>((hid) => api(hh(hid, '/invitations'), { method: 'POST', body: { email, role: f.role, memberId: member?.id } }), [['members']]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={member ? `Edit ${member.displayName}` : 'Add family member'} description="Profiles don’t need an email. Invite someone to give them their own login.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose, onError: (er) => toast.error((er as Error).message) }); }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} required autoFocus /></Field>
          <Field label="Display name"><Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={f.firstName} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as MemberDTO['role'] })} disabled={member?.role === 'OWNER'}>{Object.entries(ROLE_LABEL).filter(([r]) => r !== 'OWNER' || member?.role === 'OWNER').map(([r, l]) => <option key={r} value={r}>{l}</option>)}</Select></Field>
          <Field label="Birthday"><Input type="date" value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} /></Field>
        </div>
        <Field label="Color"><div className="flex gap-2">{COLORS.map((c) => <button key={c} type="button" aria-label={c} onClick={() => setF({ ...f, color: c })} className="h-8 w-8 rounded-full ring-offset-2 ring-offset-card" style={{ background: c, boxShadow: f.color === c ? `0 0 0 3px ${c}55` : undefined, outline: f.color === c ? '2px solid currentColor' : undefined }} />)}</div></Field>
        <Button type="submit" className="w-full">Save</Button>
      </form>
      {member && !member.hasLogin && (
        <form className="mt-6 space-y-2 border-t pt-4" onSubmit={(e) => { e.preventDefault(); invite.mutate(undefined, { onSuccess: () => { toast.success('Invitation created'); setEmail(''); }, onError: (er) => toast.error((er as Error).message) }); }}>
          <Field label="Invite to sign in" hint="They’ll get a link to create a login linked to this profile."><div className="flex gap-2"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" required /><Button type="submit" variant="secondary">Invite</Button></div></Field>
        </form>
      )}
    </Dialog>
  );
}

export default function FamilyPage() {
  const members = useMembers().data ?? [];
  const points = usePoints().data ?? [];
  const { isAdmin } = useRole();
  const [editing, setEditing] = useState<MemberDTO | 'new' | null>(null);
  return (
    <div>
      <PageHeader title="Family" subtitle="Profiles, colors and who can do what." actions={isAdmin && <Button onClick={() => setEditing('new')}><Plus /> Add member</Button>} />
      {members.length === 0 ? <Card><EmptyState icon={<Users />} title="No members" /></Card> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {members.map((m) => (
            <Card key={m.id} className={isAdmin ? 'cursor-pointer transition-shadow hover:shadow-md' : ''} onClick={() => isAdmin && setEditing(m)}>
              <CardContent className="flex items-center gap-4 p-4">
                <Avatar name={m.displayName} color={m.color} size={52} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-semibold">{m.displayName}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5"><Badge tone="muted">{ROLE_LABEL[m.role]}</Badge>{m.hasLogin && <Badge tone="success">Has login</Badge>}{!m.isActive && <Badge tone="danger">Inactive</Badge>}</div>
                </div>
                {(points.find((p) => p.memberId === m.id)?.balance ?? 0) > 0 && <span className="text-sm font-semibold text-amber-600">{points.find((p) => p.memberId === m.id)!.balance} pts</span>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing && <MemberDialog member={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
