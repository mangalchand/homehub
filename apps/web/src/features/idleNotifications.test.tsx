import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Screensaver } from './photos';
import { MemoryRouter } from 'react-router-dom';

const { data } = vi.hoisted(() => ({ data: [
  { id: 'one', title: 'Added to groceries', body: 'Milk', readAt: null, createdAt: new Date().toISOString() },
  { id: 'two', title: 'Already read', body: '', readAt: new Date().toISOString(), createdAt: new Date().toISOString() },
] }));
vi.mock('@/lib/notifications', () => ({ useNotifications: () => ({ data }) }));
vi.mock('@/lib/queries', () => ({ useHousehold: () => ({ data: { timezone: 'UTC' } }), usePhotos: () => ({ data: [] }) }));

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('photo-frame alerts', () => {
  it('shows unread alerts and the count without waking the photo frame', () => {
    vi.useFakeTimers();
    render(<MemoryRouter><Screensaver idleMinutes={5} enabled /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Added to groceries')).toBeInTheDocument();
    expect(screen.getByText('Milk')).toBeInTheDocument();
    expect(screen.getByText('New notification')).toBeInTheDocument();
    expect(screen.queryByText('Already read')).toBeNull();
    const sos = screen.getByRole('link', { name: 'Panic / SOS' });
    expect(sos).toHaveAttribute('href', '/safety');
    fireEvent.pointerDown(sos);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(sos);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
