import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ShoppingCart, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/ui'
import type { GroceryItem } from '../types'

const categories: GroceryItem['category'][] = ['produce', 'dairy', 'meat', 'pantry', 'household', 'other']
const catBadge: Record<GroceryItem['category'], string> = {
  produce: 'green', dairy: 'sky', meat: 'rose', pantry: 'amber', household: '', other: 'gray',
}

export default function Groceries() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | GroceryItem['category']>('all')
  const items = useQuery({ queryKey: ['groceries'], queryFn: api.listGroceries })
  const inv = () => qc.invalidateQueries({ queryKey: ['groceries'] })

  const addMut = useMutation({
    mutationFn: (v: { name: string; qty: number; cat: GroceryItem['category'] }) => api.addGrocery(v.name, v.qty, v.cat),
    onSuccess: inv,
  })
  const toggleMut = useMutation({ mutationFn: api.toggleGrocery, onSuccess: inv })
  const delMut = useMutation({ mutationFn: api.deleteGrocery, onSuccess: inv })
  const clearMut = useMutation({ mutationFn: api.clearCheckedGroceries, onSuccess: inv })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    addMut.mutate({
      name: String(fd.get('name')),
      qty: Math.max(1, Number(fd.get('qty') || 1)),
      cat: String(fd.get('category')) as GroceryItem['category'],
    })
    form.reset()
  }

  if (items.isLoading) return <Loading label="Loading list…" />
  if (items.isError || !items.data) return <ErrorState message="Could not load groceries." onRetry={() => items.refetch()} />

  const list = items.data.filter((g) => filter === 'all' || g.category === filter)
  const checkedCount = items.data.filter((g) => g.checked).length

  return (
    <>
      <PageHeader
        title="Groceries"
        subtitle={`${items.data.length - checkedCount} items to buy`}
        action={checkedCount > 0 && <button className="btn secondary" onClick={() => clearMut.mutate()}>Clear checked ({checkedCount})</button>}
      />

      <div className="card" style={{ marginBottom: 14 }}>
        <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input name="name" required placeholder="Add an item…" style={{ flex: 2, minWidth: 160, border: '1px solid var(--line)', borderRadius: 9, padding: '9px 11px' }} />
          <input name="qty" type="number" min="1" defaultValue="1" aria-label="Quantity" style={{ width: 70, border: '1px solid var(--line)', borderRadius: 9, padding: '9px 11px' }} />
          <select name="category" defaultValue="other" aria-label="Category" style={{ border: '1px solid var(--line)', borderRadius: 9, padding: '9px 11px' }}>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="filters">
        <button className={`chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>All</button>
        {categories.map((c) => (
          <button key={c} className={`chip${filter === c ? ' active' : ''}`} onClick={() => setFilter(c)}>{c}</button>
        ))}
      </div>

      {list.length === 0
        ? <EmptyState icon={ShoppingCart} title="List is empty" hint="Add items above to start the shopping list." />
        : (
          <div className="card">
            <div className="list">
              {list.map((g) => (
                <div className="row" key={g.id}>
                  <button className={`check${g.checked ? ' on' : ''}`} onClick={() => toggleMut.mutate(g.id)} aria-label={g.checked ? 'Uncheck item' : 'Check item'}>
                    <Check size={13} strokeWidth={3} />
                  </button>
                  <div className="grow">
                    <div className={`title${g.checked ? ' done' : ''}`}>{g.name}</div>
                    <div className="sub">× {g.quantity}</div>
                  </div>
                  <span className={`badge ${catBadge[g.category]}`}>{g.category}</span>
                  <button className="icon-btn" aria-label={`Delete ${g.name}`} onClick={() => delMut.mutate(g.id)}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
    </>
  )
}
