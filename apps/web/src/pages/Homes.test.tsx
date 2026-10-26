import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/queries';
import { api } from '@/lib/api';
import { useUi } from '@/store/ui';
import { HomesCard } from './Homes';

const { state, navigate } = vi.hoisted(() => ({ state: { me: null as Me | null }, navigate: vi.fn() }));
vi.mock('@/lib/queries', () => ({ useMe: () => ({ data: state.me, refetch: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('react-router-dom', async (importOriginal) => ({ ...await importOriginal<typeof import('react-router-dom')>(), useNavigate: () => navigate }));

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><HomesCard /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  state.me = { kind: 'user', memberships: [{ householdId: 'a', householdName: 'Manmay', role: 'OWNER', memberId: 'ma' }, { householdId: 'b', householdName: '1108', role: 'ADULT', memberId: 'mb' }], session: { id: 's', pinElevatedUntil: null } };
  useUi.setState({ householdId: 'a', memberFilter: ['ma'], hiddenCalendarIds: ['ca'] });
  vi.mocked(api).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('choosing a home with an existing account', () => {
  it('opens 1108 and clears the other home’s calendar/member filters', async () => {
    view();
    expect(screen.getByText('Manmay')).toBeInTheDocument();
    expect(screen.getByText('1108')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open home' })[1]!);
    expect(useUi.getState().householdId).toBe('b');
    expect(useUi.getState().memberFilter).toEqual([]);
    expect(useUi.getState().hiddenCalendarIds).toEqual([]);
    expect(navigate).toHaveBeenCalledWith('/');
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/me/invitations'));
  });

  it('offers pending invitations and starts the existing OTP/approval flow', async () => {
    vi.mocked(api).mockResolvedValueOnce([{ id: 'inv', householdId: 'c', householdName: 'Grandparents', invitedBy: 'Nana', expiresAt: new Date(Date.now() + 86400000).toISOString() }]).mockResolvedValueOnce({ joinRequest: { id: 'j', status: 'pending' } });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Join this home' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/invitations/accept', { method: 'POST', body: { invitationId: 'inv' } }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/join/j'));
    expect(useUi.getState().householdId).toBe('a');
  });

  it('shows an existing membership rather than asking to create another account', async () => {
    vi.mocked(api).mockResolvedValue([{ id: 'inv', householdId: 'b', householdName: '1108', invitedBy: 'Owner', expiresAt: new Date().toISOString() }]);
    view();
    expect(await screen.findByText('Already joined')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join this home' })).not.toBeInTheDocument();
  });

  it('lets existing members see a pending join without losing access to their current home', async () => {
    state.me!.joinRequests = [{ id: 'j', householdName: 'Another home', requesterVerified: false } as NonNullable<Me['joinRequests']>[number]];
    view();
    expect(screen.getByRole('link', { name: 'View request' })).toHaveAttribute('href', '/join/j');
    expect(screen.getAllByRole('button', { name: 'Open home' })).toHaveLength(2);
    await screen.findByText(/No new invitations/);
  });

  it('does not offer cross-home selection or invitation discovery on a paired display', () => {
    state.me = { kind: 'device', memberships: [{ householdId: 'a', householdName: '1108', role: 'WALL_DISPLAY', memberId: null }], session: { id: 'd', pinElevatedUntil: null } };
    const rendered = view();
    expect(rendered.container).toBeEmptyDOMElement();
    expect(api).not.toHaveBeenCalled();
  });
});
