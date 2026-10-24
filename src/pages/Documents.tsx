import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { FileText, FolderLock, Plus, Search, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui'
import type { VaultDocument } from '../types'

const categories: VaultDocument['category'][] = ['insurance', 'medical', 'school', 'finance', 'home', 'other']
const catBadge: Record<VaultDocument['category'], string> = {
  insurance: 'sky', medical: 'rose', school: 'amber', finance: 'green', home: '', other: 'gray',
}

export default function Documents() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const docs = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const inv = () => qc.invalidateQueries({ queryKey: ['documents'] })

  const addMut = useMutation({ mutationFn: (d: Omit<VaultDocument, 'id' | 'uploadedAt'>) => api.addDocument(d), onSuccess: inv })
  const delMut = useMutation({ mutationFn: api.deleteDocument, onSuccess: inv })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const file = (fd.get('file') as File | null)
    addMut.mutate({
      title: String(fd.get('title')),
      category: String(fd.get('category')) as VaultDocument['category'],
      sizeLabel: file && file.size > 0 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : String(fd.get('size') || '—'),
      expiresAt: fd.get('expires') ? new Date(String(fd.get('expires')) + 'T12:00:00').toISOString() : undefined,
    })
    setOpen(false)
  }

  if (docs.isLoading) return <Loading label="Opening vault…" />
  if (docs.isError || !docs.data) return <ErrorState message="Could not load documents." onRetry={() => docs.refetch()} />

  const list = docs.data.filter((d) => d.title.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <PageHeader
        title="Document Vault"
        subtitle="Important family files in one place"
        action={<button className="btn" onClick={() => setOpen(true)}><Plus size={16} /> Upload</button>}
      />

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Search size={16} className="muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search documents…"
            style={{ border: 'none', outline: 'none', flex: 1 }}
            aria-label="Search documents"
          />
        </div>
      </div>

      {list.length === 0
        ? <EmptyState icon={FolderLock} title="Vault is empty" hint="Upload insurance, medical and school records." />
        : (
          <div className="card">
            <div className="list">
              {list.map((d) => (
                <div className="row" key={d.id}>
                  <div className="stat-icon tone-indigo" style={{ width: 36, height: 36 }}><FileText size={17} /></div>
                  <div className="grow">
                    <div className="title">{d.title}</div>
                    <div className="sub">
                      {d.sizeLabel} · added {format(parseISO(d.uploadedAt), 'MMM d, yyyy')}
                      {d.expiresAt && ` · expires ${format(parseISO(d.expiresAt), 'MMM d, yyyy')}`}
                    </div>
                  </div>
                  <span className={`badge ${catBadge[d.category]}`}>{d.category}</span>
                  <button className="icon-btn" aria-label={`Delete ${d.title}`} onClick={() => delMut.mutate(d.id)}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

      <Modal open={open} title="Upload document" onClose={() => setOpen(false)}>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Title"><input name="title" required placeholder="e.g. Home insurance policy" /></Field>
          <div className="form-row">
            <Field label="Category">
              <select name="category" defaultValue="other">
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Expires (optional)"><input name="expires" type="date" /></Field>
          </div>
          <Field label="File (metadata only in demo)"><input name="file" type="file" /></Field>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Save to vault</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
