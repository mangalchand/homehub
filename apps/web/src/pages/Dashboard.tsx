import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Cake, ListTodo, Megaphone, ShoppingCart, Sparkles } from 'lucide-react';
import { addDays, format, isSameDay, startOfDay } from 'date-fns';
import type { EventOccurrenceDTO, MemberDTO } from '@familyhub/shared';
import { useActiveLayout, useAnnouncements, useEvents, useHousehold, useList, useLists, useMembers, usePoints, useTasks, type Widget } from '@/lib/queries';
import { zoned } from '@/lib/time';

import { MemberChoreColumn } from '@/features/chores';
import { Card, CardContent, CardHeader, CardTitle, IconTile } from '@/components/ui/card';
import { PhotoSlideshow } from '@/features/photos';
import { Avatar, Badge } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

const useTz = () => useHousehold().data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function Clock() {
  const tz = useTz();
  const [real, setNow] = useState(new Date());
  const now = zoned(real, tz);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(t); }, []);
  return (
    <div className="text-white drop-shadow-md">
      <p className="font-display text-5xl font-extrabold tabular-nums tracking-tight sm:text-6xl md:text-7xl">{format(now, 'h:mm')}<span className="ml-2 text-2xl font-semibold text-white/80">{format(now, 'a')}</span></p>
      <p className="mt-1 text-lg font-medium text-white/85">{format(now, 'EEEE, d MMMM')}</p>
    </div>
  );
}

function EventRow({ e, members, tz }: { e: EventOccurrenceDTO; members: MemberDTO[]; tz: string }) {
  const past = new Date(e.endAt) < new Date();
  return (
    <div className={cn('flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-muted/60', past && 'opacity-50')}>
      <span className="h-10 w-1.5 shrink-0 rounded-full" style={{ background: e.color }} />
      <div className="w-[4.5rem] shrink-0 whitespace-nowrap text-[13px] font-semibold tabular-nums text-muted-foreground">{e.allDay ? 'All day' : format(zoned(e.startAt, tz), 'h:mm a')}</div>
      <div className="min-w-0 flex-1"><p className={cn('line-clamp-2 font-medium leading-snug', e.busyOnly && 'italic text-muted-foreground')}>{e.title}</p>{e.location && <p className="line-clamp-1 text-xs text-muted-foreground">{e.location}</p>}</div>
      <div className="flex -space-x-1.5">{e.memberIds.slice(0, 4).map((id) => { const m = members.find((x) => x.id === id); return m ? <Avatar key={id} name={m.displayName} color={m.color} size={24} /> : null; })}</div>
    </div>
  );
}

function AgendaWidget({ members, days }: { members: MemberDTO[]; days: number }) {
  const tz = useTz();
  const today = useMemo(() => startOfDay(zoned(new Date(), tz)), [tz]);
  const [qs, qe] = useMemo(() => [new Date(Date.now() - 86400000), new Date(Date.now() + (days + 1) * 86400000)], [days]);
  const events = useEvents(qs, qe).data ?? [];
  const dayOf = (e: EventOccurrenceDTO, iso: string) => (e.allDay ? new Date(iso.slice(0, 10) + 'T00:00') : zoned(iso, tz));
  const byDay = Array.from({ length: days }, (_, i) => addDays(today, i)).map((d) => ({
    d,
    items: events.filter((e) => (e.allDay ? dayOf(e, e.startAt) <= d && dayOf(e, e.endAt) > d : isSameDay(dayOf(e, e.startAt), d))),
  }));
  return (
    <Card className="h-full">
      <CardHeader><CardTitle><IconTile className="bg-violet-500/12 bg-violet-500/10 text-violet-600 dark:text-violet-300"><CalendarDays /></IconTile> Coming up</CardTitle><Link to="/calendar" className="rounded-full px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10">Calendar →</Link></CardHeader>
      <CardContent className="space-y-4">
        {byDay.map(({ d, items }) => (
          <div key={d.toISOString()}>
            <p className="mb-1 px-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{isSameDay(d, today) ? 'Today' : isSameDay(d, addDays(today, 1)) ? 'Tomorrow' : format(d, 'EEEE d MMM')}</p>
            {items.length === 0 ? <p className="px-2 py-1 text-sm text-muted-foreground">Nothing scheduled</p> : items.map((e) => <EventRow key={e.id} e={e} members={members} tz={tz} />)}
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
      <CardHeader><CardTitle><IconTile className="bg-amber-500/10 text-amber-600 dark:text-amber-300"><Sparkles /></IconTile> Today’s chores</CardTitle><Link to="/chores" className="rounded-full px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10">All →</Link></CardHeader>
      <CardContent className="grid gap-5">
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
      <CardHeader><CardTitle><IconTile className="bg-pink-500/10 text-pink-600 dark:text-pink-300"><Megaphone /></IconTile> Notes</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {items.slice(0, 4).map((a) => (
          <div key={a.id} className={cn('rounded-xl p-3', a.priority === 'URGENT' ? 'bg-destructive/10' : a.priority === 'IMPORTANT' ? 'bg-amber-500/10' : 'bg-muted/60')}>
            <p className="font-semibold leading-snug">{a.title}</p>{a.body && <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{a.body}</p>}
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
      <CardHeader><CardTitle><IconTile className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"><ShoppingCart /></IconTile> {grocery.name}</CardTitle><Link to={`/lists/${grocery.id}`} className="rounded-full px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10">Open →</Link></CardHeader>
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
    <Card className="h-full"><CardHeader><CardTitle><IconTile className="bg-rose-500/10 text-rose-600 dark:text-rose-300"><Cake /></IconTile> Birthdays</CardTitle></CardHeader><CardContent className="space-y-2">
      {upcoming.map(({ m, next, age }) => <div key={m.id} className="flex items-center gap-3"><Avatar name={m.displayName} color={m.color} size={30} /><p className="min-w-0 flex-1 text-sm"><b className="font-semibold">{m.displayName}</b> turns {age}</p><span className="text-sm text-muted-foreground">{format(next, 'd MMM')}</span></div>)}
    </CardContent></Card>
  );
}

function TasksWidget() {
  const tasks = (useTasks('TASK').data ?? []).filter((t) => t.status !== 'DONE');
  if (!tasks.length) return null;
  return (
    <Card className="h-full">
      <CardHeader><CardTitle><IconTile className="bg-sky-500/10 text-sky-600 dark:text-sky-300"><ListTodo /></IconTile> To do</CardTitle><Link to="/chores" className="rounded-full px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10">All →</Link></CardHeader>
      <CardContent className="space-y-2">
        {tasks.slice(0, 5).map((t) => (
          <div key={t.id} className="flex items-start justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1 font-medium leading-snug">{t.title}</span>
            {t.isOverdue ? <Badge tone="danger">Overdue</Badge> : t.dueAt ? <span className="text-xs text-muted-foreground">{format(new Date(t.dueAt), 'EEE d MMM')}</span> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function UpNextOverlay({ members }: { members: MemberDTO[] }) {
  const tz = useTz();
  const [qs, qe] = useMemo(() => [new Date(), new Date(Date.now() + 14 * 86400000)], []);
  const events = (useEvents(qs, qe).data ?? []).filter((e) => new Date(e.endAt) > new Date()).slice(0, 5);
  const today = startOfDay(zoned(new Date(), tz));
  return (
    <Link to="/calendar" className="block w-full rounded-2xl border border-white/20 bg-slate-950/40 p-4 text-white shadow-lift backdrop-blur-xl md:w-[22rem]">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/80"><CalendarDays className="h-4 w-4" /> Up next</p>
      {events.length === 0 ? <p className="py-2 text-sm text-white/80">Nothing in the next two weeks</p> : (
        <ul className="space-y-1.5">
          {events.map((e) => {
            const start = e.allDay ? new Date(e.startAt.slice(0, 10) + 'T00:00') : zoned(e.startAt, tz);
            const day = isSameDay(start, today) ? 'Today' : isSameDay(start, addDays(today, 1)) ? 'Tomorrow' : format(start, 'EEE d');
            return (
              <li key={e.id} className="flex items-center gap-2.5">
                <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: e.color }} />
                <div className="min-w-0 flex-1">
                  <p className={cn('line-clamp-2 text-sm font-semibold leading-snug', e.busyOnly && 'italic text-white/80')}>{e.title}</p>
                  <p className="text-[11px] text-white/75">{day} · {e.allDay ? 'All day' : format(start, 'h:mm a')}</p>
                </div>
                <div className="flex -space-x-1">{e.memberIds.slice(0, 3).map((id) => { const m = members.find((x) => x.id === id); return m ? <Avatar key={id} name={m.displayName} color={m.color} size={20} className="ring-1 ring-black/30" /> : null; })}</div>
              </li>
            );
          })}
        </ul>
      )}
    </Link>
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
      case 'chores': return <ChoresWidget members={members} />;
      case 'tasks': return <TasksWidget />;
      case 'announcements': return <AnnouncementsWidget />;
      case 'lists': return <ListsWidget />;
      case 'birthdays': return <BirthdaysWidget members={members} />;
      default: return null;
    }
  };
  return (
    <div className="space-y-5">
      <PhotoSlideshow className="min-h-[22rem] rounded-2xl shadow-lift sm:rounded-3xl md:h-[26rem]">
        <div className="flex h-full min-h-[22rem] flex-col justify-between gap-4 p-5 md:h-[26rem] md:flex-row md:items-end md:p-8">
          <div className="flex flex-col justify-end gap-4 md:h-full">
            <Clock />
            <div className="flex -space-x-2.5">{members.map((m) => <Avatar key={m.id} name={m.displayName} color={m.color} size={40} className="ring-[3px] ring-white/80" />)}</div>
          </div>
          <UpNextOverlay members={members} />
        </div>
      </PhotoSlideshow>
      <div className="grid gap-5 lg:grid-cols-3">
        {widgets.filter((w) => w.type !== 'clock' && w.type !== 'weather').map((w) => { const el = render(w); return el ? <div key={w.id} className={SPAN[w.size]}>{el}</div> : null; })}
      </div>
    </div>
  );
}
