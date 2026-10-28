import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailySummaryRunDTO } from '@familyhub/shared';
import { useUi } from '@/store/ui';
import { EveningSummaryPage, summaryStatusLabel } from './eveningSummary';

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mockApi, hh: (id: string, path: string) => `/api/v1/households/${id}${path}` }));

let settings = { householdId: 'home-a', dailySummaryEnabled: true, dailySummaryTime: '20:30', whatsappCallUrl: null, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', timezone: 'Asia/Kolkata', canManage: true, deliveryNote: 'Configured push is best-effort; an offline device may not receive it.' };
const payload = { title: 'Current task and points preview', body: 'Pending tasks: Laundry\nMember points: earned 12; available 7\n<img src=x onerror=alert(1)>', generatedAt: '2026-10-27T14:00:00Z' };
const run = { id: 'run-a', householdId: 'home-a', localDate: '2026-10-27', status: 'SENT', attempts: 1, claimedAt: null, leaseExpiresAt: null, nextAttemptAt: null, payload: { ...payload, title: 'Original saved snapshot' }, sentAt: '2026-10-27T15:00:00Z', createdAt: '2026-10-27T15:00:00Z', updatedAt: '2026-10-27T15:00:00Z' } satisfies DailySummaryRunDTO;
let client: QueryClient;

beforeEach(() => {
  useUi.setState({ householdId: 'home-a' });
  settings = { ...settings, dailySummaryEnabled: true, dailySummaryTime: '20:30', canManage: true };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockApi.mockReset().mockImplementation(async (path: string, options?: { method: string; body: Partial<typeof settings> }) => {
    if (path.endsWith('/settings')) {
      if (options?.method === 'PATCH') settings = { ...settings, ...options.body };
      return { ...settings };
    }
    if (path.endsWith('/preview')) return { payload, localDate: '2026-10-27', timezone: settings.timezone };
    if (path.includes('?before=')) return { runs: [{ ...run, id: 'old', localDate: '2026-10-26', status: 'FAILED', nextAttemptAt: '2026-10-26T15:10:00Z' }], nextBefore: null };
    return { runs: [run], nextBefore: '2026-10-27', deliveryNote: settings.deliveryNote };
  });
});
afterEach(() => { cleanup(); client.clear(); });

function mount() {
  return render(<QueryClientProvider client={client}><MemoryRouter><EveningSummaryPage /></MemoryRouter></QueryClientProvider>);
}

describe('daily summary page', () => {
  it('shows timezone/home-management link, saved snapshots, preview and truthful delivery status as plain text', async () => {
    const { container } = mount();
    expect(await screen.findByText('Asia/Kolkata')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change timezone in Home Management' })).toHaveAttribute('href', '/home-management');
    expect(screen.getByText('Current task and points preview')).toBeInTheDocument();
    expect(screen.getByText('Original saved snapshot')).toBeInTheDocument();
    expect(screen.getByText(/Saved in-app · push best-effort/)).toBeInTheDocument();
    expect(screen.getByText(/offline device may not receive it/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(/<img src=x/)).toHaveLength(2);
  });

  it('allows a server-authorized owner/admin or elevated display to change enable/time settings only', async () => {
    mount();
    const enabled = await screen.findByRole('checkbox', { name: 'Daily summaries enabled' });
    fireEvent.click(enabled);
    fireEvent.change(screen.getByLabelText('Daily summary time'), { target: { value: '21:45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/api/v1/households/home-a/summaries/settings', { method: 'PATCH', body: { dailySummaryEnabled: false, dailySummaryTime: '21:45' } }));
    await waitFor(() => expect(settings.dailySummaryTime).toBe('21:45'));
    expect(settings.timezone).toBe('Asia/Kolkata');
  });

  it('makes schedules read-only when the server denies management and offers no send action', async () => {
    settings.canManage = false;
    mount();
    expect(await screen.findByRole('checkbox', { name: 'Daily summaries enabled' })).toBeDisabled();
    expect(screen.getByLabelText('Daily summary time')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save schedule' })).toBeNull();
    expect(screen.getByText(/Read-only. An owner/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
  });

  it('renders mutation failures without implying the schedule was saved', async () => {
    mount();
    await screen.findByRole('button', { name: 'Save schedule' });
    mockApi.mockImplementation(async (path: string, options?: { method: string }) => {
      if (options?.method === 'PATCH') throw new Error('PIN expired; unlock the display');
      if (path.endsWith('/settings')) return settings;
      if (path.endsWith('/preview')) return { payload };
      return { runs: [run], nextBefore: null };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PIN expired; unlock the display');
    expect(screen.queryByText('Schedule saved.')).toBeNull();
  });

  it('paginates saved history and labels every durable state without promising a push receipt', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Older summaries' }));
    expect(await screen.findByText(/2026-10-26 — In-app creation failed/)).toBeInTheDocument();
    expect(screen.getByText(/Next in-app retry:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Latest' }));
    expect(await screen.findByText(/2026-10-27 — Saved in-app/)).toBeInTheDocument();
    expect(Object.keys(summaryStatusLabel)).toHaveLength(5);
  });

  it('does not show the prior household preview while switching homes and handles no selected household', async () => {
    mount();
    await screen.findByText('Original saved snapshot');
    mockApi.mockImplementation(() => new Promise(() => {}));
    act(() => useUi.setState({ householdId: 'home-b' }));
    expect(screen.queryByText('Original saved snapshot')).toBeNull();
    expect(screen.queryByText('Current task and points preview')).toBeNull();
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    act(() => useUi.setState({ householdId: null }));
    expect(screen.getByText('Select a household to view daily summaries.')).toBeInTheDocument();
  });
});
