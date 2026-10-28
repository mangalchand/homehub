import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/queries';
import { useUi } from '@/store/ui';
import { AppShell } from './AppShell';

const { state, navigate } = vi.hoisted(() => ({ state: { me: null as Me | null }, navigate: vi.fn() }));
vi.mock('@/lib/queries', () => ({
  useMe: () => ({ data: state.me }),
  useHousehold: () => ({ data: { name: 'Manmay' } }),
  useRole: () => ({ isDevice: state.me?.kind === 'device', elevated: false }),
}));
vi.mock('@/lib/queryClient', () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock('@/lib/nativePush', () => ({ registerNativePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/offline', () => ({
  pendingCount: vi.fn().mockResolvedValue(0),
  onQueueChange: () => () => undefined,
}));
vi.mock('@/lib/realtime', () => ({ useOnline: () => true, useRealtime: () => true }));
vi.mock('@/features/photos', () => ({ Screensaver: () => null }));
vi.mock('@/features/join', () => ({ DeviceJoinPrompt: () => null }));
vi.mock('@/features/voice', () => ({ VoiceButton: () => null }));
vi.mock('@/features/safety', () => ({ SafetyEntry: () => <button>Panic / SOS</button> }));
vi.mock('@/features/spokenAlerts', () => ({ SpokenAlertsControl: () => null }));
vi.mock('./NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
beforeEach(() => {
  state.me = {
    kind: 'user',
    memberships: [
      { householdId: 'a', householdName: 'Manmay', role: 'OWNER', memberId: 'ma' },
      { householdId: 'b', householdName: '1108', role: 'ADULT', memberId: 'mb' },
    ],
    session: { id: 's', pinElevatedUntil: null },
  };
  useUi.setState({
    householdId: 'a',
    displayMode: 'standard',
    memberFilter: ['ma'],
    hiddenCalendarIds: ['ca'],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('phone household navigation', () => {
  it('shows the mobile home chooser, selects 1108 and resets household filters', () => {
    render(
      <MemoryRouter>
        <AppShell>Content</AppShell>
      </MemoryRouter>,
    );
    const select = screen.getByRole('combobox', { name: 'Choose home' });
    expect(select).toHaveValue('a');
    fireEvent.change(select, { target: { value: 'b' } });
    expect(select).toHaveValue('b');
    expect(useUi.getState().memberFilter).toEqual([]);
    expect(useUi.getState().hiddenCalendarIds).toEqual([]);
    expect(navigate).toHaveBeenCalledWith('/');
  });
  it('does not let a paired display select a different home', () => {
    state.me!.kind = 'device';
    render(
      <MemoryRouter>
        <AppShell>Content</AppShell>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('combobox', { name: 'Choose home' })).not.toBeInTheDocument();
  });
  it('exposes Safety, Notes, Announcements and Evening summary from the mobile More menu', () => {
    render(
      <MemoryRouter>
        <AppShell>Content</AppShell>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Panic / SOS' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Spoken household alerts/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    for (const label of ['Safety', 'Notes', 'Announcements', 'Evening summary']) {
      expect(
        within(screen.getByRole('dialog')).getByRole('link', { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
  });
});
