import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, isPast, isToday, parseISO } from 'date-fns'
import { Bell, Check, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { Avatar, EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui'
import type { Reminder } from '../types'

const prioBadge: Record<Reminder['priority'], string> = { high: 'rose', medium: 'amber', low: 'gray' }

export default function Reminders() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<'active' | 'done' | 'all'>('active')
  const reminders = useQuery({ queryKey: ['reminders'], queryFn: api.listReminders })
  const members = useQuery({ queryKey: ['members'], queryFn: api.listMembers })
  const inv = () => qc.invalidateQueries({ queryKey: ['reminders'] })

  const addMut = useMutation({ mutationFn: (r: Omit<Reminder, 'id' | 'done'>) => api.addReminder(r), onSuccess: inv })
  const toggleMut = useMutation({ mutationFn: api.toggleReminder, onSuccess: inv })
  const delMut = useMutation({ mutationFn: api.deleteReminder, onSuccess: inv })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    addMut.mutate({
      title: String(fd.get('title')),
      dueAt: new Date(String(fd.get('due')) + 'T12:00:00').toISOString(),
      memberId: String(fd.get('member')) || undefined,
      priority: String(fd.get('priority')) as Reminder['priority'],
    })
    setOpen(false)
  }

  if (reminders.isLoading) return <Loading label="Loading reminders…" />
  if (reminders.isError || !reminders.data) return <ErrorState message="Could not load reminders." onRetry={() => reminders.refetch()} />

  const list = reminders.data
    .filter((r) => filter === 'all' ? true : filter === 'done' ? r.done : !r.done)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))

  const dueLabel = (iso: string) => {
    const d = parseISO(iso)
    if (isToday(d)) return 'Today'
    if (isPast(d)) return `Overdue · ${format(d, 'MMM d')}`
    return format(d, 'EEE, MMM d')
  }

  return (
    <>
      <PageHeader
        title="Reminder Center"
        subtitle={`${reminders.data.filter((r) => !r.done).length} active`}
        action={<button className="btn" onClick={() => setOpen(true)}><Plus size={16} /> New reminder</button>}
      />

      <div className="filters">
        {(['active', 'done', 'all'] as const).map((f) => (
          <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {list.length === 0
        ? <EmptyState icon={Bell} title="Nothing here" hint="Create a reminder so nothing slips through." />
        : (
          <div className="card">
            <div className="list">
              {list.map((r) => {
                const m = members.data?.find((x) => x.id === r.memberId)
                return (
                  <div className="row" key={r.id}>
                    <button className={`check${r.done ? ' on' : ''}`} onClick={() => toggleMut.mutate(r.id)} aria-label={r.done ? 'Reopen' : 'Mark done'}>
                      <Check size={13} strokeWidth={3} />
                    </button>
                    {m && <Avatar name={m.name} color={m.avatarColor} size={30} />}
                    <div className="grow">
                      <div className={`title${r.done ? ' done' : ''}`}>{r.title}</div>
                      <div className="sub">{dueLabel(r.dueAt)}{m && ` · ${m.name}`}</div>
                    </div>
                    <span className={`badge ${prioBadge[r.priority]}`}>{r.priority}</span>
                    <button className="icon-btn" aria-label="Delete reminder" onClick={() => delMut.mutate(r.id)}><Trash2 size={15} /></button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      <Modal open={open} title="New reminder" onClose={() => setOpen(false)}>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Title"><input name="title" required placeholder="e.g. Book dentist appointment" /></Field>
          <div className="form-row">
            <Field label="Due date"><input name="due" type="date" required defaultValue={format(new Date(), 'yyyy-MM-dd')} /></Field>
            <Field label="Priority">
              <select name="priority" defaultValue="medium">
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
              </select>
            </Field>
          </div>
          <Field label="Assign to (optional)">
            <select name="member" defaultValue="">
              <option value="">Anyone</option>
              {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Add reminder</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
