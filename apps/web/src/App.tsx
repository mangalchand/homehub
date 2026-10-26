import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiRequestError } from './lib/api';
import { flushQueue } from './lib/offline';
import { queryClient } from './lib/queryClient';
import { useMe } from './lib/queries';
import { useUi } from './store/ui';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui/misc';
import { LoginPage } from './pages/Login';
import { OnboardingPage } from './pages/Onboarding';
import { AcceptInvite, InviteLanding, pendingInvite } from './pages/Invite';

const DashboardPage = lazy(() => import('./pages/Dashboard'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const ChoresPage = lazy(() => import('./pages/Chores'));
const ListsPage = lazy(() => import('./pages/Lists'));
const RewardsPage = lazy(() => import('./pages/Rewards'));
const PhotosPage = lazy(() => import('./pages/Photos'));
const FamilyPage = lazy(() => import('./pages/Family'));
const SettingsPage = lazy(() => import('./pages/Settings'));

function useTheme() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function useOfflineReplay() {
  useEffect(() => {
    const run = () =>
      void flushQueue((m, status) => {
        if (status === 409) toast.warning('An offline change conflicted with a newer edit and was skipped.');
        else if (status >= 400) toast.error(`An offline change could not be saved (${status}).`);
      }).then(() => queryClient.invalidateQueries());
    window.addEventListener('online', run);
    run();
    return () => window.removeEventListener('online', run);
  }, []);
}

const Loading = () => (
  <div className="flex h-full items-center justify-center text-muted-foreground">
    <Spinner />
  </div>
);

export function App() {
  useTheme();
  useOfflineReplay();
  const me = useMe();
  const loc = useLocation();
  const { householdId, setHousehold } = useUi();

  useEffect(() => {
    const ms = me.data?.memberships ?? [];
    if (ms.length && !ms.some((m) => m.householdId === householdId)) setHousehold(ms[0]!.householdId);
  }, [me.data, householdId, setHousehold]);

  if (me.isPending) return <Loading />;
  const unauth = me.error instanceof ApiRequestError && me.error.status === 401;
  if (unauth || !me.data) {
    if (me.error && !unauth) {
      return <div className="p-8 text-center text-muted-foreground">Can’t reach FamilyHub right now. Retrying when you’re back online…</div>;
    }
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InviteLanding />} />
        <Route path="*" element={<Navigate to="/login" state={{ from: loc.pathname }} replace />} />
      </Routes>
    );
  }
  if (loc.pathname.startsWith('/invite/')) return <Routes><Route path="/invite/:token" element={<AcceptInvite />} /></Routes>;
  if (pendingInvite()) return <AcceptInvite />;
  if (!me.data.memberships.length) return <OnboardingPage />;
  if (!householdId) return <Loading />;

  return (
    <AppShell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/chores" element={<ChoresPage />} />
          <Route path="/lists" element={<ListsPage />} />
          <Route path="/lists/:listId" element={<ListsPage />} />
          <Route path="/rewards" element={<RewardsPage />} />
          <Route path="/photos" element={<PhotosPage />} />
          <Route path="/family" element={<FamilyPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
