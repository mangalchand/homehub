import { Check, Clock, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { MemberDTO } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { useHhMutation, type Task } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/misc';

export function useCompleteChore() {
  return useHhMutation<{ taskId: string; memberId: string; title: string }, { needsApproval: boolean; pointsAwarded: number; queued?: boolean }>(
    (hid, v) => api(hh(hid, `/tasks/${v.taskId}/complete`), { method: 'POST', body: { memberId: v.memberId }, offlineQueue: true }),
    [['tasks'], ['points'], ['approvals']],
  );
}
export function useUndoCompletion() {
  return useHhMutation<string>((hid, id) => api(hh(hid, `/completions/${id}`), { method: 'DELETE' }), [['tasks'], ['points']]);
}

/** Large, touch-friendly chore tile used on the dashboard and the chores page. */
export function ChoreTile({ task, member, compact }: { task: Task; member: MemberDTO; compact?: boolean }) {
  const complete = useCompleteChore();
  const undo = useUndoCompletion();
  const mine = task.completions.find((c) => c.memberId === member.id);
  const done = Boolean(mine);
  const pending = mine?.status === 'PENDING_APPROVAL';
  const onClick = () => {
    if (mine) {
      undo.mutate(mine.id, { onError: (e) => toast.error((e as Error).message) });
      return;
    }
    complete.mutate(
      { taskId: task.id, memberId: member.id, title: task.title },
      {
        onSuccess: (r) => {
          if (r?.queued) toast.info('Saved offline — will sync when connected');
          else if (r.needsApproval) toast.success(`Nice, ${member.displayName}! Waiting for a parent to approve.`);
          else toast.success(task.points ? `+${task.points} points for ${member.displayName}! 🎉` : `Done, ${member.displayName}!`);
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  };
  return (
    <button
      onClick={onClick}
      disabled={complete.isPending || undo.isPending}
      aria-pressed={done}
      className={cn(
        'group flex w-full items-center gap-3 rounded-2xl border bg-card text-left transition-all hover:shadow-md active:scale-[0.99]',
        compact ? 'p-2.5' : 'p-3.5',
        done && 'border-transparent bg-emerald-500/10',
      )}
    >
      <span
        className={cn('flex shrink-0 items-center justify-center rounded-full border-2 transition-colors', compact ? 'h-8 w-8' : 'h-10 w-10', done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-muted-foreground/30')}
        style={!done ? { borderColor: member.color } : undefined}
      >
        {pending ? <Clock className="h-4 w-4" /> : done ? <Check className="h-5 w-5" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block font-medium leading-snug', done && 'text-muted-foreground line-through')}>{task.title}</span>
        {pending && <span className="text-xs text-amber-600">Waiting for approval</span>}
      </span>
      {task.points > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
          <Sparkles className="h-3 w-3" />
          {task.points}
        </span>
      )}
    </button>
  );
}

export function MemberChoreColumn({ member, tasks, points, compact }: { member: MemberDTO; tasks: Task[]; points?: number; compact?: boolean }) {
  const mine = tasks.filter((t) => t.dueOnDate && (t.currentAssigneeIds.length ? t.currentAssigneeIds.includes(member.id) : true));
  const doneCount = mine.filter((t) => t.completions.some((c) => c.memberId === member.id)).length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Avatar name={member.displayName} color={member.color} size={compact ? 32 : 40} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{member.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {doneCount}/{mine.length} done{points !== undefined ? ` · ${points} pts` : ''}
          </p>
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full transition-all" style={{ width: `${mine.length ? (doneCount / mine.length) * 100 : 0}%`, background: member.color }} />
      </div>
      {mine.length === 0 ? <p className="py-2 text-sm text-muted-foreground">No chores today 🎈</p> : mine.map((t) => <ChoreTile key={t.id} task={t} member={member} compact={compact} />)}
    </div>
  );
}
