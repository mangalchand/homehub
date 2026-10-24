import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { CalendarDays, Gift, Images, LayoutGrid, Lock, Maximize, Moon, Settings, ShoppingBasket, Sparkles, Sun, Unlock, Users, WifiOff } from 'lucide-react';
import { Screensaver } from '@/features/photos';
import { Avatar } from './ui/misc';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { onQueueChange, pendingCount } from '@/lib/offline';
import { useHousehold, useMe, useRole } from '@/lib/queries';
import { useOnline, useRealtime } from '@/lib/realtime';
import { queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { useUi } from '@/store/ui';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Input } from './ui/input';

const NAV = [
  { to: '/', label: 'Home', icon: LayoutGrid, end: true },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/chores', label: 'Chores', icon: Sparkles },
  { to: '/lists', label: 'Lists', icon: ShoppingBasket },
  { to: '/photos', label: 'Photos', icon: Images },
  { to: '/rewards', label: 'Rewards', icon: Gift },
  { to: '/family', label: 'Family', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
];
const MOBILE_NAV = ['/', '/calendar', '/chores', '/lists', '/photos'];

function useNightMode() {
  const { displayMode, autoNight, nightStart, nightEnd } = useUi();
  const [hour, setHour] = useState(new Date().getHours());
  useEffect(() => {
    const t = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);
  const inWindow = nightStart > nightEnd ? hour >= nightStart || hour < nightEnd : hour >= nightStart && hour < nightEnd;
  return displayMode === 'night' || (autoNight && inWindow);
}

export function PinDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { householdId } = useUi();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(hh(householdId!, '/pin/verify'), { method: 'POST', body: { pin } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.success('Parent mode unlocked');
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setPin('');
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Enter household PIN" description="Unlocks adult actions on this shared screen for a few minutes.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <Input autoFocus inputMode="numeric" pattern="\d*" maxLength={8} type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className="h-14 text-center text-2xl tracking-[0.5em]" aria-label="PIN" />
        <Button type="submit" className="w-full" size="lg" disabled={pin.length < 4 || busy}>
          Unlock
        </Button>
      </form>
    </Dialog>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { householdId, setHousehold, displayMode, setDisplayMode } = useUi();
  const me = useMe().data!;
  const household = useHousehold().data;
  const { isDevice, elevated } = useRole();
  const online = useOnline();
  const live = useRealtime(householdId);
  const night = useNightMode();
  const navigate = useNavigate();
  const [queued, setQueued] = useState(0);
  const [pinOpen, setPinOpen] = useState(false);
  const kiosk = displayMode === 'kiosk' || isDevice;

  useEffect(() => {
    void pendingCount().then(setQueued);
    return onQueueChange(setQueued) as () => void;
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('night', night);
  }, [night]);

  const lock = async () => {
    await api(hh(householdId!, '/pin/lock'), { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  };

  return (
    <div className="flex h-full min-h-screen">
      <aside className={cn('sticky top-0 hidden h-screen shrink-0 flex-col p-3 md:flex', kiosk ? 'w-[88px]' : 'w-64')}>
        <div className="glass flex h-full flex-col rounded-[28px] p-3 shadow-soft">
        <div className="mb-6 flex items-center gap-3 px-1.5 pt-1.5">
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-2xl shadow-glow" />
          {!kiosk && (
            <div className="min-w-0">
              <p className="truncate font-display text-[15px] font-extrabold tracking-tight">FamilyHub <span className="text-gradient">Pro</span></p>
              {me.memberships.length > 1 ? (
                <select className="w-full truncate bg-transparent text-xs text-muted-foreground" value={householdId ?? ''} onChange={(e) => setHousehold(e.target.value)} aria-label="Household">
                  {me.memberships.map((m) => (
                    <option key={m.householdId} value={m.householdId}>
                      {m.householdName}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="truncate text-xs text-muted-foreground">{household?.name}</p>
              )}
            </div>
          )}
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                cn('group relative flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-semibold text-muted-foreground transition-all hover:bg-primary/5 hover:text-foreground', kiosk && 'justify-center px-0 py-3.5', isActive && 'brand-gradient text-white shadow-glow hover:bg-transparent hover:text-white')
              }
            >
              <Icon className={kiosk ? 'h-6 w-6' : 'h-[19px] w-[19px]'} strokeWidth={2.2} />
              {!kiosk && label}
            </NavLink>
          ))}
        </nav>
        {!kiosk && me.kind !== 'device' && me.user && (
          <div className="mb-2 flex items-center gap-2.5 rounded-2xl bg-muted/60 p-2.5">
            <Avatar name={me.user.displayName ?? me.user.email} color="#6d4aff" size={34} />
            <div className="min-w-0 text-xs"><p className="truncate font-semibold">{me.user.displayName}</p><p className="truncate text-muted-foreground">{me.user.email}</p></div>
          </div>
        )}
        <div className={cn('flex gap-1', kiosk ? 'flex-col items-center' : 'flex-wrap')}>
          {isDevice && (
            <Button variant="ghost" size="icon" title={elevated ? 'Lock parent mode' : 'Parent mode'} onClick={() => (elevated ? void lock() : setPinOpen(true))}>
              {elevated ? <Unlock className="text-emerald-500" /> : <Lock />}
            </Button>
          )}
          <Button variant="ghost" size="icon" title="Night mode" onClick={() => setDisplayMode(displayMode === 'night' ? 'standard' : 'night')}>
            {displayMode === 'night' ? <Sun /> : <Moon />}
          </Button>
          {!isDevice && (
            <Button
              variant="ghost"
              size="icon"
              title="Kiosk mode"
              onClick={() => {
                const next = displayMode === 'kiosk' ? 'standard' : 'kiosk';
                setDisplayMode(next);
                if (next === 'kiosk') {
                  void document.documentElement.requestFullscreen?.().catch(() => undefined);
                  navigate('/');
                } else if (document.fullscreenElement) void document.exitFullscreen();
              }}
            >
              <Maximize />
            </Button>
          )}
        </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {(!online || queued > 0) && (
          <div className="flex items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300" role="status">
            <WifiOff className="h-3.5 w-3.5" />
            {!online ? 'Offline — showing saved data. Changes will sync when you reconnect.' : `Syncing ${queued} offline change${queued === 1 ? '' : 's'}…`}
          </div>
        )}
        <main className={cn('mx-auto w-full max-w-[1600px] flex-1 p-4 pb-28 md:p-6 md:pb-6', kiosk && 'md:p-5')}>{children}</main>
        <span className="sr-only" aria-live="polite">
          {live ? 'Live updates connected' : 'Live updates reconnecting'}
        </span>
      </div>

      <nav className="glass fixed inset-x-3 bottom-3 z-30 flex justify-around rounded-[26px] px-1 pb-[env(safe-area-inset-bottom)] shadow-lift md:hidden" aria-label="Mobile">
        {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold text-muted-foreground transition-colors', isActive && 'text-primary')}>
            {({ isActive }) => (<><span className={cn('rounded-xl px-3 py-1 transition-all', isActive && 'bg-primary/10')}><Icon className="h-5 w-5" strokeWidth={2.2} /></span>{label}</>)}
          </NavLink>
        ))}
        <NavLink to="/settings" className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold text-muted-foreground', isActive && 'text-primary')}>
          <span className="px-3 py-1"><Settings className="h-5 w-5" strokeWidth={2.2} /></span>
          More
        </NavLink>
      </nav>
      <PinDialog open={pinOpen} onOpenChange={setPinOpen} />
      <Screensaver enabled={kiosk} idleMinutes={5} />
    </div>
  );
}
