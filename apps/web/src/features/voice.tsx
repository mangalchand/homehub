import { useEffect, useRef, useState } from 'react';
import { format, isSameDay } from 'date-fns';
import { Mic, X } from 'lucide-react';
import type { CalendarDTO, EventOccurrenceDTO, MemberDTO } from '@familyhub/shared';
import { api, ApiRequestError, hh } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { useHousehold, type Household, type ListSummary, type Task } from '@/lib/queries';
import { cn, uuid } from '@/lib/utils';
import { capitalize, parseCommand, type VoiceCommand } from '@/lib/voice/parse';
import { listen, speak, stopListening, stopSpeaking, voiceSupported } from '@/lib/voice/speech';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fromTzInput, zoned } from '@/lib/time';

const HELP = 'Try: "add task call the plumber tomorrow at 5 pm", "add milk and eggs to the grocery list", "add event dentist Friday at 4 pm", "what\'s on today", or "which chores are left".';

const when = (d: Date, now = new Date()) =>
  `${isSameDay(d, now) ? 'today' : isSameDay(d, new Date(now.getTime() + 86400000)) ? 'tomorrow' : format(d, 'EEEE d MMMM')}${d.getHours() || d.getMinutes() ? ` at ${format(d, 'h:mm a')}` : ''}`;

const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

async function run(hid: string, cmd: VoiceCommand, tz: string): Promise<string> {
  const members = await api<MemberDTO[]>(hh(hid, '/members'));
  const findMember = (name?: string) => (name ? members.find((m) => m.firstName.toLowerCase() === name.toLowerCase() || m.displayName.toLowerCase() === name.toLowerCase()) : undefined);

  switch (cmd.kind) {
    case 'help':
      return HELP;
    case 'unknown':
      return `Sorry, I didn't understand "${cmd.text}". ${HELP}`;
    case 'task': {
      const m = findMember(cmd.memberName);
      const title = capitalize(m || !cmd.memberName ? cmd.title : `${cmd.title} for ${cmd.memberName}`);
      await api(hh(hid, '/tasks'), { method: 'POST', body: { kind: 'TASK', title, dueAt: cmd.due ? fromTzInput(format(cmd.due, "yyyy-MM-dd'T'HH:mm"), tz).toISOString() : null, memberIds: m ? [m.id] : [] } });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      return `Added task: ${title}${m ? ` for ${m.displayName}` : ''}${cmd.due ? `, due ${when(cmd.due)}` : ''}.`;
    }
    case 'grocery': {
      const lists = await api<ListSummary[]>(hh(hid, '/lists'));
      const list = lists.find((l) => l.type === 'GROCERY' && !l.isTemplate) ?? lists.find((l) => l.type === 'GROCERY');
      if (!list) return 'There is no grocery list yet. Create one in Lists first.';
      for (const name of cmd.items) await api(hh(hid, `/lists/${list.id}/items`), { method: 'POST', body: { id: uuid(), name: capitalize(name) } });
      void queryClient.invalidateQueries({ queryKey: ['lists'] });
      return `Added ${listJoin(cmd.items)} to ${list.name}.`;
    }
    case 'event': {
      const [cals, household] = await Promise.all([api<CalendarDTO[]>(hh(hid, '/calendars')), api<Household>(hh(hid, ''))]);
      const writable = cals.filter((c) => c.access === 'WRITE' && c.source === 'INTERNAL');
      const cal = writable.find((c) => c.category === 'FAMILY') ?? writable[0];
      if (!cal) return 'I could not find a family calendar to add this to.';
      const m = findMember(cmd.memberName);
      const ymd = format(cmd.start, 'yyyy-MM-dd');
      const startAt = cmd.allDay ? new Date(`${ymd}T00:00:00Z`) : fromTzInput(format(cmd.start, "yyyy-MM-dd'T'HH:mm"), tz);
      const endAt = new Date(startAt.getTime() + (cmd.allDay ? 86400000 : 3600000));
      const title = capitalize(cmd.title);
      await api(hh(hid, '/events'), { method: 'POST', body: { calendarId: cal.id, title, startAt: startAt.toISOString(), endAt: endAt.toISOString(), allDay: cmd.allDay, timezone: household.timezone, memberIds: m ? [m.id] : [] } });
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      return `Added ${title} to the calendar ${cmd.allDay ? (isSameDay(cmd.start, new Date()) ? 'today' : `on ${format(cmd.start, 'EEEE d MMMM')}`) : when(cmd.start)}.`;
    }
    case 'agenda': {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      if (cmd.day === 'tomorrow') day.setDate(day.getDate() + 1);
      const end = new Date(day.getTime() + 86400000);
      const events = (await api<EventOccurrenceDTO[]>(hh(hid, `/events?start=${encodeURIComponent(day.toISOString())}&end=${encodeURIComponent(end.toISOString())}`)))
        .filter((e) => (cmd.day === 'tomorrow' || new Date(e.endAt) > new Date()))
        .sort((a, b) => a.startAt.localeCompare(b.startAt));
      if (!events.length) return `Nothing on the calendar ${cmd.day === 'today' ? 'for the rest of today' : 'tomorrow'}.`;
      const items = events.slice(0, 5).map((e) => `${e.busyOnly ? 'a private event' : e.title}${e.allDay ? ' all day' : ` at ${format(new Date(e.startAt), 'h:mm a')}`}`);
      return `${cmd.day === 'today' ? 'Today' : 'Tomorrow'} you have ${events.length} ${events.length === 1 ? 'event' : 'events'}: ${listJoin(items)}${events.length > 5 ? ', and more' : ''}.`;
    }
    case 'chores': {
      const chores = await api<Task[]>(hh(hid, '/tasks?kind=CHORE'));
      const lines = members
        .filter((m) => m.isActive)
        .map((m) => {
          const mine = chores.filter((t) => t.dueOnDate && (t.currentAssigneeIds.length ? t.currentAssigneeIds.includes(m.id) : t.memberIds.includes(m.id)));
          const left = mine.filter((t) => !t.completions.some((c) => c.memberId === m.id));
          if (!mine.length) return null;
          return left.length ? `${m.displayName} has ${left.length} left: ${listJoin(left.map((t) => t.title.toLowerCase()))}` : `${m.displayName} is all done`;
        })
        .filter(Boolean);
      return lines.length ? `${lines.join('. ')}.` : 'No chores today.';
    }
  }
}

/** Floating mic for the paired home display: speak a command, it acts and answers out loud. */
export function VoiceButton({ householdId }: { householdId: string }) {
  const [state, setState] = useState<'idle' | 'listening' | 'review' | 'working' | 'done'>('idle');
  const timezone = useHousehold().data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const operation = useRef(0);
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [ok, setOk] = useState(true);
  useEffect(() => () => { operation.current++; stopListening(); stopSpeaking(); }, []);
  const close = () => { operation.current++; stopListening(); stopSpeaking(); setState('idle'); };

  const start = async () => {
    if (state === 'working') return;
    if (state === 'listening') { stopListening(); return; }
    setHeard(''); setReply(''); setOk(true);
    setState('listening');
    const op = ++operation.current;
    try {
      const text = await listen();
      if (op !== operation.current) return;
      if (!text) { setState('done'); setOk(false); setReply('I didn’t hear anything. Tap the mic and try again.'); return; }
      setHeard(text);
      setState('review');
    } catch (e) {
      if (op !== operation.current) return;
      setOk(false); setReply(`${(e as Error).message} You can type your command below instead.`); setState('review');
    }
  };

  const execute = async () => {
    if (state === 'working' || !heard.trim()) return;
    try {
      setState('working');
      const cmd = parseCommand(heard, zoned(new Date(), timezone));
      const answer = await run(householdId, cmd, timezone);
      setOk(cmd.kind !== 'unknown');
      setReply(answer);
      setState('done');
      void speak(answer);
    } catch (e) {
      const msg = e instanceof ApiRequestError && e.status === 403 ? 'That needs parent mode. Tap the lock, enter the PIN, then try again.' : (e as Error).message;
      setOk(false); setReply(msg); setState('done');
      void speak(msg);
    }
  };

  return (
    <>
      {state !== 'idle' && (
        <div className="fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-lg rounded-2xl border bg-card p-4 shadow-lift md:bottom-28 md:left-28 md:mx-0" role="status" aria-live="polite">
          <div className="flex items-start gap-3">
            <span className={cn('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full', state === 'listening' ? 'animate-pulse bg-primary text-primary-foreground' : ok ? 'bg-primary/10 text-primary' : 'bg-amber-500/15 text-amber-700')}><Mic className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-semibold">{state === 'listening' ? 'Listening… say a command' : state === 'working' ? 'Working on it…' : state === 'review' ? 'Check your command' : ok ? 'Done' : 'Hmm'}</p>
              {state === 'review' ? <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void execute(); }}><Input aria-label="Your voice command" value={heard} onChange={(e) => setHeard(e.target.value)} placeholder="Add task call the plumber tomorrow" /><Button type="submit" disabled={!heard.trim()}>Run command</Button></form> : heard && <p className="text-sm italic text-muted-foreground">“{heard}”</p>}
              {reply && <p className="text-[15px] leading-relaxed">{reply}</p>}
              {state === 'listening' && !heard && <p className="text-xs leading-relaxed text-muted-foreground">{HELP}</p>}
            </div>
            <button className="-m-1 rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label="Close voice command" disabled={state === 'working'} onClick={close}><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}
      <button
        onClick={() => { if (voiceSupported()) void start(); else { setState('review'); setReply('Speech recognition is unavailable. Type a command below.'); } }}
        disabled={state === 'working'}
        aria-label="Voice command"
        className={cn('fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lift transition-transform active:scale-95 md:bottom-6 md:left-6 md:right-auto', state === 'listening' && 'ring-8 ring-primary/25')}
      >
        <Mic className="h-7 w-7" />
      </button>
    </>
  );
}
