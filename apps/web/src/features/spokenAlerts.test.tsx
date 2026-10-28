import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { cloneElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/queries';
import type { FeedNotification } from '@/lib/voice/household';
import { api } from '@/lib/api';
import { isListening, isSpeaking, speak, stopSpeaking } from '@/lib/voice/speech';
import { SpokenAlertsControl, SpokenAlertTracker, spokenAlertKey, useReadAloud, NotificationsReadAloudButton, PointsReadAloudButton } from './spokenAlerts';

const { state } = vi.hoisted(() => ({ state: { me: undefined as Me | undefined, hid: 'h', feed: [] as FeedNotification[], isSpeaking: false, isListening: false } }));
vi.mock('@/lib/queries', () => ({ useMe: () => ({ data: state.me }), useHid: () => state.hid }));
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: vi.fn() }));
vi.mock('@/lib/voice/speech', () => ({ speak: vi.fn().mockResolvedValue(undefined), stopSpeaking: vi.fn(), isSpeaking: vi.fn(() => state.isSpeaking), isListening: vi.fn(() => state.isListening) }));

const notification = (id: string, options: Partial<FeedNotification> = {}): FeedNotification => ({ id, householdId: 'h', memberId: null, title: id, body: 'Details', type: 'announcement', data: {}, readAt: null, createdAt: new Date().toISOString(), ...options });
const device = (): Me => ({ kind: 'device', device: { id: 'd', householdId: 'h', name: 'Kitchen' }, memberships: [], session: { id: 's', pinElevatedUntil: null } });
const clients: QueryClient[] = [];
function view(children = <SpokenAlertsControl />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  const wrap = () => <QueryClientProvider client={client}>{cloneElement(children)}</QueryClientProvider>;
  return { ...render(wrap()), update: wrap, client };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); state.me = device(); state.hid = 'h'; state.feed = []; state.isSpeaking = false; state.isListening = false;
  vi.mocked(speak).mockResolvedValue(undefined);
  vi.mocked(api).mockImplementation(async (url) => url === '/api/v1/auth/me' ? state.me : [...state.feed]);
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); });

describe('read aloud cancellation', () => {
  it('does not speak a pending read after Stop, a household switch or unmount', async () => {
    let resolve!: (text: string) => void;
    const loader = () => new Promise<string>((r) => { resolve = r; });
    const { result, rerender, unmount } = renderHook(({ scope }) => useReadAloud(scope), { initialProps: { scope: 'home-a:device-d' } });
    act(() => { void result.current.read(loader); });
    act(() => result.current.stop());
    await act(async () => resolve('Cancelled'));
    expect(speak).not.toHaveBeenCalled();
    act(() => { void result.current.read(loader); });
    rerender({ scope: 'home-b:device-d' });
    await act(async () => resolve('Other home secret'));
    expect(speak).not.toHaveBeenCalled(); expect(result.current.text).toBe('');
    act(() => { void result.current.read(loader); }); unmount();
    await act(async () => resolve('Unmounted'));
    expect(speak).not.toHaveBeenCalled(); expect(stopSpeaking).toHaveBeenCalled();
  });
  it('does not replay on mount and reports browser audio denial with readable text', async () => {
    vi.mocked(speak).mockRejectedValueOnce(new Error('Read aloud was blocked. Tap Read aloud.'));
    const { result } = renderHook(() => useReadAloud('home:device'));
    expect(speak).not.toHaveBeenCalled();
    await act(async () => result.current.read(() => 'Dinner ready'));
    expect(result.current.error).toContain('blocked'); expect(result.current.text).toBe('Dinner ready'); expect(result.current.busy).toBe(false);
  });
});

describe('new household alert tracking', () => {
  it('baselines initial history, deduplicates and never replays old unread items', () => {
    const tracker = new SpokenAlertTracker();
    const now = Date.now();
    const old = notification('old', { createdAt: new Date(now - 1000).toISOString() });
    const fresh = notification('fresh', { createdAt: new Date(now).toISOString() });
    expect(tracker.accept([old], now)).toEqual([]);
    expect(tracker.accept([fresh, old], now)).toEqual([fresh]);
    expect(tracker.accept([fresh, old], now)).toEqual([]);
    expect(tracker.accept([], now)).toEqual([]);
    expect(tracker.accept([old], now)).toEqual([]);
    tracker.reset(); expect(tracker.accept([fresh, old], now)).toEqual([]);
  });
  it('limits bursts and ignores stale, read and future-dated alerts', () => {
    const tracker = new SpokenAlertTracker(); const now = Date.now(); tracker.accept([], now);
    const fresh = Array.from({ length: 10 }, (_, i) => notification(`new-${i}`, { createdAt: new Date(now).toISOString() }));
    expect(tracker.accept([notification('read', { readAt: 'now' }), notification('stale', { createdAt: new Date(now - 120_000).toISOString() }), notification('future', { createdAt: new Date(now + 60_000).toISOString() }), ...fresh], now)).toHaveLength(3);
    expect(tracker.accept(fresh, now)).toEqual([]);
  });
});

describe('display spoken alerts opt in', () => {
  it('defaults off and requires a user gesture even with the saved household/device opt-in', async () => {
    localStorage.setItem(spokenAlertKey('h', 'd'), 'true');
    view();
    expect(screen.getByText('Spoken household alerts: paused')).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume spoken alerts' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/households/h/notifications'));
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it('reads only NEW device-feed alerts, ignores private feeds, and does not overlap another reader', async () => {
    state.feed = [notification('Initial history', { createdAt: new Date(Date.now() - 1000).toISOString() })];
    const page = view();
    fireEvent.click(screen.getByRole('button', { name: 'Enable spoken alerts' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/households/h/notifications'));
    await waitFor(() => expect(page.client.getQueryState(['spoken-household-alerts', 'h', 'd'])?.fetchStatus).toBe('idle'));
    expect(speak).toHaveBeenCalledTimes(1);
    state.feed = [notification('New household alert'), notification('Private message', { memberId: 'm' }), notification('Other home', { householdId: 'other' }), ...state.feed];
    await act(async () => page.client.invalidateQueries({ queryKey: ['spoken-household-alerts'] }));
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
    expect(vi.mocked(speak).mock.calls[1]![0]).toContain('New household alert');
    expect(vi.mocked(speak).mock.calls[1]![0]).not.toContain('Private');
    state.isSpeaking = true;
    vi.mocked(isSpeaking).mockClear();
    state.feed = [notification('Do not interrupt'), ...state.feed];
    await act(async () => page.client.invalidateQueries({ queryKey: ['spoken-household-alerts'] }));
    await waitFor(() => expect(isSpeaking).toHaveBeenCalled());
    expect(speak).toHaveBeenCalledTimes(2);
    state.isSpeaking = false;
    await act(async () => page.client.invalidateQueries({ queryKey: ['spoken-household-alerts'] }));
    expect(speak).toHaveBeenCalledTimes(2);
    state.isListening = true;
    vi.mocked(isListening).mockClear();
    state.feed = [notification('Do not speak into microphone'), ...state.feed];
    await act(async () => page.client.invalidateQueries({ queryKey: ['spoken-household-alerts'] }));
    await waitFor(() => expect(isListening).toHaveBeenCalled());
    expect(speak).toHaveBeenCalledTimes(2);
  });
  it('stops on offline/reconnect, disables without replay and cleans up on household switching', async () => {
    const page = view();
    expect(screen.getByText('Spoken household alerts: off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable spoken alerts' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(localStorage.getItem(spokenAlertKey('h', 'd'))).toBe('true');
    fireEvent(window, new Event('offline'));
    expect(screen.getByText('Spoken household alerts: paused')).toBeInTheDocument();
    expect(stopSpeaking).toHaveBeenCalled();
    fireEvent(window, new Event('online'));
    expect(screen.getByRole('button', { name: 'Resume spoken alerts' })).toBeInTheDocument();
    state.feed = [notification('Reconnect history')];
    fireEvent.click(screen.getByRole('button', { name: 'Resume spoken alerts' }));
    await waitFor(() => expect(page.client.getQueryState(['spoken-household-alerts', 'h', 'd'])?.fetchStatus).toBe('idle'));
    await act(async () => page.client.invalidateQueries({ queryKey: ['spoken-household-alerts'] }));
    expect(vi.mocked(speak).mock.calls.every(([text]) => !text.includes('Reconnect history'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disable spoken alerts' }));
    expect(localStorage.getItem(spokenAlertKey('h', 'd'))).toBe('false');
    state.hid = 'other'; page.rerender(page.update());
    expect(screen.queryByLabelText('Spoken household alerts')).not.toBeInTheDocument();
  });
  it('never mounts on personal sessions and scopes saved opt-in to both home and device', () => {
    state.me = { ...device(), kind: 'user', device: undefined }; view();
    expect(screen.queryByLabelText('Spoken household alerts')).not.toBeInTheDocument();
    expect(spokenAlertKey('h', 'd')).not.toBe(spokenAlertKey('other', 'd'));
    expect(spokenAlertKey('h', 'd')).not.toBe(spokenAlertKey('h', 'other'));
    expect(api).not.toHaveBeenCalled();
  });
  it('manual notification reading re-fetches the authenticated device feed, not cached private data', async () => {
    state.feed = [notification('Family message'), notification('Secret', { memberId: 'm' })];
    view(<NotificationsReadAloudButton />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read notifications aloud' }));
    await waitFor(() => expect(speak).toHaveBeenCalledWith('1 unread notification. Family message. Details.'));
  });
  it('reads a selected Rewards member on demand with available, reserved and pending points', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === '/api/v1/auth/me') return state.me;
      if (url.endsWith('/members')) return [{ id: 'm', displayName: 'Leo', isActive: true }];
      if (url.endsWith('/points')) return [{ memberId: 'm', balance: 100, available: 75, pending: -15 }];
      throw new Error('Unexpected request');
    });
    view(<PointsReadAloudButton memberId="m" />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read points aloud' }));
    await waitFor(() => expect(speak).toHaveBeenCalledWith('Leo has 75 points available, from a balance of 100. 25 points are reserved for reward requests. 10 earned points are awaiting approval.'));
  });
});
