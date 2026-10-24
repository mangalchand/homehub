import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { CalendarDTO, EventOccurrenceDTO, MemberDTO } from '@familyhub/shared';
import { api, hh } from './api';
import { useUi } from '@/store/ui';

export interface Membership { householdId: string; householdName: string; memberId: string | null; role: string; color?: string }
export interface Me {
  kind: 'user' | 'device';
  user?: { id: string; email: string; displayName: string; hasPassword: boolean };
  device?: { id: string; name: string; householdId: string };
  memberships: Membership[];
  session: { id: string; pinElevatedUntil: string | null };
  preferences?: Record<string, unknown>;
}
export interface Household { id: string; name: string; timezone: string; locale: string; weekStartsOn: number; settings: Record<string, unknown>; hasPin: boolean }
export interface Task {
  id: string; kind: 'TASK' | 'CHORE'; title: string; description: string | null; category: string | null; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  dueAt: string | null; rrule: string | null; points: number; requiresApproval: boolean; rotate: boolean; icon: string | null;
  checklist: { id: string; title: string; done: boolean }[]; status: string; memberIds: string[]; currentAssigneeIds: string[];
  occurrenceKey: string; dueOnDate: boolean; isOverdue: boolean;
  completions: { id: string; memberId: string; status: 'APPROVED' | 'PENDING_APPROVAL' | 'REJECTED'; completedAt: string; pointsAwarded: number }[];
}
export interface Points { memberId: string; balance: number; pending: number; available: number }
export interface Reward { id: string; title: string; description: string | null; icon: string | null; cost: number; isActive: boolean }
export interface ListSummary { id: string; name: string; type: string; icon: string | null; color: string | null; isTemplate: boolean; openCount: number; doneCount: number }
export interface ListItem {
  id: string; listId: string; name: string; quantity: string | null; unit: string | null; category: string | null; notes: string | null;
  isDone: boolean; doneByMemberId: string | null; sortOrder: number; version: number; updatedAt: string; deleted?: boolean; pending?: boolean;
}
export interface Announcement { id: string; title: string; body: string | null; priority: 'NORMAL' | 'IMPORTANT' | 'URGENT'; pinned: boolean; color: string | null; expiresAt: string | null; createdAt: string }
export interface Widget { id: string; type: string; visible: boolean; size: 'sm' | 'md' | 'lg'; config: Record<string, unknown> }
export interface Layout { id: string; name: string; preset: string; widgets: Widget[]; isDefault: boolean; deviceId: string | null }
export interface Approvals {
  chores: { id: string; taskId: string; title: string; icon: string | null; memberId: string; points: number; completedAt: string }[];
  redemptions: { id: string; rewardId: string | null; title: string; icon: string | null; memberId: string; points: number; createdAt: string }[];
}

export const useHid = () => useUi((s) => s.householdId);

export const useMe = () =>
  useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me'), staleTime: 60_000, retry: false, networkMode: 'offlineFirst' });

function useHh<T>(key: QueryKey, path: string, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  const hid = useHid();
  return useQuery({ queryKey: [...(key as unknown[]), hid], queryFn: () => api<T>(hh(hid!, path)), enabled: Boolean(hid) && (opts.enabled ?? true), refetchInterval: opts.refetchInterval });
}

export const useHousehold = () => useHh<Household>(['household'], '');
export const useMembers = () => useHh<MemberDTO[]>(['members'], '/members');
export const useCalendars = () => useHh<CalendarDTO[]>(['calendars'], '/calendars');
export const useEvents = (start: Date, end: Date) => {
  const hid = useHid();
  return useQuery({
    queryKey: ['events', hid, start.toISOString(), end.toISOString()],
    queryFn: () => api<EventOccurrenceDTO[]>(hh(hid!, `/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`)),
    enabled: Boolean(hid),
    placeholderData: (prev) => prev,
  });
};
export const useTasks = (kind?: 'TASK' | 'CHORE', date?: string) =>
  useHh<Task[]>(['tasks', kind ?? 'all', date ?? 'today'], `/tasks?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(date ? { date } : {}) })}`);
export const usePoints = () => useHh<Points[]>(['points'], '/points');
export const useRewards = () => useHh<Reward[]>(['rewards'], '/rewards');
export const useApprovals = (enabled: boolean) => useHh<Approvals>(['approvals'], '/approvals', { enabled });
export const useLists = () => useHh<ListSummary[]>(['lists'], '/lists');
export const useList = (listId: string | undefined) =>
  useHh<ListSummary & { items: ListItem[] }>(['lists', listId], `/lists/${listId}`, { enabled: Boolean(listId) });
export const useAnnouncements = () => useHh<Announcement[]>(['announcements'], '/announcements');
export const useActiveLayout = () => useHh<Layout>(['dashboard', 'active'], '/dashboard-layouts/active');
export const useLayouts = () => useHh<Layout[]>(['dashboard', 'all'], '/dashboard-layouts');

/** Generic household mutation that invalidates the given query prefixes on success. */
export function useHhMutation<TVars, TData = unknown>(fn: (hid: string, vars: TVars) => Promise<TData>, invalidate: QueryKey[]) {
  const hid = useHid();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => fn(hid!, vars),
    onSettled: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k }))),
  });
}

/** Capability helper mirroring the backend (the backend remains the authority). */
export function useRole() {
  const me = useMe().data;
  const hid = useHid();
  const m = me?.memberships.find((x) => x.householdId === hid);
  const role = m?.role ?? 'GUEST';
  const isDevice = me?.kind === 'device';
  const elevated = Boolean(me?.session.pinElevatedUntil && new Date(me.session.pinElevatedUntil) > new Date());
  const adult = ['OWNER', 'ADULT_ADMIN', 'ADULT'].includes(role) || (isDevice && elevated);
  return {
    role, memberId: m?.memberId ?? null, isDevice, elevated,
    isAdult: adult,
    isAdmin: ['OWNER', 'ADULT_ADMIN'].includes(role) || (isDevice && elevated),
    canWriteEvents: adult,
  };
}
