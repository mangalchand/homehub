import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  SafetyEntry,
  SafetyPanel,
  SafetyProvider,
  safetyLocationConsentKey,
  type SafetySession,
} from './safety';
import { Safety } from '@/pages/Safety';
import { watchSafetyLocation } from '@/lib/safetyLocation';

const mocks = vi.hoisted(() => ({
  hid: 'home-a',
  api: vi.fn(),
  watch: vi.fn(),
  me: {
    kind: 'user',
    user: {
      id: 'user-1',
      email: 'a@example.test',
      displayName: 'Alice',
      hasPassword: true,
      emailVerified: true,
    },
    memberships: [{ householdId: 'home-a', householdName: 'Home', memberId: 'member-1', role: 'ADULT' }],
    session: { id: 'session-1', pinElevatedUntil: null },
  } as import('@/lib/queries').Me,
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: mocks.api,
}));
vi.mock('@/lib/queries', () => ({ useHid: () => mocks.hid, useMe: () => ({ data: mocks.me }) }));
vi.mock('@/lib/safetyLocation', () => ({ watchSafetyLocation: mocks.watch }));
vi.mock('@/features/familyCall', () => ({ FamilyCallCard: () => null }));

class Stream {
  static instances: Stream[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    Stream.instances.push(this);
  }
}
let feed: SafetySession[];
const clearWatch = vi.fn();
function session(extra: Partial<SafetySession> = {}): SafetySession {
  return {
    id: 'sos-1',
    householdId: mocks.hid,
    sourceMemberId: 'member',
    sourceDeviceId: null,
    sender: 'Alice',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    stoppedAt: null,
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    locationAt: null,
    status: 'active',
    locationStatus: 'unavailable',
    isOrigin: true,
    canStop: true,
    ...extra,
  };
}
function app() {
  return (
    <MemoryRouter>
      <SafetyProvider>
        <SafetyEntry />
        <SafetyPanel />
      </SafetyProvider>
    </MemoryRouter>
  );
}
async function activate(share = false) {
  if (share) localStorage.setItem(safetyLocationConsentKey(mocks.hid, 'member-1'), 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Panic / SOS' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Sending SOS…' })).not.toBeInTheDocument());
}
beforeEach(() => {
  vi.clearAllMocks();
  feed = [];
  mocks.hid = 'home-a';
  localStorage.clear();
  Stream.instances = [];
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('EventSource', Stream);
  mocks.watch.mockImplementation((_fix, state) => {
    state('waiting');
    return clearWatch;
  });
  mocks.api.mockImplementation(async (_path: string, opts?: { method?: string }) => {
    if (opts?.method === 'POST') {
      feed = [session()];
      return feed[0];
    }
    return { sessions: feed, serverTime: new Date().toISOString() };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Safety UI lifecycle and truthful activation', () => {
  it('activates with no GPS and without requiring location consent', async () => {
    render(app());
    await activate();
    expect(mocks.api).toHaveBeenCalledWith('/api/v1/households/home-a/safety', { method: 'POST', body: {} });
    expect(screen.getByText('Alice — SOS active')).toBeInTheDocument();
    expect(screen.getByText(/GPS unavailable or not shared/)).toBeInTheDocument();
    expect(watchSafetyLocation).not.toHaveBeenCalled();
  });

  it('never waits for GPS to create the alert, requests location only after consent and server activation, and keeps SOS active on denial', async () => {
    let resolve!: (value: SafetySession) => void;
    mocks.api.mockImplementation(async (_path: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST')
        return new Promise<SafetySession>((r) => {
          resolve = (value) => {
            feed = [value];
            r(value);
          };
        });
      return { sessions: feed, serverTime: new Date().toISOString() };
    });
    render(app());
    localStorage.setItem(safetyLocationConsentKey('home-a', 'member-1'), 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Panic / SOS' }));
    expect(mocks.watch).not.toHaveBeenCalled();
    await act(async () => resolve(session()));
    await waitFor(() => expect(mocks.watch).toHaveBeenCalledTimes(1));
    act(() => mocks.watch.mock.calls[0]![1]('denied'));
    expect(screen.getByText(/GPS permission denied — SOS remains active without GPS/)).toBeInTheDocument();
    expect(screen.getByText('Alice — SOS active')).toBeInTheDocument();
    expect(screen.getByText(/Not monitored emergency dispatch/)).toBeInTheDocument();
  });

  it('does not queue activation offline or claim success when the network fails', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    render(app());
    await activate(true);
    expect(screen.getByText(/Could not confirm SOS activation: Offline/)).toBeInTheDocument();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.watch).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    mocks.api.mockRejectedValueOnce(new Error('Network unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Panic / SOS' }));
    await screen.findByText(/Could not confirm SOS activation: Network unavailable/);
    expect(screen.queryByText('Alice — SOS active')).not.toBeInTheDocument();
  });

  it('clears watches on unmount and immediately on household switch without leaking old household alerts', async () => {
    const view = render(app());
    await activate(true);
    await waitFor(() => expect(mocks.watch).toHaveBeenCalledTimes(1));
    feed = [];
    mocks.hid = 'home-b';
    view.rerender(app());
    expect(clearWatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Alice — SOS active')).not.toBeInTheDocument();
    expect(Stream.instances[0]!.close).toHaveBeenCalled();
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/v1/households/home-b/safety'));
    await activate(true);
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Location is not shared/)).toBeInTheDocument();
    view.unmount();
    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  it('stops foreground watches on hidden/offline and resumes only while visible/online with existing consent', async () => {
    render(app());
    await activate(true);
    await waitFor(() => expect(mocks.watch).toHaveBeenCalledTimes(1));
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(clearWatch).toHaveBeenCalled();
    expect(screen.queryByText('Alice — SOS active')).not.toBeInTheDocument();
    const calls = mocks.api.mock.calls.length;
    act(() => {
      Stream.instances[0]!.onmessage?.({ data: '{"type":"safety.changed"}' });
    });
    expect(mocks.api.mock.calls.length).toBe(calls);
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(mocks.watch).toHaveBeenCalledTimes(2));
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(/Offline — cannot verify/)).toBeInTheDocument();
    expect(clearWatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('uses SSE invalidation, reconnect refresh and polling when disconnected', async () => {
    vi.useFakeTimers();
    render(app());
    await act(async () => {});
    feed = [session()];
    await act(async () => {
      Stream.instances[0]!.onmessage?.({ data: '{"type":"safety.changed"}' });
    });
    expect(screen.getByText('Alice — SOS active')).toBeInTheDocument();
    act(() => Stream.instances[0]!.onerror?.());
    const count = mocks.api.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(mocks.api.mock.calls.length).toBeGreaterThan(count);
    expect(Stream.instances.length).toBeGreaterThan(1);
    await act(async () => Stream.instances.at(-1)!.onopen?.());
    expect(screen.getByText('Live household updates connected')).toBeInTheDocument();
  });

  it('shows no map until a deliberate click and hides stale/expired fixes even if an old response supplied coordinates', async () => {
    feed = [
      session({
        latitude: 10,
        longitude: 20,
        accuracyMeters: 5,
        locationAt: new Date().toISOString(),
        locationStatus: 'live',
      }),
    ];
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(app());
    fireEvent.click(await screen.findByRole('button', { name: 'Open location in external map' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      'https://www.google.com/maps/search/?api=1&query=10%2C20',
      '_blank',
      'noopener,noreferrer',
    );
    feed = [
      session({
        latitude: 10,
        longitude: 20,
        locationAt: new Date(Date.now() - 180_000).toISOString(),
        locationStatus: 'live',
      }),
    ];
    await act(async () => Stream.instances[0]!.onmessage?.({ data: '{"type":"safety.changed"}' }));
    expect(screen.queryByRole('button', { name: 'Open location in external map' })).not.toBeInTheDocument();
    expect(screen.getByText(/Location is stale/)).toBeInTheDocument();
    feed = [
      session({
        latitude: 10,
        longitude: 20,
        locationAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        locationStatus: 'live',
      }),
    ];
    await act(async () => Stream.instances[0]!.onmessage?.({ data: '{"type":"safety.changed"}' }));
    expect(screen.getByText('Alice — Alert expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open location in external map' })).not.toBeInTheDocument();
    open.mockRestore();
  });

  it('stops the watch immediately even if the stop request fails; never claims the server alert ended', async () => {
    render(app());
    await activate(true);
    await waitFor(() => expect(mocks.watch).toHaveBeenCalledTimes(1));
    mocks.api.mockRejectedValueOnce(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop alert & location sharing' }));
    await screen.findByText(/Could not confirm stop: Connection lost/);
    expect(clearWatch).toHaveBeenCalled();
    expect(screen.getByText('Alice — SOS active')).toBeInTheDocument();
    expect(screen.queryByText('Alice — Alert ended')).not.toBeInTheDocument();
  });

  it('does not persist location queries or expose another household from a notification link', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    feed = [session()];
    render(
      <MemoryRouter initialEntries={['/safety?householdId=other-home']}>
        <SafetyProvider>
          <Safety />
        </SafetyProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/This notification is for a different household/)).toBeInTheDocument();
    await screen.findByText('Alice — SOS active');
    expect(mocks.hid).toBe('home-a');
    expect(mocks.api.mock.calls.every(([path]) => String(path).includes('/home-a/'))).toBe(true);
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });
});
