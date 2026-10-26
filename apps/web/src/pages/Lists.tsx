import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Download, ListChecks, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { useHhMutation, useHid, useList, useLists, type ListItem } from '@/lib/queries';
import { cn, uuid } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader } from '@/components/ui/misc';

const TYPES = ['GROCERY', 'TODO', 'HOUSEHOLD', 'SCHOOL', 'PACKING', 'WISHLIST', 'CUSTOM'];

function ListDetail({ listId }: { listId: string }) {
  const hid = useHid();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: list } = useList(listId);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const key = ['lists', listId, hid];

  const patchCache = (fn: (items: ListItem[]) => ListItem[]) =>
    qc.setQueryData<{ items: ListItem[] }>(key, (old) => (old ? { ...old, items: fn(old.items) } : old));

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const item: ListItem = { id: uuid(), listId, name: name.trim(), quantity: qty || null, unit: null, category: null, notes: null, isDone: false, doneByMemberId: null, sortOrder: 9999, version: 1, updatedAt: new Date().toISOString(), pending: true };
    patchCache((items) => [...items, item]);
    setName('');
    setQty('');
    try {
      await api(hh(hid!, `/lists/${listId}/items`), { method: 'POST', body: { id: item.id, name: item.name, quantity: item.quantity ?? undefined }, offlineQueue: true });
    } catch (err) {
      toast.error((err as Error).message);
    }
    void qc.invalidateQueries({ queryKey: ['lists'] });
  };
  const toggle = async (it: ListItem) => {
    patchCache((items) => items.map((x) => (x.id === it.id ? { ...x, isDone: !x.isDone } : x)));
    try {
      await api(hh(hid!, `/lists/${listId}/items/${it.id}`), { method: 'PATCH', body: { isDone: !it.isDone, expectedVersion: it.version }, offlineQueue: true });
    } catch (err) {
      toast.error((err as Error).message);
    }
    void qc.invalidateQueries({ queryKey: ['lists'] });
  };
  const remove = async (it: ListItem) => {
    patchCache((items) => items.filter((x) => x.id !== it.id));
    await api(hh(hid!, `/lists/${listId}/items/${it.id}`), { method: 'DELETE', offlineQueue: true }).catch((e) => toast.error((e as Error).message));
    void qc.invalidateQueries({ queryKey: ['lists'] });
  };
  const clearDone = useHhMutation<void>((h) => api(hh(h, `/lists/${listId}/clear-done`), { method: 'POST' }), [['lists']]);
  const duplicate = useHhMutation<string, { id: string }>((h, n) => api(hh(h, `/lists/${listId}/duplicate`), { method: 'POST', body: { name: n } }), [['lists']]);
  const delList = useHhMutation<void>((h) => api(hh(h, `/lists/${listId}`), { method: 'DELETE' }), [['lists']]);

  const groups = useMemo(() => {
    const open = (list?.items ?? []).filter((i) => !i.isDone && !i.deleted);
    const g = new Map<string, ListItem[]>();
    for (const i of open) {
      const k = list?.type === 'GROCERY' ? i.category ?? 'Other' : '';
      g.set(k, [...(g.get(k) ?? []), i]);
    }
    return [...g.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  }, [list]);
  const done = (list?.items ?? []).filter((i) => i.isDone && !i.deleted);

  if (!list) return null;
  const Row = ({ it }: { it: ListItem }) => (
    <li className="group flex items-start gap-3 rounded-xl px-2 py-2.5 hover:bg-muted/60">
      <input type="checkbox" checked={it.isDone} onChange={() => void toggle(it)} className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]" aria-label={`Mark ${it.name}`} />
      <span className={cn('min-w-0 flex-1 leading-snug', it.isDone && 'text-muted-foreground line-through', it.pending && 'opacity-60')}>{it.name}</span>
      {it.quantity && <Badge tone="muted">{it.quantity}{it.unit ? ` ${it.unit}` : ''}</Badge>}
      <button onClick={() => void remove(it)} className="shrink-0 p-0.5 text-muted-foreground transition-opacity hover:text-destructive focus:opacity-100 md:opacity-0 md:group-hover:opacity-100" aria-label={`Remove ${it.name}`}><Trash2 className="h-4 w-4" /></button>
    </li>
  );
  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/lists" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All lists</Link>
      <PageHeader
        title={list.name}
        subtitle={`${list.items.filter((i) => !i.isDone && !i.deleted).length} to go`}
        actions={<>
          <Button variant="outline" size="icon" title="Export CSV" asChild><a href={hh(hid!, `/lists/${listId}/export.csv`)}><Download /></a></Button>
          <Button variant="outline" size="icon" title="Duplicate" onClick={() => duplicate.mutate(`${list.name} (copy)`, { onSuccess: (l) => navigate(`/lists/${l.id}`) })}><Copy /></Button>
          <Button variant="outline" size="icon" title="Delete list" onClick={() => confirm(`Delete “${list.name}”?`) && delList.mutate(undefined, { onSuccess: () => navigate('/lists') })}><Trash2 /></Button>
        </>}
      />
      <Card>
        <CardContent className="p-4">
          <form onSubmit={add} className="mb-4 flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add an item…" aria-label="New item" className="flex-1" autoFocus />
            <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" aria-label="Quantity" className="w-20" />
            <Button type="submit" size="icon" aria-label="Add"><Plus /></Button>
          </form>
          {groups.length === 0 && done.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">This list is empty.</p>}
          {groups.map(([cat, items]) => (
            <div key={cat} className="mb-3">
              {cat && <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{cat}</p>}
              <ul>{items.map((it) => <Row key={it.id} it={it} />)}</ul>
            </div>
          ))}
          {done.length > 0 && (
            <div className="mt-4 border-t pt-3">
              <div className="mb-1 flex items-center justify-between px-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Done ({done.length})</p><Button variant="ghost" size="sm" onClick={() => clearDone.mutate()}>Clear</Button></div>
              <ul>{done.map((it) => <Row key={it.id} it={it} />)}</ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ListsPage() {
  const { listId } = useParams();
  const lists = useLists().data ?? [];
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', type: 'TODO' });
  const create = useHhMutation<void, { id: string }>((hid) => api(hh(hid, '/lists'), { method: 'POST', body: f }), [['lists']]);
  if (listId) return <ListDetail listId={listId} />;
  return (
    <div>
      <PageHeader title="Lists" subtitle="Groceries, to-dos and packing — shared in real time." actions={<Button onClick={() => setOpen(true)}><Plus /> New list</Button>} />
      {lists.length === 0 ? <Card><EmptyState icon={<ListChecks />} title="No lists yet" /></Card> : (
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {lists.map((l) => (
            <Link key={l.id} to={`/lists/${l.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="rounded-xl bg-primary/10 p-2.5 text-primary">{l.type === 'GROCERY' ? <ShoppingCart className="h-5 w-5" /> : <ListChecks className="h-5 w-5" />}</div>
                  <div className="min-w-0 flex-1"><p className="font-semibold leading-snug">{l.name}</p><p className="text-sm text-muted-foreground">{l.openCount} open · {l.doneCount} done</p></div>
                  {l.isTemplate && <Badge tone="muted">Template</Badge>}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title="New list">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: (l) => { setOpen(false); navigate(`/lists/${l.id}`); }, onError: (er) => toast.error((er as Error).message) }); }}>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t[0] + t.slice(1).toLowerCase()}</option>)}</Select></Field>
          <Button type="submit" className="w-full">Create</Button>
        </form>
      </Dialog>
    </div>
  );
}
