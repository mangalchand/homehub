import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { CheckCircle2, Plus, Trash2, Wrench } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui'
import type { MaintenanceTask } from '../types'

const statusBadge: Record<MaintenanceTask['status'], string> = {
  done: 'green', due: 'amber', overdue: 'rose', upcoming: 'gray',
}

export default function Maintenance() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const tasks = useQuery({ queryKey: ['maintenance'], queryFn: api.listMaintenance })
  const inv = () => qc.invalidateQueries({ queryKey: ['maintenance'] })

  const addMut = useMutation({ mutationFn: (t: Omit<MaintenanceTask, 'id' | 'status'>) => api.addMaintenance(t), onSuccess: inv })
  const doneMut = useMutation({ mutationFn: api.completeMaintenance, onSuccess: inv })
  const delMut = useMutation({ mutationFn: api.deleteMaintenance, onSuccess: inv })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    addMut.mutate({
      title: String(fd.get('title')),
      area: String(fd.get('area')),
      dueDate: new Date(String(fd.get('due')) + 'T12:00:00').toISOString(),
      intervalMonths: Number(fd.get('interval')) || undefined,
      notes: String(fd.get('notes')) || undefined,
    })
    setOpen(false)
  }

  if (tasks.isLoading) return <Loading label="Loading maintenance…" />
  if (tasks.isError || !tasks.data) return <ErrorState message="Could not load tasks." onRetry={() => tasks.refetch()} />

  const sorted = [...tasks.data].sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || a.dueDate.localeCompare(b.dueDate))

  return (
    <>
      <PageHeader
        title="Home Maintenance"
        subtitle="Keep the house running smoothly"
        action={<button className="btn" onClick={() => setOpen(true)}><Plus size={16} /> New task</button>}
      />

      {sorted.length === 0
        ? <EmptyState icon={Wrench} title="No maintenance tasks" hint="Track filters, gutters, detectors and more." />
        : (
          <div className="card">
            <div className="list">
              {sorted.map((t) => (
                <div className="row" key={t.id}>
                  <div className="grow">
                    <div className={`title${t.status === 'done' ? ' done' : ''}`}>{t.title}</div>
                    <div className="sub">
                      {t.area} · due {format(parseISO(t.dueDate), 'MMM d, yyyy')}
                      {t.intervalMonths && ` · every ${t.intervalMonths} mo`}
                      {t.lastDone && ` · last done ${format(parseISO(t.lastDone), 'MMM d')}`}
                      {t.notes && ` · ${t.notes}`}
                    </div>
                  </div>
                  <span className={`badge ${statusBadge[t.status]}`}>{t.status}</span>
                  {t.status !== 'done' && (
                    <button className="btn secondary small" onClick={() => doneMut.mutate(t.id)}>
                      <CheckCircle2 size={14} /> Done
                    </button>
                  )}
                  <button className="icon-btn" aria-label="Delete task" onClick={() => delMut.mutate(t.id)}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

      <Modal open={open} title="New maintenance task" onClose={() => setOpen(false)}>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Title"><input name="title" required placeholder="e.g. Replace HVAC filter" /></Field>
          <div className="form-row">
            <Field label="Area"><input name="area" required placeholder="e.g. HVAC" /></Field>
            <Field label="Due date"><input name="due" type="date" required /></Field>
          </div>
          <div className="form-row">
            <Field label="Interval (months, optional)"><input name="interval" type="number" min="1" placeholder="e.g. 6" /></Field>
            <Field label="Notes (optional)"><input name="notes" placeholder="e.g. Annual flush" /></Field>
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Add task</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
