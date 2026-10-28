import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDTO } from '@familyhub/shared';
import { api } from '@/lib/api';
import { uploadAttachment } from '@/lib/attachments';
import { RecordImages } from './RecordImages';

const state = vi.hoisted(() => ({ hid: 'home-a' }));
vi.mock('@/lib/queries', () => ({ useHid: () => state.hid }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  hh: (hid: string, path: string) => `/api/v1/households/${hid}${path}`,
}));
vi.mock('@/lib/attachments', () => ({
  uploadAttachment: vi.fn(),
  IMAGE_ACCEPT: 'image/jpeg,image/png,image/webp',
  MAX_RECORD_IMAGES: 5,
}));
const image = (id = 'image-1'): AttachmentDTO => ({
  id,
  householdId: state.hid,
  noteId: 'note-1',
  taskId: null,
  uploaderMemberId: 'member-1',
  uploaderDeviceId: null,
  mimeType: 'image/webp',
  sizeBytes: 20,
  width: 20,
  height: 20,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const file = () => new File(['raster-test-input'], 'camera.jpg', { type: 'image/jpeg' });
let items: AttachmentDTO[], canUpload: boolean;
function view(readOnly = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = () => (
    <QueryClientProvider client={client}>
      <RecordImages parentType="notes" parentId="note-1" readOnly={readOnly} />
    </QueryClientProvider>
  );
  return { ...render(element()), client, element };
}
beforeEach(() => {
  state.hid = 'home-a';
  items = [];
  canUpload = true;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:preview');
      static override revokeObjectURL = vi.fn();
    },
  );
  vi.mocked(api).mockImplementation(async (_path, opts) => {
    if (opts?.method === 'DELETE') {
      items = [];
      return undefined;
    }
    return { items, canUpload, canDeleteIds: canUpload ? items.map((a) => a.id) : [] };
  });
  vi.mocked(uploadAttachment).mockImplementation(async () => {
    const a = image();
    items = [a];
    return a;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('record image controls', () => {
  it('scopes private full/thumbnail links and honors read-only and backend write permissions', async () => {
    items = [image()];
    canUpload = false;
    const { unmount } = view();
    expect(await screen.findByRole('link', { name: 'Open attached image 1' })).toHaveAttribute(
      'href',
      '/api/v1/households/home-a/attachments/image-1/file',
    );
    expect(screen.getByAltText('Attachment 1')).toHaveAttribute(
      'src',
      '/api/v1/households/home-a/attachments/image-1/file?size=thumb',
    );
    expect(screen.queryByRole('button', { name: 'Add images' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove image 1' })).not.toBeInTheDocument();
    unmount();
    canUpload = true;
    view(true);
    await screen.findByAltText('Attachment 1');
    expect(screen.queryByRole('button', { name: 'Camera' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove image 1' })).not.toBeInTheDocument();
  });

  it('provides file/camera selection, actual progress, processing and refresh after server confirmation', async () => {
    let finish!: (value: AttachmentDTO) => void;
    let progress!: (value: number) => void;
    vi.mocked(uploadAttachment).mockImplementation((_path, _file, onProgress) => {
      progress = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    view();
    const input = await screen.findByLabelText('Choose attachment images');
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(screen.getByLabelText('Take an attachment photo')).toHaveAttribute('capture', 'environment');
    fireEvent.change(input, { target: { files: [file()] } });
    await screen.findByAltText('Preview: camera.jpg');
    act(() => progress(43));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '43');
    act(() => progress(100));
    expect(screen.getByText('Processing…')).toBeInTheDocument();
    expect(screen.queryByAltText('Attachment 1')).not.toBeInTheDocument();
    items = [image()];
    await act(async () => finish(items[0]!));
    await screen.findByAltText('Attachment 1');
    expect(screen.queryByAltText('Preview: camera.jpg')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(uploadAttachment).toHaveBeenCalledWith(
      '/api/v1/households/home-a/notes/note-1/attachments',
      expect.any(File),
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it('shows failed/offline uploads honestly and supports retry and removal', async () => {
    vi.mocked(uploadAttachment).mockRejectedValueOnce(
      new Error('You are offline. Connect before uploading images.'),
    );
    view();
    fireEvent.change(await screen.findByLabelText('Choose attachment images'), {
      target: { files: [file()] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('You are offline');
    expect(screen.queryByAltText('Attachment 1')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByAltText('Attachment 1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));
    await waitFor(() => expect(screen.queryByAltText('Attachment 1')).not.toBeInTheDocument());
    expect(api).toHaveBeenCalledWith('/api/v1/households/home-a/attachments/image-1', { method: 'DELETE' });
  });

  it('rejects unsupported, empty, oversized and over-count selections without uploading', async () => {
    items = [image('1'), image('2'), image('3'), image('4')];
    view();
    const input = await screen.findByLabelText('Choose attachment images');
    for (const bad of [
      new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' }),
      new File([], 'empty.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array(10485761)], 'large.jpg', { type: 'image/jpeg' }),
    ]) {
      fireEvent.change(input, { target: { files: [bad] } });
      expect(screen.getByRole('alert')).toHaveTextContent('Choose JPEG, PNG or WebP');
    }
    fireEvent.change(input, { target: { files: [file(), file()] } });
    expect(screen.getByRole('alert')).toHaveTextContent('at most five');
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('aborts uploads and discards previews when switching households', async () => {
    let signal!: AbortSignal;
    vi.mocked(uploadAttachment).mockImplementation((_p, _f, _cb, s) => {
      signal = s!;
      return new Promise(() => {});
    });
    const page = view();
    fireEvent.change(await screen.findByLabelText('Choose attachment images'), {
      target: { files: [file()] },
    });
    await screen.findByAltText('Preview: camera.jpg');
    state.hid = 'home-b';
    page.rerender(page.element());
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/households/home-b/notes/note-1/attachments'),
    );
    expect(signal.aborted).toBe(true);
    expect(screen.queryByAltText('Preview: camera.jpg')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('renders load and deletion errors instead of claiming an image was removed', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Image list unavailable'));
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('Image list unavailable');
    items = [image()];
    fireEvent.click(screen.getByRole('button', { name: 'Retry images' }));
    await screen.findByAltText('Attachment 1');
    vi.mocked(api).mockRejectedValueOnce(new Error('Not authorized'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not authorized');
    expect(screen.getByAltText('Attachment 1')).toBeInTheDocument();
  });
});
