import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Task } from '@/lib/queries';
import ChoresPage from './Chores';

const state = vi.hoisted(() => ({
  hid: 'home-a',
  isAdult: true,
  isDevice: false,
  tasks: [] as Task[],
  chores: [] as Task[],
}));
vi.mock('@/lib/queries', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useHid: () => state.hid,
    useRole: () => state,
    useMembers: () => ({
      data: [{ id: 'member-1', displayName: 'Parent', color: '#123456', isActive: true }],
    }),
    usePoints: () => ({ data: [] }),
    useTasks: (kind: string) => ({ data: kind === 'CHORE' ? state.chores : state.tasks }),
    useHhMutation: (fn: (hid: string, variables: unknown) => Promise<unknown>) =>
      useMutation({ mutationFn: (variables: unknown) => fn(state.hid, variables) }),
  };
});
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  hh: (hid: string, path: string) => `/api/v1/households/${hid}${path}`,
}));
vi.mock('@/components/RecordImages', () => ({
  RecordImages: ({ parentId }: { parentId: string }) => <p>Images for {parentId}</p>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const task = (patch: Partial<Task> = {}): Task => ({
  id: 'task-1',
  kind: 'TASK',
  title: 'Shop',
  description: 'Bring a bag',
  category: null,
  priority: 'MEDIUM',
  dueAt: '2026-01-01T10:15:30.000Z',
  rrule: null,
  points: 0,
  requiresApproval: false,
  rotate: false,
  icon: null,
  checklist: [],
  status: 'OPEN',
  memberIds: [],
  currentAssigneeIds: [],
  occurrenceKey: 'once',
  dueOnDate: true,
  isOverdue: false,
  completions: [],
  ...patch,
});
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ChoresPage />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.assign(state, { hid: 'home-a', isAdult: true, isDevice: false, tasks: [task()], chores: [] });
  vi.mocked(api).mockImplementation(async (_path, opts) => task(opts?.body as Partial<Task>));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('images on real task and chore cards/editors', () => {
  it('shows task images and edits text without changing an untouched due timestamp', async () => {
    view();
    expect(screen.getByText('Images for task-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Shop' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Bring a bag');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Use the photo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/households/home-a/tasks/task-1',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ description: 'Use the photo', dueAt: '2026-01-01T10:15:30.000Z' }),
        }),
      ),
    );
  });

  it('keeps a one-off chore nonrecurring and preserves its null date when editing images/text', async () => {
    state.tasks = [];
    state.chores = [task({ id: 'chore-1', kind: 'CHORE', title: 'Tidy', dueAt: null, points: 10 })];
    view();
    expect(screen.getByText('Images for chore-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tidy' }));
    expect(screen.getByLabelText('Repeats')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/households/home-a/tasks/chore-1',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ dueAt: null, rrule: null, points: 10 }),
        }),
      ),
    );
  });

  it('lets paired displays create only simple tasks and attaches images after save, without allowing task edits', async () => {
    state.isAdult = false;
    state.isDevice = true;
    state.tasks = [];
    view();
    expect(screen.queryByRole('button', { name: 'Chore' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Task' }));
    expect(screen.queryByText('Images for task-1')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Images for task-1');
    expect(api).toHaveBeenCalledWith(
      '/api/v1/households/home-a/tasks',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ kind: 'TASK', points: 0, rrule: null, requiresApproval: false }),
      }),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
