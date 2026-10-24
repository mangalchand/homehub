import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, isPast, parseISO } from 'date-fns'
import { Check, ClipboardCheck, Plus, Star, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { Avatar, EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui'
import type { Chore } from '../types'

type Filter = 'all' | 'todo' | 'done'

export default function Chores() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const chores = useQuery({ queryKey: ['chores'], queryFn: api.listChores })
  const members = useQuery({ queryKey: ['members'], queryFn: api.listMembers })
  const inv = () => { qc.invalidateQueries({ queryKey: ['chores'] }); qc.invalidateQueries({ queryKey: ['members'] }) }

  const addMut = useMutation({ mutationFn: (c: Omit<Chore, 'id' | 'completed'>) => api.addChore(c), onSuccess: inv })
  const toggleMut = useMutation({ mutationFn: api.toggleChore, onSuccess: inv })
  const delMut = useMutation({ mutationFn: api.deleteChore, onSuccess: inv })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    addMut.mutate({
      title: String(fd.get('title')),
      assigneeId: String(fd.get('assignee')),
      points: Number(fd.get('points')),
      dueDate: new Date(String(fd.get('due')) + 'T12:00:00').toISOString(),
      recurring: String(fd.get('recurring')) as Chore['recurring'],
    })
    setOpen(false)
  }

  if (chores.isLoading) return <Loading label="Loading chores…" />
  if (chores.isError || !chores.data) return <ErrorState message="Could not load chores." onRetry={() => chores.refetch()} />

  const list = chores.data.filter((c) => filter === 'all' ? true : filter === 'done' ? c.completed : !c.completed)
  const doneCount = chores.data.filter((c) => c.completed).length
  const pct = chores.data.length ? Math.round((doneCount / chores.data.length) * 100) : 0

  return (
    <>
      <PageHeader
        title="Chores & Rewards"
        subtitle={`${doneCount}/${chores.data.length} done · ${pct}%`}
        action={<button className="btn" onClick={() => setOpen(true)}><Plus size={16} /> New chore</button>}
      />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="progress"><div style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="filters">
        {(['all', 'todo', 'done'] as Filter[]).map((f) => (
          <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'todo' ? 'To do' : f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {list.length === 0
        ? <EmptyState icon={ClipboardCheck} title="No chores here" hint="Add a chore or change the filter." />
        : (
          <div className="card">
            <div className="list">
              {list.map((c) => {
                const m = members.data?.find((x) => x.id === c.assigneeId)
                const overdue = !c.completed && isPast(parseISO(c.dueDate)) && format(parseISO(c.dueDate), 'yyyy-MM-dd') !== format(new Date(), 'yyyy-MM-dd')
                return (
                  <div className="row" key={c.id}>
                    <button className={`check${c.completed ? ' on' : ''}`} onClick={() => toggleMut.mutate(c.id)} aria-label={c.completed ? 'Mark not done' : 'Mark done'}>
                      <Check size={13} strokeWidth={3} />
                    </button>
                    {m && <Avatar name={m.name} color={m.avatarColor} size={30} />}
                    <div className="grow">
                      <div className={`title${c.completed ? ' done' : ''}`}>{c.title}</div>
                      <div className="sub">
                        {m?.name ?? 'Unassigned'} · due {format(parseISO(c.dueDate), 'MMM d')}
                        {c.recurring !== 'none' && ` · ${c.recurring}`}
                        {overdue && ' · overdue'}
                      </div>
                    </div>
                    <span className="badge amber"><Star size={11} /> {c.points}</span>
                    <button className="icon-btn" aria-label="Delete chore" onClick={() => delMut.mutate(c.id)}><Trash2 size={15} /></button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      <Modal open={open} title="New chore" onClose={() => setOpen(false)}>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Title"><input name="title" required placeholder="e.g. Empty the dishwasher" /></Field>
          <div className="form-row">
            <Field label="Assignee">
              <select name="assignee" required>
                {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Points"><input name="points" type="number" min="1" defaultValue="10" required /></Field>
          </div>
          <div className="form-row">
            <Field label="Due date"><input name="due" type="date" required defaultValue={format(new Date(), 'yyyy-MM-dd')} /></Field>
            <Field label="Repeats">
              <select name="recurring" defaultValue="none">
                <option value="none">Never</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
              </select>
            </Field>
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Add chore</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
