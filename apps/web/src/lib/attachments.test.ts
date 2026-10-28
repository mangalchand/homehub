import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { api } from './api';
import { uploadAttachment } from './attachments';

vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
class FakeXHR {
  static requests: FakeXHR[] = [];
  upload = {
    onprogress: null as
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 201;
  responseText = '{"id":"saved-image"}';
  withCredentials = false;
  timeout = 0;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  constructor() {
    FakeXHR.requests.push(this);
  }
  abort() {
    this.onabort?.();
  }
}
const file = () => new File(['raster-input'], 'camera.jpg', { type: 'image/jpeg' });
const path = '/api/v1/households/home-a/notes/note-1/attachments';
const request = async (index = 0) => {
  await waitFor(() => expect(FakeXHR.requests.length).toBeGreaterThan(index));
  return FakeXHR.requests[index]!;
};
beforeEach(() => {
  FakeXHR.requests = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.mocked(api).mockResolvedValue({ csrfToken: 'unit-test-token' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('online-only multipart uploads', () => {
  it('sends a single file with credentials and CSRF and reports actual bytes before server confirmation', async () => {
    const progress = vi.fn(),
      input = file();
    const promise = uploadAttachment(path, input, progress);
    const xhr = await request();
    expect(xhr.open).toHaveBeenCalledWith('POST', path);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('x-csrf-token', 'unit-test-token');
    expect(xhr.send.mock.calls[0]![0]).toBeInstanceOf(FormData);
    expect((xhr.send.mock.calls[0]![0] as FormData).get('file')).toBe(input);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    expect(progress).toHaveBeenCalledWith(50);
    xhr.onload?.();
    await expect(promise).resolves.toEqual({ id: 'saved-image' });
  });

  it('rejects offline immediately without a request or a queued-success result', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(uploadAttachment(path, file(), vi.fn())).rejects.toThrow('offline');
    expect(api).not.toHaveBeenCalled();
    expect(FakeXHR.requests).toHaveLength(0);
  });

  it('surfaces server validation and malformed-response errors', async () => {
    const failed = uploadAttachment(path, file(), vi.fn());
    const check = expect(failed).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_IMAGE',
      message: 'Invalid image',
    });
    const xhr = await request();
    xhr.status = 422;
    xhr.responseText = '{"error":{"code":"INVALID_IMAGE","message":"Invalid image"}}';
    xhr.onload?.();
    await check;
    const malformed = uploadAttachment(path, file(), vi.fn());
    const malformedCheck = expect(malformed).rejects.toThrow('Unexpected upload response');
    const second = await request(1);
    second.responseText = '<html>Unavailable</html>';
    second.onload?.();
    await malformedCheck;
  });

  it('reports lost connections, timeouts and cancellation without implying success', async () => {
    for (const kind of ['onerror', 'ontimeout', 'abort'] as const) {
      const controller = new AbortController();
      const promise = uploadAttachment(path, file(), vi.fn(), controller.signal);
      const check = expect(promise).rejects.toThrow(
        kind === 'onerror' ? 'Connection lost' : kind === 'ontimeout' ? 'timed out' : 'cancelled',
      );
      const xhr = await request(FakeXHR.requests.length);
      if (kind === 'abort') controller.abort();
      else xhr[kind]?.();
      await check;
    }
  });

  it('refreshes CSRF at most once and never automatically retries other upload failures', async () => {
    const promise = uploadAttachment(path, file(), vi.fn());
    const first = await request();
    first.status = 403;
    first.responseText = '{"error":{"code":"CSRF","message":"Expired token"}}';
    first.onload?.();
    const second = await request(1);
    second.onload?.();
    await expect(promise).resolves.toEqual({ id: 'saved-image' });
    expect(api).toHaveBeenCalledTimes(2);
    const denied = uploadAttachment(path, file(), vi.fn());
    const check = expect(denied).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const third = await request(2);
    third.status = 403;
    third.responseText = '{"error":{"code":"FORBIDDEN","message":"PIN required"}}';
    third.onload?.();
    await check;
    expect(FakeXHR.requests).toHaveLength(3);
  });
});
