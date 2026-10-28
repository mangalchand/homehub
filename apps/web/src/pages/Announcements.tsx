import { useEffect, useRef, useState } from 'react';
import { Megaphone, Mic, Pencil, Pin, Trash2 } from 'lucide-react';
import { createAnnouncementSchema } from '@familyhub/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, hh } from '@/lib/api';
import { useAnnouncements, useHid, useHousehold, useMe, type Announcement } from '@/lib/queries';
import {
  activeAnnouncements,
  announcementReading,
  canAnnounce,
  householdActor,
  voiceError,
  voiceScope,
} from '@/lib/voice/household';
import { listen, stopListening, stopSpeaking, voiceSupported } from '@/lib/voice/speech';
import { fromTzInput, toTzInput } from '@/lib/time';
import { ReadAloudButton } from '@/features/spokenAlerts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Badge, PageHeader } from '@/components/ui/misc';

const emptyDraft = {
  title: '',
  body: '',
  priority: 'NORMAL' as Announcement['priority'],
  pinned: false,
  expiresAt: '',
  repeatDaily: false,
  dailyTime: '20:30',
};

export default function AnnouncementsPage() {
  const hid = useHid();
  const me = useMe().data;
  const scope = hid ? voiceScope(me, hid) : null;
  if (!hid || !scope) return <p role="status">Choose an authorized home to view announcements.</p>;
  return <AnnouncementsContent key={scope} householdId={hid} scope={scope} />;
}

function AnnouncementsContent({ householdId: hid, scope }: { householdId: string; scope: string }) {
  const me = useMe().data;
  const timezone = useHousehold().data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const allowed = canAnnounce(me, hid);
  const device = householdActor(me, hid)?.kind === 'device';
  const announcements = useAnnouncements();
  const items = activeAnnouncements(announcements.data ?? []);
  const qc = useQueryClient();
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [listening, setListening] = useState(false);
  const operation = useRef(0);
  useEffect(
    () => () => {
      operation.current++;
      stopListening();
      stopSpeaking();
    },
    [],
  );

  const save = useMutation({
    mutationFn: async ({ id, body }: { id: string | null; body: unknown }) => {
      if (!canAnnounce(me, hid))
        throw new Error(
          device
            ? 'Unlock parent mode with the household PIN before posting.'
            : 'You do not have permission to edit announcements.',
        );
      return api(hh(hid, `/announcements${id ? `/${id}` : ''}`), { method: id ? 'PATCH' : 'POST', body });
    },
    onSuccess: () => {
      setDraft(emptyDraft);
      setEditing(null);
      setNotice('Announcement saved.');
      void qc.invalidateQueries({ queryKey: ['announcements', hid] });
    },
    onError: (e) => setError(voiceError(e, device)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!canAnnounce(me, hid)) throw new Error('You do not have permission to delete announcements.');
      return api(hh(hid, `/announcements/${id}`), { method: 'DELETE' });
    },
    onSuccess: () => {
      setDeleteId(null);
      setNotice('Announcement deleted.');
      void qc.invalidateQueries({ queryKey: ['announcements', hid] });
    },
    onError: (e) => setError(voiceError(e, device)),
  });
  const working = save.isPending || remove.isPending;
  const cancelVoice = () => {
    operation.current++;
    stopListening();
    setListening(false);
  };
  const dictate = async () => {
    if (!device || listening) return;
    setError('');
    setNotice('');
    if (!voiceSupported()) {
      setError('Speech recognition is unavailable. Type your announcement instead.');
      return;
    }
    const op = ++operation.current;
    setListening(true);
    try {
      const text = await listen();
      if (op !== operation.current) return;
      if (!text.trim()) setError('No speech was heard. Try again or type your announcement.');
      else {
        setDraft((d) => ({ ...d, title: text.trim().replace(/^announce\s+/i, '') }));
        setNotice('Review the text, then choose Post announcement. Voice never posts automatically.');
      }
    } catch (e) {
      if (op === operation.current) setError(`${voiceError(e)} Type your announcement instead.`);
    } finally {
      if (op === operation.current) setListening(false);
    }
  };
  const edit = (a: Announcement) => {
    cancelVoice();
    setError('');
    setNotice('');
    setDeleteId(null);
    setEditing(a.id);
    setDraft({
      title: a.title,
      body: a.body ?? '',
      priority: a.priority,
      pinned: a.pinned,
      expiresAt: a.expiresAt ? toTzInput(new Date(a.expiresAt), timezone, false) : '',
      repeatDaily: a.repeatDaily,
      dailyTime: a.dailyTime ?? '20:30',
    });
  };
  const submit = () => {
    setError('');
    setNotice('');
    let expiresAt: string | null = null;
    if (draft.expiresAt) {
      const date = fromTzInput(draft.expiresAt, timezone);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        setError('Choose an expiry in the future.');
        return;
      }
      expiresAt = date.toISOString();
    }
    const parsed = createAnnouncementSchema.safeParse({
      ...draft,
      dailyTime: draft.repeatDaily ? draft.dailyTime : null,
      expiresAt,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check your announcement.');
      return;
    }
    save.mutate({ id: editing, body: parsed.data });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Announcements"
        subtitle="Active household messages. Pin important notes or mark urgent updates."
      />
      <ReadAloudButton
        scope={scope}
        load={async () => announcementReading(await api<Announcement[]>(hh(hid, '/announcements')))}
        label="Read announcements aloud"
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {allowed || device ? (
        <Card>
          <CardContent className="pt-5">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <h2 className="font-semibold">{editing ? 'Edit announcement' : 'New announcement'}</h2>
              {!allowed && (
                <p className="text-sm text-muted-foreground">
                  Unlock parent mode using the household PIN to post, edit or delete announcements.
                </p>
              )}
              <Field label="Announcement">
                <Input
                  value={draft.title}
                  maxLength={140}
                  required
                  disabled={working || listening}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="Dinner is ready"
                />
              </Field>
              <Field label="Details (optional)">
                <Textarea
                  value={draft.body}
                  maxLength={2000}
                  disabled={working}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Priority">
                  <Select
                    value={draft.priority}
                    disabled={working}
                    onChange={(e) =>
                      setDraft({ ...draft, priority: e.target.value as Announcement['priority'] })
                    }
                  >
                    <option value="NORMAL">Normal</option>
                    <option value="IMPORTANT">Important</option>
                    <option value="URGENT">Urgent</option>
                  </Select>
                </Field>
                <Field label={`Expires (${timezone}, optional)`}>
                  <Input
                    type="datetime-local"
                    value={draft.expiresAt}
                    disabled={working}
                    onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.pinned}
                  disabled={working}
                  onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })}
                />
                Pin announcement
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.repeatDaily}
                  disabled={working}
                  onChange={(e) => setDraft({ ...draft, repeatDaily: e.target.checked })}
                />
                Repeat every day
              </label>
              {draft.repeatDaily && (
                <Field label={`Daily notification time (${timezone})`}>
                  <Input
                    type="time"
                    value={draft.dailyTime}
                    disabled={working}
                    required
                    onChange={(e) => setDraft({ ...draft, dailyTime: e.target.value })}
                  />
                </Field>
              )}
              <div className="flex flex-wrap gap-2">
                {device &&
                  (listening ? (
                    <Button type="button" variant="outline" onClick={cancelVoice}>
                      Cancel microphone
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" disabled={working} onClick={() => void dictate()}>
                      <Mic />
                      Dictate announcement
                    </Button>
                  ))}
                <Button type="submit" disabled={!allowed || working || listening}>
                  {working ? 'Saving…' : editing ? 'Save announcement' : 'Post announcement'}
                </Button>
                {editing && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={working}
                    onClick={() => {
                      cancelVoice();
                      setEditing(null);
                      setDraft(emptyDraft);
                    }}
                  >
                    Cancel edit
                  </Button>
                )}
              </div>
              {listening && <p role="status">Listening for one announcement…</p>}
            </form>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only authorized adults or PIN-unlocked household displays can post or manage announcements.
        </p>
      )}
      {announcements.isPending ? (
        <p role="status">Loading announcements…</p>
      ) : announcements.isError ? (
        <p role="alert">
          Could not load announcements. {voiceError(announcements.error)}{' '}
          <Button variant="outline" onClick={() => void announcements.refetch()}>
            Retry
          </Button>
        </p>
      ) : !items.length ? (
        <p className="py-6 text-center text-muted-foreground">No active announcements.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((a) => (
            <Card key={a.id} className={a.priority === 'URGENT' ? 'border-destructive/50' : ''}>
              <CardContent className="space-y-3 pt-5">
                <div className="flex flex-wrap gap-2">
                  {a.pinned && (
                    <Badge>
                      <Pin className="h-3 w-3" />
                      Pinned
                    </Badge>
                  )}
                  {a.priority !== 'NORMAL' && (
                    <Badge tone={a.priority === 'URGENT' ? 'danger' : 'warning'}>
                      {a.priority === 'URGENT' ? 'Urgent' : 'Important'}
                    </Badge>
                  )}
                </div>
                <h2 className="flex items-center gap-2 font-semibold">
                  <Megaphone className="h-4 w-4 shrink-0" />
                  {a.title}
                </h2>
                {a.body && (
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{a.body}</p>
                )}
                {a.repeatDaily && a.dailyTime && (
                  <p className="text-xs text-muted-foreground">
                    Repeats every day at {a.dailyTime} ({timezone})
                  </p>
                )}
                {a.expiresAt && (
                  <p className="text-xs text-muted-foreground">
                    Expires{' '}
                    {new Intl.DateTimeFormat(undefined, {
                      timeZone: timezone,
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(a.expiresAt))}
                  </p>
                )}
                {allowed && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={working} onClick={() => edit(a)}>
                      <Pencil />
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" disabled={working} onClick={() => setDeleteId(a.id)}>
                      <Trash2 />
                      Delete
                    </Button>
                  </div>
                )}
                {allowed && deleteId === a.id && (
                  <div className="space-y-2" role="group" aria-label={`Delete ${a.title}`}>
                    <p className="text-sm">Delete this announcement permanently?</p>
                    <Button
                      size="sm"
                      disabled={working}
                      onClick={() => {
                        setError('');
                        remove.mutate(a.id);
                      }}
                    >
                      Confirm delete
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeleteId(null)}>
                      Cancel delete
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
