import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDTO } from '@familyhub/shared';
import { api } from '@/lib/api';
import NotesPage from './Notes';

const state = vi.hoisted(() => ({
  hid: 'home-a',
  role: 'ADULT',
  isDevice: false,
  isAdmin: false,
  memberId: 'member-1',
  deviceId: 'device-1',
}));
vi.mock('@/lib/queries', () => ({
  useHid: () => state.hid,
  useRole: () => state,
  useMe: () => ({ data: { device: { id: state.deviceId } } }),
  useMembers: () => ({ data: [{ id: 'member-1', displayName: 'Parent' }] }),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  hh: (hid: string, path: string) => `/api/v1/households/${hid}${path}`,
}));
vi.mock('@/components/RecordImages', () => ({
  RecordImages: ({ parentId, readOnly }: { parentId: string; readOnly?: boolean }) => (
    <p>
      {readOnly ? 'Images' : 'Image editor'} for {parentId}
    </p>
  ),
}));
const note = (patch: Partial<NoteDTO> = {}): NoteDTO => ({
  id: 'note-1',
  householdId: state.hid,
  title: 'House instructions',
  body: 'Keep this safe',
  authorMemberId: 'member-1',
  authorDeviceId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  attachments: [],
  ...patch,
});
let notes: NoteDTO[];
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = () => (
    <QueryClientProvider client={client}>
      <NotesPage />
    </QueryClientProvider>
  );
  return { ...render(element()), element };
}
beforeEach(() => {
  Object.assign(state, {
    hid: 'home-a',
    role: 'ADULT',
    isDevice: false,
    isAdmin: false,
    memberId: 'member-1',
  });
  notes = [note()];
  vi.mocked(api).mockImplementation(async (_p, opts) => {
    if (opts?.method === 'POST') {
      const n = note(opts.body as Partial<NoteDTO>);
      notes = [n];
      return n;
    }
    if (opts?.method === 'PATCH') {
      const n = note(opts.body as Partial<NoteDTO>);
      notes = [n];
      return n;
    }
    if (opts?.method === 'DELETE') {
      notes = [];
      return undefined;
    }
    return notes;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('household notes', () => {
  it('shows persisted text, author, timestamps and image controls only after saving', async () => {
    notes = [];
    view();
    await screen.findByText('No notes yet');
    fireEvent.click(screen.getByRole('button', { name: 'New note' }));
    expect(screen.queryByText('Image editor for note-1')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'House instructions' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Keep this safe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('Note saved.');
    expect(api).toHaveBeenCalledWith('/api/v1/households/home-a/notes', {
      method: 'POST',
      body: { title: 'House instructions', body: 'Keep this safe' },
    });
    expect(screen.getByText('Image editor for note-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Keep this safe')).toBeInTheDocument();
    expect(screen.getByText(/By Parent · Created/)).toHaveTextContent('Updated');
  });

  it('updates own notes and confirms destructive deletion', async () => {
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit House instructions' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('Note saved.');
    expect(api).toHaveBeenCalledWith('/api/v1/households/home-a/notes/note-1', {
      method: 'PATCH',
      body: { title: 'Updated title', body: 'Keep this safe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Updated title' }));
    expect(api).not.toHaveBeenCalledWith(expect.any(String), { method: 'DELETE' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete note' }));
    await screen.findByText('No notes yet');
    expect(api).toHaveBeenCalledWith('/api/v1/households/home-a/notes/note-1', { method: 'DELETE' });
  });

  it('limits non-admins to their own notes, paired displays to device authorship and guests to reading', async () => {
    notes = [note({ authorMemberId: 'another-member' })];
    const page = view();
    await screen.findByText('House instructions');
    expect(screen.queryByRole('button', { name: 'Edit House instructions' })).not.toBeInTheDocument();
    state.isDevice = true;
    state.role = 'WALL_DISPLAY';
    notes = [note({ authorMemberId: null, authorDeviceId: 'device-1' })];
    state.hid = 'home-b';
    page.rerender(page.element());
    expect(await screen.findByRole('button', { name: 'Edit House instructions' })).toBeInTheDocument();
    expect(screen.getByText(/This display can create notes/)).toBeInTheDocument();
    state.isDevice = false;
    state.role = 'GUEST';
    state.hid = 'home-c';
    page.rerender(page.element());
    await screen.findByText('House instructions');
    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit House instructions' })).not.toBeInTheDocument();
  });

  it('allows household admins to manage other authors, and resets open drafts on household change', async () => {
    state.isAdmin = true;
    state.role = 'OWNER';
    notes = [note({ authorMemberId: 'another-member' })];
    const page = view();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit House instructions' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft in old home' } });
    state.hid = 'home-b';
    notes = [];
    page.rerender(page.element());
    await screen.findByText('No notes yet');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/api/v1/households/home-b/notes');
  });

  it('shows loading/save/delete failures without success or optimistic disappearance', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Cannot load notes'));
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load notes');
    expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit House instructions' }));
    vi.mocked(api).mockRejectedValueOnce(new Error('You appear to be offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByText('Note saved.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete House instructions' }));
    vi.mocked(api).mockRejectedValueOnce(new Error('Delete denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Delete denied'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'House instructions' })).toBeInTheDocument();
  });
});
