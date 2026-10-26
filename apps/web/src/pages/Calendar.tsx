import { useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import { fromTzInput, toTzInput, zoned } from '@/lib/time';
import type { DateSelectArg, EventClickArg, EventDropArg } from '@fullcalendar/core';
import { AlertTriangle, Lock, MapPin, Plus, RefreshCw, Repeat } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { CalendarDTO, EventOccurrenceDTO } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { useCalendars, useEvents, useHhMutation, useHousehold, useMembers, useRole } from '@/lib/queries';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Avatar, Badge, Switch } from '@/components/ui/misc';

const REPEAT: [string, string][] = [['', 'Does not repeat'], ['FREQ=DAILY', 'Daily'], ['FREQ=WEEKLY', 'Weekly'], ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday'], ['FREQ=MONTHLY', 'Monthly'], ['FREQ=YEARLY', 'Yearly']];
type Scope = 'this' | 'following' | 'all';

interface Draft { id?: string; occ?: EventOccurrenceDTO; calendarId: string; title: string; start: string; end: string; allDay: boolean; location: string; description: string; rrule: string; memberIds: string[]; isPrivate: boolean; reminder: string }

function EventEditor({ draft, onClose, calendars, tz }: { draft: Draft; onClose: () => void; calendars: CalendarDTO[]; tz: string }) {
  const members = useMembers().data ?? [];
  const [d, setD] = useState(draft);
  const [scope, setScope] = useState<Scope>('all');
  const isRecurring = Boolean(draft.occ?.isRecurring);
  const writable = calendars.filter((c) => c.access === 'WRITE');
  const save = useHhMutation<void>(async (hid) => {
    const startAt = d.allDay ? new Date(`${d.start}T00:00:00Z`) : fromTzInput(d.start, tz);
    let endAt = d.allDay ? new Date(`${d.end}T00:00:00Z`) : fromTzInput(d.end, tz);
    if (d.allDay && endAt <= startAt) endAt = new Date(startAt.getTime() + 86400000);
    const body = {
      calendarId: d.calendarId, title: d.title, startAt: startAt.toISOString(), endAt: endAt.toISOString(), allDay: d.allDay,
      timezone: tz, location: d.location || null, description: d.description || null, rrule: d.rrule || null, memberIds: d.memberIds,
      isPrivate: d.isPrivate, reminderMinutes: d.reminder ? [Number(d.reminder)] : [],
    };
    if (!d.id) await api(hh(hid, '/events'), { method: 'POST', body });
    else await api(hh(hid, `/events/${d.id}`), { method: 'PATCH', body: { ...body, scope: isRecurring ? scope : 'all', occurrenceStart: draft.occ?.originalStartAt ?? draft.occ?.startAt, expectedVersion: draft.occ?.version } });
  }, [['events']]);
  const del = useHhMutation<void>((hid) => api(hh(hid, `/events/${d.id}`), { method: 'DELETE', body: { scope: isRecurring ? scope : 'all', occurrenceStart: draft.occ?.originalStartAt ?? draft.occ?.startAt } }), [['events']]);
  const done = { onSuccess: onClose, onError: (e: unknown) => toast.error((e as Error).message) };
  const pickedCal = calendars.find((c) => c.id === d.calendarId);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { ...done, onSuccess: () => { toast.success(pickedCal?.source !== 'INTERNAL' ? 'Saved — syncing to provider…' : 'Saved'); onClose(); } }); }}>
      <Field label="Title"><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} required autoFocus /></Field>
      <Field label="Calendar"><Select value={d.calendarId} onChange={(e) => setD({ ...d, calendarId: e.target.value })}>{writable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <label className="flex items-center justify-between text-sm">All day <Switch checked={d.allDay} onCheckedChange={(v) => setD({ ...d, allDay: v, start: d.start.slice(0, 10) + (v ? '' : 'T09:00'), end: d.end.slice(0, 10) + (v ? '' : 'T10:00') })} /></label>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts"><Input type={d.allDay ? 'date' : 'datetime-local'} value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} required /></Field>
        <Field label="Ends"><Input type={d.allDay ? 'date' : 'datetime-local'} value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} required /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Repeat"><Select value={d.rrule} onChange={(e) => setD({ ...d, rrule: e.target.value })} disabled={isRecurring && scope === 'this'}>{REPEAT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}{d.rrule && !REPEAT.some(([v]) => v === d.rrule) && <option value={d.rrule}>Custom</option>}</Select></Field>
        <Field label="Reminder"><Select value={d.reminder} onChange={(e) => setD({ ...d, reminder: e.target.value })}><option value="">None</option><option value="10">10 min before</option><option value="30">30 min before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></Select></Field>
      </div>
      <Field label="Who"><div className="flex flex-wrap gap-2">{members.map((m) => { const on = d.memberIds.includes(m.id); return <button type="button" key={m.id} onClick={() => setD({ ...d, memberIds: on ? d.memberIds.filter((x) => x !== m.id) : [...d.memberIds, m.id] })} className={cn('flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-sm', on ? 'border-primary bg-primary/10' : 'opacity-60')}><Avatar name={m.displayName} color={m.color} size={22} />{m.displayName}</button>; })}</div></Field>
      <Field label="Location"><Input value={d.location} onChange={(e) => setD({ ...d, location: e.target.value })} /></Field>
      <Field label="Notes"><Textarea value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      <label className="flex items-center justify-between text-sm">Private (others see “Busy”) <Switch checked={d.isPrivate} onCheckedChange={(v) => setD({ ...d, isPrivate: v })} /></label>
      {isRecurring && (
        <Field label="Apply changes to"><Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}><option value="this">This event only</option><option value="following">This and following</option><option value="all">All events in the series</option></Select></Field>
      )}
      <div className="flex gap-2 pt-2">
        {d.id && <Button type="button" variant="outline" className="text-destructive" onClick={() => confirm('Delete this event?') && del.mutate(undefined, done)}>Delete</Button>}
        <Button type="submit" className="flex-1" disabled={save.isPending}>Save</Button>
      </div>
    </form>
  );
}

function EventDetails({ occ, cal, onEdit, tz }: { occ: EventOccurrenceDTO; cal?: CalendarDTO; onEdit: () => void; tz: string }) {
  const members = useMembers().data ?? [];
  const retry = useHhMutation<void>((hid) => api(hh(hid, `/events/${occ.eventId}/retry-sync`), { method: 'POST' }), [['events']]);
  if (occ.busyOnly) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock className="h-4 w-4" /> Details are private. This time is marked busy.</p>;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">{occ.allDay ? format(new Date(occ.startAt.slice(0, 10) + 'T12:00'), 'EEEE d MMMM') : `${format(zoned(occ.startAt, tz), 'EEE d MMM, p')} – ${format(zoned(occ.endAt, tz), 'p')}`}</p>
      {occ.isRecurring && <p className="flex items-center gap-2"><Repeat className="h-4 w-4" /> Repeats</p>}
      {occ.location && <p className="flex items-center gap-2"><MapPin className="h-4 w-4" /> {occ.location}</p>}
      {occ.description && <p className="whitespace-pre-wrap">{occ.description}</p>}
      <div className="flex flex-wrap gap-2">{occ.memberIds.map((id) => { const m = members.find((x) => x.id === id); return m ? <span key={id} className="flex items-center gap-1.5"><Avatar name={m.displayName} color={m.color} size={22} />{m.displayName}</span> : null; })}</div>
      <p className="flex items-center gap-2 text-muted-foreground"><span className="h-3 w-3 rounded-full" style={{ background: cal?.color ?? occ.color }} />{cal?.name}</p>
      {occ.syncState !== 'SYNCED' && occ.syncState !== 'LOCAL' && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 p-2.5 text-amber-800 dark:text-amber-300">
          <RefreshCw className="h-4 w-4" />
          <span className="flex-1">{occ.syncState.startsWith('PENDING') ? 'Waiting for the provider to confirm this change.' : occ.syncState === 'ERROR' ? `Sync failed: ${occ.syncError ?? 'unknown error'}` : `Sync: ${occ.syncState}`}</span>
          {occ.syncState === 'ERROR' && <Button size="sm" variant="outline" onClick={() => retry.mutate()}>Retry</Button>}
        </div>
      )}
      {occ.conflictsWith.length > 0 && <p className="flex items-center gap-2 text-amber-700"><AlertTriangle className="h-4 w-4" /> Overlaps another event for the same person.</p>}
      {cal?.readOnlyReason && <p className="text-xs text-muted-foreground">{cal.readOnlyReason}</p>}
      {occ.canEdit && <Button className="w-full" onClick={onEdit}>Edit</Button>}
    </div>
  );
}

export default function CalendarPage() {
  const calendars = useCalendars().data ?? [];
  const tz = useHousehold().data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const members = useMembers().data ?? [];
  const { hiddenCalendarIds, toggleCalendar, memberFilter, toggleMember, clearMemberFilter } = useUi();
  const { canWriteEvents } = useRole();
  const [range, setRange] = useState(() => { const s = new Date(); s.setDate(1); s.setDate(s.getDate() - 7); const e = new Date(s); e.setDate(e.getDate() + 49); return { start: s, end: e }; });
  const events = useEvents(range.start, range.end);
  const [selected, setSelected] = useState<EventOccurrenceDTO | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const fcRef = useRef<FullCalendar>(null);
  const defaultCal = calendars.find((c) => c.access === 'WRITE' && c.source === 'INTERNAL') ?? calendars.find((c) => c.access === 'WRITE');

  const fcEvents = useMemo(
    () =>
      (events.data ?? [])
        .filter((e) => !hiddenCalendarIds.includes(e.calendarId))
        .filter((e) => !memberFilter.length || e.memberIds.some((m) => memberFilter.includes(m)))
        .map((e) => ({
          id: e.id, title: e.title, start: e.startAt, end: e.endAt, allDay: e.allDay, backgroundColor: e.color, borderColor: e.color,
          editable: e.canEdit && !e.isRecurring, classNames: [e.busyOnly ? 'fh-busy' : '', e.syncState.startsWith('PENDING') ? 'fh-pending' : ''], extendedProps: { occ: e },
        })),
    [events.data, hiddenCalendarIds, memberFilter],
  );

  const newDraft = (start: Date, end: Date, allDay: boolean): Draft | null =>
    defaultCal ? { calendarId: defaultCal.id, title: '', start: allDay ? toTzInput(start, 'UTC', true) : toTzInput(start, tz, false), end: allDay ? toTzInput(new Date(Math.max(start.getTime(), end.getTime() - 86400000)), 'UTC', true) : toTzInput(end, tz, false), allDay, location: '', description: '', rrule: '', memberIds: [], isPrivate: false, reminder: '' } : null;

  const move = useHhMutation<{ occ: EventOccurrenceDTO; start: Date; end: Date }>((hid, v) => api(hh(hid, `/events/${v.occ.eventId}`), { method: 'PATCH', body: { startAt: v.start.toISOString(), endAt: v.end.toISOString(), scope: 'all', expectedVersion: v.occ.version } }), [['events']]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {canWriteEvents && <Button className="w-full sm:w-auto sm:shrink-0" onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); const dd = newDraft(s, new Date(s.getTime() + 3600000), false); if (dd) setDraft(dd); }}><Plus /> New event</Button>}
        <Card className="min-w-0 flex-1"><CardContent className="flex flex-wrap items-center gap-1 p-2">
          {members.map((m) => (
            <button key={m.id} onClick={() => toggleMember(m.id)} className={cn('flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-transparent px-1 py-1 pr-3 text-sm font-medium hover:bg-muted', memberFilter.includes(m.id) && 'border-primary/30 bg-primary/5', memberFilter.length && !memberFilter.includes(m.id) && 'opacity-40')}>
              <Avatar name={m.displayName} color={m.color} size={24} /> {m.displayName}
            </button>
          ))}
          {memberFilter.length > 0 && <button onClick={clearMemberFilter} className="shrink-0 whitespace-nowrap px-1 text-xs text-primary">Show everyone</button>}
        </CardContent></Card>
        <Card className="hidden min-w-0 md:block"><CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
          {calendars.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
              <input type="checkbox" checked={!hiddenCalendarIds.includes(c.id)} onChange={() => toggleCalendar(c.id)} className="h-4 w-4" style={{ accentColor: c.color }} />
              <span className="max-w-[12rem] truncate">{c.name}</span>
              {c.sync?.status === 'ERROR' && <span title={c.sync.lastError ?? ''}><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /></span>}
              {c.access === 'BUSY' && <Badge tone="muted">busy</Badge>}
            </label>
          ))}
        </CardContent></Card>
      </div>
      <Card className="min-w-0"><CardContent className="p-3 md:p-4">
        <FullCalendar
          ref={fcRef}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, luxonPlugin]}
          timeZone={tz}
          initialView={window.innerWidth < 768 ? 'listWeek' : 'dayGridMonth'}
          headerToolbar={window.innerWidth < 768 ? { left: 'prev,next', center: 'title', right: 'today' } : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' }}
          footerToolbar={window.innerWidth < 768 ? { center: 'dayGridMonth,timeGridDay,listWeek' } : undefined}
          buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'Agenda' }}
          height="auto"
          nowIndicator
          dayMaxEvents={4}
          selectable={canWriteEvents}
          selectMirror
          events={fcEvents}
          datesSet={(a) => { if (a.start.getTime() !== range.start.getTime() || a.end.getTime() !== range.end.getTime()) setRange({ start: a.start, end: a.end }); }}
          select={(a: DateSelectArg) => { const dd = newDraft(a.start, a.end, a.allDay); if (dd) setDraft(dd); a.view.calendar.unselect(); }}
          eventClick={(a: EventClickArg) => setSelected(a.event.extendedProps.occ as EventOccurrenceDTO)}
          eventDrop={(a: EventDropArg) => { const occ = a.event.extendedProps.occ as EventOccurrenceDTO; move.mutate({ occ, start: a.event.start!, end: a.event.end ?? a.event.start! }, { onError: (e) => { a.revert(); toast.error((e as Error).message); } }); }}
        />
      </CardContent></Card>
      {selected && (
        <Dialog open onOpenChange={(o) => !o && setSelected(null)} title={selected.title}>
          <EventDetails tz={tz} occ={selected} cal={calendars.find((c) => c.id === selected.calendarId)} onEdit={() => {
            const s = new Date(selected.startAt); const e = new Date(selected.endAt);
            if (selected.allDay) e.setUTCDate(e.getUTCDate() - 1);
            setDraft({ id: selected.eventId, occ: selected, calendarId: selected.calendarId, title: selected.title, start: toTzInput(s, selected.allDay ? 'UTC' : tz, selected.allDay), end: toTzInput(e < s ? s : e, selected.allDay ? 'UTC' : tz, selected.allDay), allDay: selected.allDay, location: selected.location ?? '', description: selected.description ?? '', rrule: selected.rrule ?? '', memberIds: selected.memberIds, isPrivate: selected.isPrivate, reminder: '' });
            setSelected(null);
          }} />
        </Dialog>
      )}
      {draft && <Dialog open onOpenChange={(o) => !o && setDraft(null)} title={draft.id ? 'Edit event' : 'New event'}><EventEditor draft={draft} onClose={() => setDraft(null)} calendars={calendars} tz={tz} /></Dialog>}
    </div>
  );
}
