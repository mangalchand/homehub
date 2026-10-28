import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { FamilyCallCard, familyCallQueryKey, type FamilyCallSettings } from './familyCall';

const { state } = vi.hoisted(() => ({ state: { hid: 'home-a' as string | null, isAdmin: true } }));
vi.mock('@/lib/queries', () => ({ useHid: () => state.hid, useRole: () => ({ isAdmin: state.isAdmin }) }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  hh: (id: string, path: string) => `/api/v1/households/${id}${path}`,
}));

const voice = 'https://call.whatsapp.com/voice/test-token_123';
const video = 'https://call.whatsapp.com/video/other-token';
let saved: FamilyCallSettings;
let client: QueryClient;
function view() {
  const tree = () => (
    <QueryClientProvider client={client}>
      <FamilyCallCard />
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, refresh: () => result.rerender(tree()) };
}
const writes = () => vi.mocked(api).mock.calls.filter(([, opts]) => opts?.method === 'PATCH');
beforeEach(() => {
  state.hid = 'home-a';
  state.isAdmin = true;
  saved = { whatsappCallUrl: null };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(api).mockImplementation(async (_url, opts) => {
    if (opts?.method === 'PATCH') saved = opts.body as FamilyCallSettings;
    return saved;
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('FamilyCallCard', () => {
  it('guides setup, explains Join/privacy/expiry and does not start a call on mount', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    view();
    expect(await screen.findByText(/No family call link yet/)).toBeInTheDocument();
    expect(screen.getByText(/In WhatsApp, open Calls > Create call link/)).toBeInTheDocument();
    expect(screen.getByText(/does not automatically ring or join the whole family/)).toBeInTheDocument();
    expect(screen.getByText(/anyone with the link may join/)).toHaveTextContent(
      /expire after 30 days without use.*revoked by WhatsApp/,
    );
    expect(screen.getByRole('link', { name: 'WhatsApp call-link help' })).toHaveAttribute(
      'href',
      'https://faq.whatsapp.com/456694046556486/',
    );
    expect(screen.queryByRole('link', { name: /Join family/ })).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it.each([voice, video])(
    'renders a user-activated external Join link with no opener/referrer for %s',
    async (url) => {
      saved = { whatsappCallUrl: url };
      state.isAdmin = false;
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      view();
      const link = await screen.findByRole('link', { name: /Join family .* call/ });
      expect(link).toHaveAttribute('href', url);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear call link' })).not.toBeInTheDocument();
      expect(open).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    },
  );

  it('gives non-managers setup guidance and reveals controls only after authorization changes', async () => {
    state.isAdmin = false;
    const result = view();
    expect(await screen.findByText(/Ask a household owner or admin/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    state.isAdmin = true;
    result.refresh();
    expect(screen.getByRole('textbox', { name: 'WhatsApp call link' })).toBeInTheDocument();
    state.isAdmin = false;
    result.refresh();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('saves a validated call URL then explicitly clears it with null', async () => {
    view();
    fireEvent.change(await screen.findByRole('textbox', { name: 'WhatsApp call link' }), {
      target: { value: voice },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save call link' }));
    expect(await screen.findByRole('link', { name: 'Join family voice call' })).toHaveAttribute(
      'href',
      voice,
    );
    expect(writes()[0]).toEqual([
      '/api/v1/households/home-a/family-call',
      { method: 'PATCH', body: { whatsappCallUrl: voice } },
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear call link' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Clear call link' }));
    expect(await screen.findByText('Call link removed from FamilyHub.')).toBeInTheDocument();
    expect(writes()[1]?.[1]?.body).toEqual({ whatsappCallUrl: null });
    expect(screen.queryByRole('link', { name: /Join family/ })).not.toBeInTheDocument();
    expect(screen.getByText(/does not revoke the WhatsApp link or end a call/)).toBeInTheDocument();
  });

  it('sends a household notification for the saved link and explains recipients must join themselves', async () => {
    saved = { whatsappCallUrl: voice };
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Notify household' }));
    expect(await screen.findByText(/FamilyHub notification sent; WhatsApp delivery requires WhatsApp to be connected/)).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/api/v1/households/home-a/family-call/notify', { method: 'POST', body: {} });
  });

  it('rejects invalid links locally instead of making a write request', async () => {
    view();
    const input = await screen.findByRole('textbox', { name: 'WhatsApp call link' });
    for (const url of [
      'https://evil.example/video/token',
      `${voice}?redirect=evil`,
      `${voice}#fragment`,
      ` ${voice}`,
      `https://call.whatsapp.com/voice/${'a'.repeat(501)}`,
    ]) {
      fireEvent.change(input, { target: { value: url } });
      fireEvent.click(screen.getByRole('button', { name: 'Save call link' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Paste an exact');
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    expect(writes()).toHaveLength(0);
  });

  it('fails closed when the server returns an unsafe link', async () => {
    saved = { whatsappCallUrl: 'javascript:alert(1)' };
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('The saved link is invalid');
    expect(screen.queryByRole('link', { name: /Join family/ })).not.toBeInTheDocument();
  });

  it('shows read failures with retry instead of a misleading empty state or stale Join link', async () => {
    client.setQueryData(familyCallQueryKey('home-a'), { whatsappCallUrl: voice });
    vi.mocked(api).mockRejectedValue(new Error('Access denied'));
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the family call link. Access denied',
    );
    expect(screen.queryByText(/No family call link yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Join family/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    vi.mocked(api).mockResolvedValue({ whatsappCallUrl: video });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Join family video call' })).toHaveAttribute(
      'href',
      video,
    );
  });

  it('reports a rejected clear honestly and retains the existing link', async () => {
    saved = { whatsappCallUrl: voice };
    view();
    await screen.findByRole('button', { name: 'Clear call link' });
    vi.mocked(api).mockRejectedValue(new Error('Enter the household PIN to unlock this action.'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear call link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the household PIN');
    expect(screen.queryByText('Call link removed from FamilyHub.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join family voice call' })).toHaveAttribute('href', voice);
  });

  it('resets the draft and scopes reads/writes when the selected household changes', async () => {
    saved = { whatsappCallUrl: voice };
    const result = view();
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'https://call.whatsapp.com/voice/unsaved' },
    });
    let resolve!: (data: FamilyCallSettings) => void;
    vi.mocked(api).mockImplementation(
      () =>
        new Promise<FamilyCallSettings>((r) => {
          resolve = r;
        }),
    );
    state.hid = 'home-b';
    result.refresh();
    expect(screen.getByRole('status')).toHaveTextContent('Loading family call');
    expect(screen.queryByRole('link', { name: /Join family/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await act(async () => {
      resolve({ whatsappCallUrl: video });
    });
    expect(await screen.findByRole('textbox')).toHaveValue(video);
    expect(api).toHaveBeenLastCalledWith('/api/v1/households/home-b/family-call');
    vi.mocked(api).mockResolvedValue({ whatsappCallUrl: null });
    fireEvent.click(screen.getByRole('button', { name: 'Clear call link' }));
    await screen.findByText('Call link removed from FamilyHub.');
    expect(writes().at(-1)?.[0]).toBe('/api/v1/households/home-b/family-call');
  });

  it('keeps an in-flight old-home mutation response out of the newly selected home', async () => {
    saved = { whatsappCallUrl: voice };
    const result = view();
    await screen.findByRole('button', { name: 'Clear call link' });
    let resolve!: (data: FamilyCallSettings) => void;
    vi.mocked(api).mockImplementation(async (url, opts) => {
      if (opts?.method === 'PATCH')
        return new Promise<FamilyCallSettings>((r) => {
          resolve = r;
        });
      return { whatsappCallUrl: url.includes('home-b') ? video : voice };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear call link' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    state.hid = 'home-b';
    result.refresh();
    await screen.findByRole('link', { name: 'Join family video call' });
    await act(async () => {
      resolve({ whatsappCallUrl: null });
    });
    expect(screen.getByRole('link', { name: 'Join family video call' })).toHaveAttribute('href', video);
    expect(screen.queryByText('Call link removed from FamilyHub.')).not.toBeInTheDocument();
  });

  it('does not fetch without a selected household', () => {
    state.hid = null;
    const { container } = view();
    expect(container).toBeEmptyDOMElement();
    expect(api).not.toHaveBeenCalled();
  });
});
