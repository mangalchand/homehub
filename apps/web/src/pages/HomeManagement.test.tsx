import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/queries';
import { api } from '@/lib/api';
import { DevicesSection } from './Settings';

const { state } = vi.hoisted(() => ({ state: { me: null as Me | null, role: 'OWNER' } }));
vi.mock('@/lib/queries', () => ({ useHid: () => 'a', useMe: () => ({ data: state.me }), useRole: () => ({ role: state.role, isDevice: state.me?.kind === 'device' }), useHhMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@/lib/api', () => ({ api: vi.fn(), hh: (h: string, p: string) => `/api/v1/households/${h}${p}` }));
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><DevicesSection allHomes /></QueryClientProvider>);
}
beforeEach(() => {
  state.me = { kind: 'user', memberships: [{ householdId: 'a', householdName: 'Manmay', role: 'OWNER', memberId: 'ma' }, { householdId: 'b', householdName: '1108', role: 'ADULT', memberId: 'mb' }], session: { id: 's', pinElevatedUntil: null } };
  state.role = 'OWNER';
  vi.mocked(api).mockImplementation(async (url) => url.includes('/a/') ? [{ id: 'k', name: 'Kitchen', pairedAt: new Date().toISOString(), revokedAt: null, lastSeenAt: new Date().toISOString() }] : [{ id: 'h', name: 'Hallway', pairedAt: new Date().toISOString(), revokedAt: new Date().toISOString(), lastSeenAt: null }]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('consolidated household displays', () => {
  it('lists displays across both homes, with honest statuses and owner-only actions', async () => {
    view();
    expect(await screen.findByText('Kitchen')).toBeInTheDocument();
    expect(await screen.findByText('Hallway')).toBeInTheDocument();
    expect(screen.getByText('Manmay')).toBeInTheDocument();
    expect(screen.getByText('1108')).toBeInTheDocument();
    expect(screen.getByText('Paired', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Revoked', { exact: true })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Pair a display' })).toBeInTheDocument();
  });
  it('does not offer management or fetch other homes on a paired display', async () => {
    state.me!.kind = 'device';
    state.me!.memberships = [state.me!.memberships[0]!];
    state.me!.memberships[0]!.role = 'WALL_DISPLAY';
    state.role = 'WALL_DISPLAY';
    view();
    await screen.findByText('Kitchen');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/v1/households/a/devices');
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair a display' })).not.toBeInTheDocument();
  });
  it('shows failures instead of reporting an empty device list', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Forbidden'));
    view();
    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(screen.queryByText('No displays registered.')).not.toBeInTheDocument();
  });
});
