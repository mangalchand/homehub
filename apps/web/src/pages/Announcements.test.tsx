import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Announcement, Me } from '@/lib/queries';
import { api, ApiRequestError } from '@/lib/api';
import { listen, speak, stopListening } from '@/lib/voice/speech';
import AnnouncementsPage from './Announcements';

const { state } = vi.hoisted(() => ({
  state: {
    me: undefined as Me | undefined,
    hid: 'h',
    data: [] as Announcement[],
    failed: false,
    supported: true,
  },
}));
vi.mock('@/lib/queries', () => ({
  useMe: () => ({ data: state.me }),
  useHid: () => state.hid,
  useHousehold: () => ({ data: { timezone: 'UTC' } }),
  useAnnouncements: () => ({
    data: state.data,
    isPending: false,
    isError: state.failed,
    error: new Error('Offline'),
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('@/lib/voice/speech', () => ({
  listen: vi.fn(),
  speak: vi.fn().mockResolvedValue(undefined),
  stopSpeaking: vi.fn(),
  stopListening: vi.fn(),
  voiceSupported: () => state.supported,
  isSpeaking: () => false,
}));

const adult = (): Me => ({
  kind: 'user',
  user: {
    id: 'u',
    email: 'test@example.test',
    displayName: 'Parent',
    hasPassword: true,
    emailVerified: true,
  },
  memberships: [{ householdId: 'h', householdName: 'Home', memberId: 'm', role: 'ADULT' }],
  session: { id: 's', pinElevatedUntil: null },
});
const display = (elevated = false): Me => ({
  kind: 'device',
  device: { householdId: 'h', id: 'd', name: 'Kitchen' },
  memberships: [],
  session: { id: 's', pinElevatedUntil: elevated ? new Date(Date.now() + 60_000).toISOString() : null },
});
const message: Announcement = {
  id: 'a',
  title: 'Dinner ready',
  body: 'Come downstairs',
  priority: 'URGENT',
  pinned: true,
  color: null,
  expiresAt: null,
  repeatDaily: false,
  dailyTime: null,
  createdAt: new Date().toISOString(),
};
function view() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = () => (
    <QueryClientProvider client={client}>
      <AnnouncementsPage />
    </QueryClientProvider>
  );
  return { ...render(wrapper()), update: wrapper, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.me = adult();
  state.hid = 'h';
  state.data = [message];
  state.failed = false;
  state.supported = true;
  vi.mocked(api).mockResolvedValue({});
  vi.mocked(listen).mockResolvedValue('announce Dinner is ready');
});
afterEach(() => cleanup());

describe('announcements page', () => {
  it('shows active pinned/urgent messages and posts typed input through the existing API', async () => {
    view();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Urgent', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dictate announcement' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Announcement'), { target: { value: ' Dinner is ready ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post announcement' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/households/h/announcements', {
        method: 'POST',
        body: {
          title: 'Dinner is ready',
          body: '',
          priority: 'NORMAL',
          pinned: false,
          expiresAt: null,
          repeatDaily: false,
          dailyTime: null,
        },
      }),
    );
    expect(await screen.findByText('Announcement saved.')).toBeInTheDocument();
  });
  it('configures an announcement to repeat at a local daily time', async () => {
    view();
    fireEvent.change(screen.getByLabelText('Announcement'), { target: { value: 'Take medicine' } });
    fireEvent.click(screen.getByLabelText('Repeat every day'));
    fireEvent.change(screen.getByLabelText('Daily notification time (UTC)'), { target: { value: '08:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post announcement' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/households/h/announcements', {
        method: 'POST',
        body: expect.objectContaining({ title: 'Take medicine', repeatDaily: true, dailyTime: '08:15' }),
      }),
    );
  });
  it.each(['CHILD', 'GUEST'])('provides read access but no write or microphone controls for %s', (role) => {
    state.me!.memberships[0]!.role = role;
    view();
    expect(screen.queryByLabelText('Announcement')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read announcements aloud' })).toBeEnabled();
    expect(api).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
  it('requires PIN elevation on displays and still surfaces a backend permission rejection', async () => {
    state.me = display();
    const page = view();
    expect(screen.getByRole('button', { name: 'Post announcement' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    state.me = display(true);
    page.rerender(page.update());
    expect(screen.getByRole('button', { name: 'Post announcement' })).toBeEnabled();
    vi.mocked(api).mockRejectedValueOnce(new ApiRequestError(403, 'FORBIDDEN', 'Expired PIN'));
    fireEvent.change(screen.getByLabelText('Announcement'), { target: { value: 'Dinner ready' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post announcement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PIN');
    expect(screen.queryByText('Announcement saved.')).not.toBeInTheDocument();
  });
  it('uses one-shot device dictation as a reviewable draft, never an automatic post', async () => {
    state.me = display(true);
    view();
    expect(listen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dictate announcement' }));
    await waitFor(() => expect(screen.getByLabelText('Announcement')).toHaveValue('Dinner is ready'));
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Post announcement' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  });
  it('ignores cancelled dictation and clears drafts/speech when a home changes', async () => {
    state.me = display(true);
    let resolve!: (value: string) => void;
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const page = view();
    fireEvent.click(screen.getByRole('button', { name: 'Dictate announcement' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel microphone' }));
    await act(async () => resolve('Old home secret'));
    expect(screen.getByLabelText('Announcement')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Announcement'), { target: { value: 'Old draft' } });
    state.hid = 'other';
    page.rerender(page.update());
    expect(screen.queryByLabelText('Announcement')).not.toBeInTheDocument();
    expect(stopListening).toHaveBeenCalled();
    state.hid = 'h';
    page.rerender(page.update());
    expect(screen.getByLabelText('Announcement')).toHaveValue('');
  });
  it('offers an honest typed fallback for unavailable or denied speech', async () => {
    state.me = display();
    state.supported = false;
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Dictate announcement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
    expect(listen).not.toHaveBeenCalled();
    state.supported = true;
    vi.mocked(listen).mockRejectedValueOnce(new Error('Microphone permission denied.'));
    fireEvent.click(screen.getByRole('button', { name: 'Dictate announcement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Type your announcement instead.');
  });
  it('edits with PATCH and requires confirmation before deletion', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Announcement')).toHaveValue('Dinner ready');
    fireEvent.change(screen.getByLabelText('Announcement'), { target: { value: 'Dinner at six' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save announcement' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/households/h/announcements/a',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ title: 'Dinner at six', priority: 'URGENT', pinned: true }),
        }),
      ),
    );
    await screen.findByText('Announcement saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/households/h/announcements/a', { method: 'DELETE' }),
    );
  });
  it('does not mistake load failures for an empty feed and does not auto-speak existing messages', () => {
    state.failed = true;
    state.data = [];
    view();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.queryByText('No active announcements.')).not.toBeInTheDocument();
    expect(speak).not.toHaveBeenCalled();
  });
});
