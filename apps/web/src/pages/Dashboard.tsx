import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Megaphone, ShoppingCart, Sparkles } from 'lucide-react';
import { addDays, format, isSameDay, startOfDay } from 'date-fns';
import type { EventOccurrenceDTO, MemberDTO } from '@familyhub/shared';
import { useActiveLayout, useAnnouncements, useEvents, useList, useLists, useMembers, usePoints, useTasks, type Widget } from '@/lib/queries';
import { MemberChoreColumn } from '@/features/chores';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, Badge } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(t); }, []);
  return (
    <div>
      <p className="text-5xl font-bold tabular-nums tracking-tight md:text-6xl">{format(now, 'h:mm')}<span className="ml-1 text-2xl font-medium text-muted-foreground">{format(now, 'a')}</span></p>
      <p className="text-lg text-muted-foreground">{format(now, 'EEEE, d MMMM')}</p>
    </div>
  );
}

function EventRow({ e, members }: { e: EventOccurrenceDTO; members: MemberDTO[] }) {
  const past = new Date(e.endAt) < new Date();
  return (
    <div className={cn('flex items-center gap-3 rounded-xl p-2', past && 'opacity-50')}>
      <span className="h-10 w-1.5 shrink-0 rounded-full" style={{ background: e.color }} />
      <div className="w-16 shrink-0 text-sm tabular-nums text-muted-foreground">{e.allDay ? 'All day' : format(new Date(e.startAt), 'h:mm a')}</div>
      <div className="min-w-0 flex-1"><p className={cn('truncate font-medium', e.busyOnly && 'italic text-muted-foreground')}>{e.title}</p>{e.location && <p className="truncate text-xs text-muted-foreground">{e.location}</p>}</div>
      <div className="flex -space-x-1.5">{e.memberIds.slice(0, 4).map((id) => { const m = members.find((x) => x.id === id); return m ? <Avatar key={id} name={m.displayName} color={m.color} size={24} /> : null; })}</div>
    </div>
  );
}

function AgendaWidget({ members, days }: { members: MemberDTO[]; days: number }) {
  const start = useMemo(() => startOfDay(new Date()), []);
  const end = useMemo(() => addDays(start, days), [start, days]);
  const events = useEvents(start, end).data ?? [];
  const byDay = Array.from({ length: days }, (_, i) => addDays(start, i)).map((d) => ({ d, items: events.filter((e) => isSameDay(new Date(e.startAt), d) || (e.allDay && new Date(e.startAt) <= d && new Date(e.endAt) > d)) }));
  return (
    <Card className="h-full">
      <CardHeader><CardTitle><CalendarDays className="h-5 w-5 text-primary" /> Coming up</CardTitle><Link to="/calendar" className="text-sm text-primary">Calendar →</Link></CardHeader>
      <CardContent className="space-y-4">
        {byDay.map(({ d, items }) => (
          <div key={d.toISOString()}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{isSameDay(d, new Date()) ? 'Today' : isSameDay(d, addDays(new Date(), 1)) ? 'Tomorrow' : format(d, 'EEEE d MMM')}</p>
            {items.length === 0 ? <p className="px-2 py-1 text-sm text-muted-foreground">Nothing scheduled</p> : items.map((e) => <EventRow key={e.id} e={e} members={members} />)}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ChoresWidget({ members }: { members: MemberDTO[] }) {
  const chores = useTasks('CHORE').data ?? [];
  const points = usePoints().data ?? [];
  const kids = members.filter((m) => chores.some((c) => c.memberIds.includes(m.id)));
  if (!kids.length) return null;
  return (
    <Card className="h-full">
      <CardHeader><CardTitle><Sparkles className="h-5 w-5 text-amber-500" /> Today’s chores</CardTitle><Link to="/chores" className="text-sm text-primary">All →</Link></CardHeader>
      <CardContent className={cn('grid gap-5', kids.length > 1 && 'sm:grid-cols-2')}>
        {kids.map((m) => <MemberChoreColumn key={m.id} member={m} tasks={chores} points={points.find((p) => p.memberId === m.id)?.available} compact />)}
      </CardContent>
    </Card>
  );
}

function AnnouncementsWidget() {
  const items = useAnnouncements().data ?? [];
  if (!items.length) return null;
  return (
    <Card className="h-full">
      <CardHeader><CardTitle><Megaphone className="h-5 w-5 text-pink-500" /> Notes</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {items.slice(0, 4).map((a) => (
          <div key={a.id} className={cn('rounded-xl p-3', a.priority === 'URGENT' ? 'bg-destructive/10' : a.priority === 'IMPORTANT' ? 'bg-amber-500/10' : 'bg-muted/60')}>
            <p className="font-medium">{a.title}</p>{a.body && <p className="text-sm text-muted-foreground">{a.body}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ListsWidget() {
  const lists = useLists().data ?? [];
  const grocery = lists.find((l) => l.type === 'GROCERY') ?? lists[0];
  const list = useList(grocery?.id).data;
  if (!grocery) return null;
  const open = (list?.items ?? []).filter((i) => !i.isDone && !i.deleted);
  return (
    <Card className="h-full">
      <CardHeader><CardTitle><ShoppingCart className="h-5 w-5 text-emerald-500" /> {grocery.name}</CardTitle><Link to={`/lists/${grocery.id}`} className="text-sm text-primary">Open →</Link></CardHeader>
      <CardContent>
        {open.length === 0 ? <p className="text-sm text-muted-foreground">All done!</p> : (
          <div className="flex flex-wrap gap-2">{open.slice(0, 14).map((i) => <Badge key={i.id} tone="muted" className="px-3 py-1 text-sm">{i.name}{i.quantity ? ` · ${i.quantity}` : ''}</Badge>)}{open.length > 14 && <Badge>+{open.length - 14} more</Badge>}</div>
        )}
      </CardContent>
    </Card>
  );
}

function BirthdaysWidget({ members }: { members: MemberDTO[] }) {
  const upcoming = members
    .filter((m) => m.birthDate)
    .map((m) => { const b = new Date(m.birthDate!); const now = new Date(); let next = new Date(now.getFullYear(), b.getUTCMonth(), b.getUTCDate()); if (next < startOfDay(now)) next = new Date(now.getFullYear() + 1, b.getUTCMonth(), b.getUTCDate()); return { m, next, age: next.getFullYear() - b.getUTCFullYear() }; })
    .sort((a, b) => a.next.getTime() - b.next.getTime())
    .slice(0, 3);
  if (!upcoming.length) return null;
  return (
    <Card className="h-full"><CardHeader><CardTitle>🎂 Birthdays</CardTitle></CardHeader><CardContent className="space-y-2">
      {upcoming.map(({ m, next, age }) => <div key={m.id} className="flex items-center gap-3"><Avatar name={m.displayName} color={m.color} size={30} /><p className="flex-1 text-sm"><b>{m.displayName}</b> turns {age}</p><span className="text-sm text-muted-foreground">{format(next, 'd MMM')}</span></div>)}
    </CardContent></Card>
  );
}

const SPAN: Record<Widget['size'], string> = { sm: 'lg:col-span-1', md: 'lg:col-span-1', lg: 'lg:col-span-2' };

export default function DashboardPage() {
  const members = (useMembers().data ?? []).filter((m) => m.isActive);
  const layout = useActiveLayout().data;
  const widgets = (layout?.widgets ?? [{ id: 'a', type: 'agenda', visible: true, size: 'lg', config: {} }, { id: 'c', type: 'chores', visible: true, size: 'md', config: {} }]).filter((w) => w.visible);
  const render = (w: Widget) => {
    switch (w.type) {
      case 'agenda': case 'calendar': return <AgendaWidget members={members} days={Number(w.config.days ?? 3)} />;
      case 'chores': case 'tasks': return <ChoresWidget members={members} />;
      case 'announcements': return <AnnouncementsWidget />;
      case 'lists': return <ListsWidget />;
      case 'birthdays': return <BirthdaysWidget members={members} />;
      default: return null;
    }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Clock />
        <div className="flex -space-x-2">{members.map((m) => <Avatar key={m.id} name={m.displayName} color={m.color} size={44} />)}</div>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        {widgets.filter((w) => w.type !== 'clock' && w.type !== 'weather').map((w) => { const el = render(w); return el ? <div key={w.id} className={SPAN[w.size]}>{el}</div> : null; })}
      </div>
    </div>
  );
}
