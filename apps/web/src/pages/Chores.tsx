import { useState } from 'react';
import { CheckSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { api, hh } from '@/lib/api';
import { useHhMutation, useHid, useMembers, usePoints, useRole, useTasks, type Task } from '@/lib/queries';
import { MemberChoreColumn } from '@/features/chores';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { RecordImages } from '@/components/RecordImages';
import { Avatar, Badge, EmptyState, PageHeader, Switch } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

const REPEAT: Record<string, string> = {
  '': 'Does not repeat',
  'FREQ=DAILY': 'Every day',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR': 'Weekdays (Mon–Fri)',
  'FREQ=WEEKLY;BYDAY=SA,SU': 'Weekends (Sat–Sun)',
  'FREQ=WEEKLY': 'Every week (same day)',
  WEEKLY_DAYS: 'Weekly on chosen days',
  MONTHLY: 'Monthly on a date',
};
const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const BYDAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Maps a stored RRULE to the selector value plus its chosen weekdays / month date. */
function parseRepeat(rrule: string | null | undefined) {
  const rule = (rrule ?? '').replace(/^RRULE:/, '');
  if (rule in REPEAT) return { mode: rule, days: [] as string[], monthDay: 1 };
  const byday = /FREQ=WEEKLY;BYDAY=([A-Z,]+)/.exec(rule);
  if (byday) return { mode: 'WEEKLY_DAYS', days: byday[1]!.split(','), monthDay: 1 };
  const monthly = /FREQ=MONTHLY;BYMONTHDAY=(\d+)/.exec(rule);
  if (monthly) return { mode: 'MONTHLY', days: [], monthDay: Number(monthly[1]) };
  return { mode: rule ? 'FREQ=DAILY' : '', days: [], monthDay: 1 };
}
export function buildRrule(mode: string, days: string[], monthDay: number) {
  if (mode === 'WEEKLY_DAYS') return `FREQ=WEEKLY;BYDAY=${BYDAY.filter((d) => days.includes(d)).join(',') || BYDAY[0]}`;
  if (mode === 'MONTHLY') return `FREQ=MONTHLY;BYMONTHDAY=${Math.min(31, Math.max(1, monthDay))}`;
  return mode;
}

function TaskDialog({
  open,
  onOpenChange,
  kind,
  task,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: 'TASK' | 'CHORE';
  task?: Task;
}) {
  const members = useMembers().data ?? [];
  const { isAdult } = useRole();
  const [saved, setSaved] = useState<Task | null>(task ?? null);
  const localDue = task?.dueAt ? format(new Date(task.dueAt), "yyyy-MM-dd'T'HH:mm") : '';
  const [f, setF] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    points: task?.points ?? 10,
    ...parseRepeat(task ? task.rrule : kind === 'CHORE' ? 'FREQ=DAILY' : ''),
    timesPerDay: task?.timesPerDay ?? 1,
    memberIds: task?.memberIds ?? ([] as string[]),
    requiresApproval: task?.requiresApproval ?? false,
    rotate: task?.rotate ?? false,
    dueAt: localDue,
    priority: task?.priority ?? 'MEDIUM',
  });
  const create = useHhMutation<void, Task>(
    (hid) =>
      api<Task>(hh(hid, saved ? `/tasks/${saved.id}` : '/tasks'), {
        method: saved ? 'PATCH' : 'POST',
        body: {
          kind,
          title: f.title,
          description: f.description,
          memberIds: f.memberIds,
          priority: f.priority,
          points: kind === 'CHORE' ? f.points : (saved?.points ?? 0),
          rrule: buildRrule(f.mode, f.days, f.monthDay) || null,
          timesPerDay: f.timesPerDay,
          requiresApproval: kind === 'CHORE' ? f.requiresApproval : (saved?.requiresApproval ?? false),
          rotate: kind === 'CHORE' ? f.rotate : (saved?.rotate ?? false),
          dueAt:
            kind === 'CHORE'
              ? saved
                ? saved.dueAt
                : new Date().toISOString()
              : f.mode && !f.dueAt && !task
                ? new Date().toISOString()
              : task && f.dueAt === localDue
                ? task.dueAt
                : f.dueAt
                  ? new Date(f.dueAt).toISOString()
                  : null,
        },
      }),
    [['tasks']],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${saved ? 'Edit' : 'New'} ${kind === 'CHORE' ? 'chore' : 'task'}`}
      description="Save first, then attach up to five images."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined, {
            onSuccess: (value) => {
              toast.success('Saved — you can now attach images');
              setSaved(value);
            },
            onError: (er) => toast.error((er as Error).message),
          });
        }}
      >
        <Field label="Title">
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required autoFocus />
        </Field>
        <Field label="Description">
          <Textarea
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            maxLength={2000}
          />
        </Field>
        <Field label="Assign to">
          <div className="flex flex-wrap gap-2">
            {members.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setF({
                    ...f,
                    memberIds: f.memberIds.length === members.length ? [] : members.map((m) => m.id),
                  })
                }
                className={cn(
                  'rounded-full border px-3 py-1 text-sm',
                  f.memberIds.length === members.length ? 'border-primary bg-primary/10' : 'opacity-70',
                )}
              >
                Everyone
              </button>
            )}
            {members.map((m) => {
              const on = f.memberIds.includes(m.id);
              return (
                <button
                  type="button"
                  key={m.id}
                  onClick={() =>
                    setF({
                      ...f,
                      memberIds: on ? f.memberIds.filter((x) => x !== m.id) : [...f.memberIds, m.id],
                    })
                  }
                  className={cn(
                    'flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm',
                    on ? 'border-primary bg-primary/10' : 'opacity-70',
                  )}
                >
                  <Avatar name={m.displayName} color={m.color} src={m.avatarUrl} size={24} /> {m.displayName}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repeats">
            <Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value, days: f.days.length ? f.days : [BYDAY[(new Date().getDay() + 6) % 7]!], monthDay: f.monthDay || new Date().getDate() })}>
              {Object.entries(REPEAT).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {f.mode && (
            <Field label="Times per day">
              <Select value={f.timesPerDay} onChange={(e) => setF({ ...f, timesPerDay: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Once a day' : `${n} times a day`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {f.mode === 'WEEKLY_DAYS' && (
          <div role="group" aria-label="Repeat on days" className="flex flex-wrap gap-2">
            {BYDAY.map((d, i) => {
              const on = f.days.includes(d);
              return (
                <button key={d} type="button" aria-pressed={on} disabled={on && f.days.length === 1} onClick={() => setF({ ...f, days: on ? f.days.filter((x) => x !== d) : [...f.days, d] })} className={cn('min-w-12 rounded-full border px-3 py-1.5 text-sm', on ? 'border-primary bg-primary/10 font-semibold' : 'opacity-70')}>
                  {BYDAY_LABEL[i]}
                </button>
              );
            })}
          </div>
        )}
        {f.mode === 'MONTHLY' && (
          <Field label="Day of month">
            <Input type="number" min={1} max={31} value={f.monthDay} onChange={(e) => setF({ ...f, monthDay: Number(e.target.value) })} />
          </Field>
        )}
        {kind === 'CHORE' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Points">
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  value={f.points}
                  onChange={(e) => setF({ ...f, points: Number(e.target.value) })}
                />
              </Field>
            </div>
            <label className="flex items-center justify-between gap-2 text-sm">
              Needs parent approval{' '}
              <Switch
                checked={f.requiresApproval}
                onCheckedChange={(v) => setF({ ...f, requiresApproval: v })}
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm">
              Rotate between assignees{' '}
              <Switch checked={f.rotate} onCheckedChange={(v) => setF({ ...f, rotate: v })} />
            </label>
            {f.memberIds.length > 1 && (
              <p className="text-xs text-muted-foreground">
                {f.rotate
                  ? 'Takes turns: one person each time it repeats.'
                  : `Each of the ${f.memberIds.length} people does this chore and earns the points separately.`}
              </p>
            )}
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due">
              <Input
                type="datetime-local"
                value={f.dueAt}
                onChange={(e) => setF({ ...f, dueAt: e.target.value })}
              />
            </Field>
            <Field label="Priority">
              <Select
                value={f.priority}
                onChange={(e) => setF({ ...f, priority: e.target.value as Task['priority'] })}
              >
                {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Button type="submit" className="w-full" disabled={create.isPending || Boolean(saved && !isAdult)}>
          Save
        </Button>
      </form>
      {saved ? (
        <RecordImages parentType="tasks" parentId={saved.id} />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Image controls appear after saving.</p>
      )}
      {saved && kind === 'CHORE' && !task && (
        <Button
          type="button"
          className="mt-3 w-full"
          variant="outline"
          onClick={() => {
            setSaved(null);
            setF({
              title: '',
              description: '',
              points: 10,
              mode: 'FREQ=DAILY',
              days: [],
              monthDay: 1,
              timesPerDay: 1,
              memberIds: [],
              requiresApproval: false,
              rotate: false,
              dueAt: '',
              priority: 'MEDIUM',
            });
          }}
        >
          Add another chore
        </Button>
      )}
      <Button type="button" className="mt-4 w-full" variant="outline" onClick={() => onOpenChange(false)}>
        Done
      </Button>
    </Dialog>
  );
}

function TaskRow({ t, canManage, onEdit }: { t: Task; canManage: boolean; onEdit: () => void }) {
  const members = useMembers().data ?? [];
  const toggle = useHhMutation<void>(
    (hid) =>
      api(hh(hid, `/tasks/${t.id}`), {
        method: 'PATCH',
        body: { status: t.status === 'DONE' ? 'OPEN' : 'DONE' },
      }),
    [['tasks']],
  );
  const del = useHhMutation<void>((hid) => api(hh(hid, `/tasks/${t.id}`), { method: 'DELETE' }), [['tasks']]);
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-3">
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
        checked={t.status === 'DONE'}
        disabled={!canManage}
        onChange={() => toggle.mutate()}
        aria-label={`Complete ${t.title}`}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'font-medium leading-snug',
            t.status === 'DONE' && 'text-muted-foreground line-through',
          )}
        >
          {t.title}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-muted-foreground">
            {t.dueAt ? `Due ${format(new Date(t.dueAt), 'EEE d MMM, p')}` : 'No due date'}
          </span>
          {t.isOverdue && <Badge tone="danger">Overdue</Badge>}
          {t.priority === 'HIGH' || t.priority === 'URGENT' ? (
            <Badge tone="warning">{t.priority[0] + t.priority.slice(1).toLowerCase()}</Badge>
          ) : null}
          <span className="flex -space-x-1.5">
            {t.memberIds.map((id) => {
              const m = members.find((x) => x.id === id);
              return m ? <Avatar key={id} name={m.displayName} color={m.color} src={m.avatarUrl} size={22} /> : null;
            })}
          </span>
        </div>
        <RecordImages parentType="tasks" parentId={t.id} />
      </div>
      {canManage && (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label={`Edit ${t.title}`}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      )}
      {canManage && (
        <Button
          variant="ghost"
          size="icon"
          className="-my-1.5 -mr-1.5 shrink-0 text-muted-foreground"
          aria-label="Delete"
          onClick={() => del.mutate()}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

export default function ChoresPage() {
  const hid = useHid();
  return <HouseholdChores key={hid} />;
}

function HouseholdChores() {
  const members = (useMembers().data ?? []).filter((m) => m.isActive);
  const chores = useTasks('CHORE').data ?? [];
  const tasks = useTasks('TASK').data ?? [];
  const points = usePoints().data ?? [];
  const { isAdult, isDevice } = useRole();
  const [dialog, setDialog] = useState<'TASK' | 'CHORE' | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const kids = members.filter((m) =>
    chores.some((c) => c.memberIds.includes(m.id) || c.memberIds.length === 0),
  );
  return (
    <div>
      <PageHeader
        title="Chores & tasks"
        subtitle={format(new Date(), 'EEEE, d MMMM')}
        actions={
          (isAdult || isDevice) && (
            <>
              <Button variant="outline" onClick={() => setDialog('TASK')}>
                <Plus /> Task
              </Button>
              {isAdult && (
                <Button onClick={() => setDialog('CHORE')}>
                  <Plus /> Chore
                </Button>
              )}
            </>
          )
        }
      />
      {kids.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CheckSquare />}
            title="No chores yet"
            body="Create daily or weekly chores, assign them, and attach points kids can trade for rewards."
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 sm:gap-6 xl:grid-cols-3">
          {kids.map((m) => (
            <Card key={m.id}>
              <CardContent className="p-4">
                <MemberChoreColumn
                  member={m}
                  tasks={chores}
                  points={points.find((p) => p.memberId === m.id)?.balance}
                  onEdit={isAdult ? setEditing : undefined}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Card className="mt-6 sm:mt-8">
        <CardHeader>
          <CardTitle>Household tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing on the to-do list.</p>
          ) : (
            tasks.map((t) => <TaskRow key={t.id} t={t} canManage={isAdult} onEdit={() => setEditing(t)} />)
          )}
        </CardContent>
      </Card>
      {dialog && <TaskDialog open onOpenChange={(o) => !o && setDialog(null)} kind={dialog} />}
      {editing && (
        <TaskDialog
          key={editing.id}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          kind={editing.kind}
          task={editing}
        />
      )}
    </div>
  );
}
