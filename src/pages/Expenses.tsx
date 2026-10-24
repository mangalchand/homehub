import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, isThisMonth, parseISO } from 'date-fns'
import { Plus, Receipt, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { Avatar, EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui'
import type { Expense } from '../types'

const categories: Expense['category'][] = ['food', 'housing', 'transport', 'kids', 'fun', 'utilities', 'other']
const catBadge: Record<Expense['category'], string> = {
  food: 'green', housing: '', transport: 'sky', kids: 'amber', fun: 'rose', utilities: 'gray', other: 'gray',
}

export default function Expenses() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | Expense['category']>('all')
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: api.listExpenses })
  const members = useQuery({ queryKey: ['members'], queryFn: api.listMembers })
  const inv = () => qc.invalidateQueries({ queryKey: ['expenses'] })

  const addMut = useMutation({ mutationFn: (e: Omit<Expense, 'id'>) => api.addExpense(e), onSuccess: inv })
  const delMut = useMutation({ mutationFn: api.deleteExpense, onSuccess: inv })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    addMut.mutate({
      title: String(fd.get('title')),
      amount: Number(fd.get('amount')),
      category: String(fd.get('category')) as Expense['category'],
      date: new Date(String(fd.get('date')) + 'T12:00:00').toISOString(),
      paidById: String(fd.get('paidBy')) || undefined,
    })
    setOpen(false)
  }

  if (expenses.isLoading) return <Loading label="Loading expenses…" />
  if (expenses.isError || !expenses.data) return <ErrorState message="Could not load expenses." onRetry={() => expenses.refetch()} />

  const list = expenses.data.filter((e) => filter === 'all' || e.category === filter)
  const monthTotal = expenses.data.filter((e) => isThisMonth(parseISO(e.date))).reduce((s, e) => s + e.amount, 0)
  const byCat = categories
    .map((c) => ({ c, total: expenses.data.filter((e) => e.category === c && isThisMonth(parseISO(e.date))).reduce((s, e) => s + e.amount, 0) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
  const max = byCat[0]?.total ?? 1

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle={`$${monthTotal.toFixed(2)} spent this month`}
        action={<button className="btn" onClick={() => setOpen(true)}><Plus size={16} /> Add expense</button>}
      />

      {byCat.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>This month by category</h2>
          {byCat.map(({ c, total }) => (
            <div key={c} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.83rem', marginBottom: 4 }}>
                <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{c}</span>
                <span className="muted">${total.toFixed(2)}</span>
              </div>
              <div className="progress"><div style={{ width: `${(total / max) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      <div className="filters">
        <button className={`chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>All</button>
        {categories.map((c) => (
          <button key={c} className={`chip${filter === c ? ' active' : ''}`} onClick={() => setFilter(c)}>{c}</button>
        ))}
      </div>

      {list.length === 0
        ? <EmptyState icon={Receipt} title="No expenses" hint="Log spending to see the family budget." />
        : (
          <div className="card">
            <div className="list">
              {list.map((e) => {
                const m = members.data?.find((x) => x.id === e.paidById)
                return (
                  <div className="row" key={e.id}>
                    {m && <Avatar name={m.name} color={m.avatarColor} size={30} />}
                    <div className="grow">
                      <div className="title">{e.title}</div>
                      <div className="sub">{format(parseISO(e.date), 'MMM d, yyyy')}{m && ` · paid by ${m.name}`}</div>
                    </div>
                    <span className={`badge ${catBadge[e.category]}`}>{e.category}</span>
                    <strong style={{ fontSize: '0.92rem' }}>${e.amount.toFixed(2)}</strong>
                    <button className="icon-btn" aria-label="Delete expense" onClick={() => delMut.mutate(e.id)}><Trash2 size={15} /></button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      <Modal open={open} title="Add expense" onClose={() => setOpen(false)}>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Title"><input name="title" required placeholder="e.g. Weekly groceries" /></Field>
          <div className="form-row">
            <Field label="Amount ($)"><input name="amount" type="number" min="0" step="0.01" required placeholder="0.00" /></Field>
            <Field label="Date"><input name="date" type="date" required defaultValue={format(new Date(), 'yyyy-MM-dd')} /></Field>
          </div>
          <div className="form-row">
            <Field label="Category">
              <select name="category" defaultValue="food">
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Paid by">
              <select name="paidBy" defaultValue="">
                <option value="">—</option>
                {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Add</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
