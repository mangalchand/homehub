import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Mail, Trash2, UserPlus, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { Avatar, EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui'
import type { FamilyMember, Invitation } from '../types'

export default function Family() {
  const qc = useQueryClient()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const members = useQuery({ queryKey: ['members'], queryFn: api.listMembers })
  const invites = useQuery({ queryKey: ['invitations'], queryFn: api.listInvitations })
  const inv = () => qc.invalidateQueries()

  const inviteMut = useMutation({ mutationFn: ({ email, role }: { email: string; role: Invitation['role'] }) => api.inviteMember(email, role), onSuccess: inv })
  const addMut = useMutation({ mutationFn: ({ name, role }: { name: string; role: FamilyMember['role'] }) => api.addMember(name, role), onSuccess: inv })
  const delMut = useMutation({ mutationFn: api.removeMember, onSuccess: inv })
  const cancelMut = useMutation({ mutationFn: api.cancelInvitation, onSuccess: inv })

  const onInvite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    inviteMut.mutate({ email: String(fd.get('email')), role: String(fd.get('role')) as Invitation['role'] })
    setInviteOpen(false)
  }
  const onAdd = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    addMut.mutate({ name: String(fd.get('name')), role: String(fd.get('role')) as FamilyMember['role'] })
    setAddOpen(false)
  }

  if (members.isLoading) return <Loading label="Loading family…" />
  if (members.isError || !members.data) return <ErrorState message="Could not load family members." onRetry={() => members.refetch()} />

  return (
    <>
      <PageHeader
        title="Family"
        subtitle="Manage members and invitations"
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn secondary" onClick={() => setAddOpen(true)}><UserPlus size={16} /> Add member</button>
            <button className="btn" onClick={() => setInviteOpen(true)}><Mail size={16} /> Invite</button>
          </div>
        }
      />

      <div className="grid cols-2">
        <section className="card">
          <h2>Members ({members.data.length})</h2>
          {members.data.length === 0
            ? <EmptyState icon={Users} title="No members yet" hint="Add your first family member." />
            : (
              <div className="list">
                {members.data.map((m) => (
                  <div className="row" key={m.id}>
                    <Avatar name={m.name} color={m.avatarColor} size={40} />
                    <div className="grow">
                      <div className="title">{m.name}</div>
                      <div className="sub">{m.email ?? 'No email'} · {m.points} pts</div>
                    </div>
                    <span className={`badge ${m.role === 'child' ? 'amber' : 'sky'}`}>{m.role}</span>
                    <button className="icon-btn" aria-label={`Remove ${m.name}`} onClick={() => delMut.mutate(m.id)}><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            )}
        </section>

        <section className="card">
          <h2>Invitations</h2>
          {!invites.data || invites.data.length === 0
            ? <EmptyState icon={Mail} title="No pending invites" hint="Invite relatives or caregivers by email." />
            : (
              <div className="list">
                {invites.data.map((i) => (
                  <div className="row" key={i.id}>
                    <div className="grow">
                      <div className="title">{i.email}</div>
                      <div className="sub">sent {formatDistanceToNow(parseISO(i.sentAt), { addSuffix: true })}</div>
                    </div>
                    <span className="badge gray">{i.role}</span>
                    <span className={`badge ${i.status === 'pending' ? 'amber' : 'green'}`}>{i.status}</span>
                    <button className="icon-btn" aria-label="Cancel invitation" onClick={() => cancelMut.mutate(i.id)}><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            )}
        </section>
      </div>

      <Modal open={inviteOpen} title="Invite to FamilyHub" onClose={() => setInviteOpen(false)}>
        <form onSubmit={onInvite} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Email address"><input name="email" type="email" required placeholder="grandma@example.com" /></Field>
          <Field label="Role">
            <select name="role" defaultValue="guardian">
              <option value="parent">Parent</option>
              <option value="guardian">Guardian</option>
              <option value="child">Child</option>
            </select>
          </Field>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setInviteOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Send invite</button>
          </div>
        </form>
      </Modal>

      <Modal open={addOpen} title="Add family member" onClose={() => setAddOpen(false)}>
        <form onSubmit={onAdd} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Name"><input name="name" required placeholder="e.g. Riley" /></Field>
          <Field label="Role">
            <select name="role" defaultValue="child">
              <option value="parent">Parent</option>
              <option value="guardian">Guardian</option>
              <option value="child">Child</option>
            </select>
          </Field>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setAddOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Add</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
