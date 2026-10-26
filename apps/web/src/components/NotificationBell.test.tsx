import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationBell } from './NotificationBell';

const { state, chime, toast } = vi.hoisted(() => ({ state: { data: [] as { id: string; title: string; createdAt: string; readAt: string | null; type: string }[] }, chime: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/notifications', () => ({
  useNotifications: () => ({ data: state.data, isSuccess: true }), useMarkRead: () => ({ mutate: vi.fn() }), chime, unlockNotificationAudio: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('tablet notification chime', () => {
  it('rings for the first incoming alert even if the initial inbox was empty, once only', () => {
    state.data = [];
    const view = () => <MemoryRouter><NotificationBell /></MemoryRouter>;
    const { rerender } = render(view());
    expect(chime).not.toHaveBeenCalled();
    state.data = [{ id: 'new', title: 'Added milk', createdAt: new Date().toISOString(), type: 'list.item_added', readAt: null }];
    act(() => rerender(view()));
    expect(chime).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Added milk', expect.anything());
    act(() => rerender(view()));
    expect(chime).toHaveBeenCalledTimes(1);
  });
});
