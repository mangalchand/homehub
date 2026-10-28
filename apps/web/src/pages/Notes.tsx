import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Pencil, Trash2 } from 'lucide-react';
import type { NoteDTO } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { useHid, useMe, useMembers, useRole } from '@/lib/queries';
import { RecordImages } from '@/components/RecordImages';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { EmptyState, PageHeader } from '@/components/ui/misc';

function NoteEditor({ note, onClose }: { note: NoteDTO | null; onClose: () => void }) {
  const hid = useHid()!;
  const qc = useQueryClient();
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [saved, setSaved] = useState(note);
  const save = useMutation({
    mutationFn: () =>
      api<NoteDTO>(hh(hid, saved ? `/notes/${saved.id}` : '/notes'), {
        method: saved ? 'PATCH' : 'POST',
        body: { title, body },
      }),
    networkMode: 'always',
    onSuccess: async (value) => {
      setSaved(value);
      await qc.invalidateQueries({ queryKey: ['notes', hid] });
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={saved ? 'Edit note' : 'New note'}
      description="Save the note first, then attach images. Images require a connection."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            autoFocus
          />
        </Field>
        <Field label="Body">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} rows={6} />
        </Field>
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {(save.error as Error).message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending || !title.trim()}>
            {save.isPending ? 'Saving…' : 'Save note'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
        {save.isSuccess && (
          <p role="status" className="text-sm text-muted-foreground">
            Note saved.
          </p>
        )}
      </form>
      {saved ? (
        <RecordImages parentType="notes" parentId={saved.id} />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Image controls appear after saving.</p>
      )}
    </Dialog>
  );
}

export default function NotesPage() {
  const hid = useHid();
  return hid ? <HouseholdNotes key={hid} householdId={hid} /> : null;
}

function HouseholdNotes({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const role = useRole();
  const members = useMembers().data ?? [];
  const [editing, setEditing] = useState<NoteDTO | 'new' | null>(null);
  const [deleting, setDeleting] = useState<NoteDTO | null>(null);
  const notes = useQuery({
    queryKey: ['notes', householdId],
    queryFn: () => api<NoteDTO[]>(hh(householdId, '/notes')),
    refetchInterval: 30_000,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(hh(householdId, `/notes/${id}`), { method: 'DELETE' }),
    networkMode: 'always',
    onSuccess: async () => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ['notes', householdId] });
    },
  });
  const canCreate = role.isDevice || ['OWNER', 'ADULT_ADMIN', 'ADULT', 'CHILD'].includes(role.role);
  const canEdit = (note: NoteDTO) =>
    canCreate &&
    (role.isAdmin ||
      (role.isDevice ? note.authorDeviceId === me?.device?.id : note.authorMemberId === role.memberId));
  return (
    <div>
      <PageHeader
        title="Household notes"
        subtitle="Shared instructions, reminders and useful details."
        actions={
          canCreate ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> New note
            </Button>
          ) : undefined
        }
      />
      {role.isDevice && (
        <p className="mb-4 text-sm text-muted-foreground">
          This display can create notes and edit its own notes. Enter the household PIN to manage other
          authors’ notes.
        </p>
      )}
      {notes.isLoading && <p role="status">Loading notes…</p>}
      {notes.error && (
        <p role="alert" className="text-destructive">
          {(notes.error as Error).message}{' '}
          <button type="button" className="underline" onClick={() => void notes.refetch()}>
            Retry
          </button>
        </p>
      )}
      {!notes.isLoading && !notes.error && !notes.data?.length && (
        <Card>
          <EmptyState
            icon={<FileText />}
            title="No notes yet"
            body="Keep household instructions together, with optional images."
          />
        </Card>
      )}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {notes.data?.map((note) => (
          <Card key={note.id} className="min-w-0">
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 break-words font-semibold">{note.title}</h2>
                {canEdit(note) && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${note.title}`}
                      onClick={() => setEditing(note)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${note.title}`}
                      onClick={() => {
                        remove.reset();
                        setDeleting(note);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">{note.body}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                By{' '}
                {note.authorMemberId
                  ? (members.find((m) => m.id === note.authorMemberId)?.displayName ?? 'Former member')
                  : 'Shared display'}{' '}
                · Created {new Date(note.createdAt).toLocaleString()} · Updated{' '}
                {new Date(note.updatedAt).toLocaleString()}
              </p>
              <RecordImages parentType="notes" parentId={note.id} readOnly />
            </CardContent>
          </Card>
        ))}
      </div>
      {editing && (
        <NoteEditor
          key={editing === 'new' ? 'new' : editing.id}
          note={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title="Delete note?"
          description="The note and its attached images will be removed."
        >
          <p className="mb-4 break-words">{deleting.title}</p>
          {remove.error && (
            <p role="alert" className="mb-3 text-destructive">
              {(remove.error as Error).message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(deleting.id)}
            >
              Delete note
            </Button>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
