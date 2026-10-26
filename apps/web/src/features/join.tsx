import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Clock, Home, MailCheck, MonitorSmartphone, ShieldCheck, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, hh } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { useHhMutation, useJoinRequests, type JoinRequestDTO } from '@/lib/queries';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, IconTile } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Avatar, Badge, Spinner } from '@/components/ui/misc';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADULT_ADMIN: 'Parent (admin)', ADULT: 'Adult', CHILD: 'Child', GUEST: 'Guest / caregiver' };

export function CodeInput({ value, onChange, autoFocus, className }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; className?: string }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="••••••"
      aria-label="6-digit code"
      autoFocus={autoFocus}
      className={cn('h-14 text-center font-display text-2xl font-semibold tracking-[0.5em] sm:h-14 sm:text-2xl', className)}
    />
  );
}

function useCooldown() {
  const [until, setUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  return { left, start: () => setUntil(Date.now() + 30_000) };
}

const signOut = async () => {
  await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
  await queryClient.resetQueries();
};

function AuthFrame({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center px-4 pb-10 pt-[max(3rem,env(safe-area-inset-top))] sm:items-center sm:pt-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary [&_svg]:h-7 [&_svg]:w-7">{icon}</span>
          <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
        </div>
        <Card>
          <CardContent className="space-y-5 p-5 sm:p-6">{children}</CardContent>
        </Card>
        <button className="mt-5 w-full text-center text-sm text-muted-foreground hover:text-foreground" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

/** Shown after sign-up until the emailed code is entered. */
export function VerifyEmailPage({ email }: { email: string }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const cool = useCooldown();
  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/v1/auth/verify-email', { method: 'POST', body: { code } });
      toast.success('Email confirmed');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast.error((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    try {
      await api('/api/v1/auth/verify-email/resend', { method: 'POST' });
      cool.start();
      toast.success('New code sent');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <AuthFrame icon={<MailCheck />} title="Confirm your email">
      <p className="text-center text-[15px] leading-relaxed text-muted-foreground">
        Enter the 6-digit code from the latest email to <span className="break-all font-semibold text-foreground">{email}</span> to finish creating your account.
      </p>
      <form onSubmit={verify} className="space-y-3">
        <CodeInput value={code} onChange={setCode} autoFocus />
        <Button type="submit" size="lg" className="w-full" disabled={code.length !== 6 || busy}>
          {busy ? <Spinner className="h-4 w-4" /> : 'Confirm'}
        </Button>
      </form>
      <div className="rounded-xl bg-muted/70 p-3 text-sm leading-relaxed text-muted-foreground">
        Didn’t get it? Check Spam or Promotions. In AWS SES sandbox, your email address must first be verified with AWS. You can also{' '}
        <button className="font-semibold text-primary disabled:text-muted-foreground" disabled={cool.left > 0} onClick={() => void resend()}>
          {cool.left > 0 ? `send again in ${cool.left}s` : 'send a new code'}
        </button>
        .
      </div>
    </AuthFrame>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold', done ? 'bg-emerald-500 text-white' : 'bg-primary/10 text-primary')}>
        {done ? <Check className="h-4 w-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pt-1">
        <p className="font-semibold leading-snug">{title}</p>
        {children}
      </div>
    </div>
  );
}

/** The person joining: confirm with their code, then wait for the household to approve. */
export function JoinPendingPage({ request, allowBack = false }: { request: JoinRequestDTO; allowBack?: boolean }) {
  const setHousehold = useUi((s) => s.setHousehold);
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const cool = useCooldown();
  const mine = useQuery({ queryKey: ['join', 'mine'], queryFn: () => api<JoinRequestDTO[]>('/api/v1/join-requests/mine'), refetchInterval: 5000 });
  const r = mine.data?.find((x) => x.id === request.id) ?? request;

  useEffect(() => {
    if (r.status === 'approved') {
      setHousehold(r.householdId);
      toast.success(`Welcome to ${r.householdName ?? 'the family'}!`);
      void queryClient.invalidateQueries().then(() => navigate('/', { replace: true }));
    }
  }, [r.status, r.householdId, r.householdName, setHousehold, navigate]);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/v1/join-requests/${r.id}/verify`, { method: 'POST', body: { code } });
      await Promise.all([mine.refetch(), queryClient.invalidateQueries({ queryKey: ['me'] })]);
    } catch (err) {
      toast.error((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    try {
      await api(`/api/v1/join-requests/${r.id}/resend`, { method: 'POST' });
      cool.start();
      toast.success('New code sent');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (r.status === 'rejected' || r.status === 'expired') {
    return (
      <AuthFrame icon={<X />} title={r.status === 'rejected' ? 'Request declined' : 'Request expired'}>
        <p className="text-center text-[15px] leading-relaxed text-muted-foreground">
          {r.status === 'rejected' ? `${r.householdName ?? 'The household'} didn’t approve this request.` : 'This request is more than 7 days old.'} Ask them to send you a new invitation if this was a mistake.
        </p>
        <Button className="w-full" onClick={() => void queryClient.invalidateQueries({ queryKey: ['me'] })}>Continue</Button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame icon={<Home />} title={`Join ${r.householdName ?? 'the family'}`}>
      <p className="text-center text-[15px] leading-relaxed text-muted-foreground">To keep your family safe, both you and the household confirm this request.</p>
      <div className="space-y-5">
        <Step n={1} done={r.requesterVerified} title="Confirm it’s you">
          {!r.requesterVerified && (
            <>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Enter the code we emailed to <span className="break-all font-medium text-foreground">{r.email}</span>.
              </p>
              <form onSubmit={verify} className="space-y-2">
                <CodeInput value={code} onChange={setCode} autoFocus />
                <Button type="submit" className="w-full" disabled={code.length !== 6 || busy}>Confirm</Button>
              </form>
              <button className="text-sm font-semibold text-primary disabled:text-muted-foreground" disabled={cool.left > 0} onClick={() => void resend()}>
                {cool.left > 0 ? `Send again in ${cool.left}s` : 'Send a new code'}
              </button>
            </>
          )}
        </Step>
        <Step n={2} done={r.approved} title="Approval from the household">
          {!r.approved && (
            <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> A parent/admin enters the code we emailed them, <b className="font-semibold text-foreground">or</b></p>
              <p className="flex items-start gap-2"><MonitorSmartphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> someone taps <b className="font-semibold text-foreground">Approve</b> on the home display.</p>
              <p className="flex items-center gap-2 pt-1 text-foreground"><Spinner className="h-4 w-4 text-primary" /> Waiting for approval…</p>
            </div>
          )}
        </Step>
      </div>
      {allowBack && <Button variant="outline" className="w-full" asChild><Link to="/homes">Back to my homes</Link></Button>}
    </AuthFrame>
  );
}

function RequestRow({ r, isDevice }: { r: JoinRequestDTO; isDevice: boolean }) {
  const [code, setCode] = useState('');
  const done = { onError: (e: unknown) => toast.error((e as Error).message) };
  const approve = useHhMutation<void, JoinRequestDTO>((hid) => api(hh(hid, `/join-requests/${r.id}/approve`), { method: 'POST', body: isDevice ? {} : { code } }), [['join'], ['members']]);
  const reject = useHhMutation<void>((hid) => api(hh(hid, `/join-requests/${r.id}/reject`), { method: 'POST' }), [['join']]);
  const resend = useHhMutation<void>((hid) => api(hh(hid, `/join-requests/${r.id}/resend`), { method: 'POST' }), []);
  const onApprove = () =>
    approve.mutate(undefined, {
      ...done,
      onSuccess: (res) => {
        setCode('');
        toast.success(res.status === 'approved' ? `${r.displayName} joined the family` : `Approved. ${r.displayName} still needs to enter their code.`);
      },
    });
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-3.5">
      <div className="flex items-start gap-3">
        <Avatar name={r.displayName} color="#6366f1" size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">{r.displayName}</p>
          <p className="break-all text-sm text-muted-foreground">{r.email}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone="muted">{ROLE_LABEL[r.role] ?? r.role}</Badge>
            <Badge tone={r.requesterVerified ? 'success' : 'warning'}>{r.requesterVerified ? <><Check className="h-3 w-3" /> They confirmed</> : <><Clock className="h-3 w-3" /> Waiting for their code</>}</Badge>
            {r.approved && <Badge tone="success"><Check className="h-3 w-3" /> Approved</Badge>}
          </div>
        </div>
      </div>
      {!r.approved && (
        isDevice ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="lg" onClick={() => reject.mutate(undefined, done)}>Decline</Button>
            <Button size="lg" onClick={onApprove} disabled={approve.isPending}><Check /> Approve</Button>
          </div>
        ) : (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onApprove(); }}>
            <p className="text-sm leading-relaxed text-muted-foreground">Enter the code we emailed you to approve, or tap Approve on the home display.</p>
            <div className="flex gap-2">
              <CodeInput value={code} onChange={setCode} className="h-11 flex-1 text-lg tracking-[0.35em] sm:h-11 sm:text-lg" />
              <Button type="submit" disabled={code.length !== 6 || approve.isPending}>Approve</Button>
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <button type="button" className="font-semibold text-primary" onClick={() => resend.mutate(undefined, { ...done, onSuccess: () => toast.success('New code sent to your email') })}>Email me a new code</button>
              <button type="button" className="font-semibold text-destructive" onClick={() => confirm(`Decline ${r.displayName}?`) && reject.mutate(undefined, done)}>Decline</button>
            </div>
          </form>
        )
      )}
    </div>
  );
}

/** Pending join requests for admins (Family page) and the home display. */
export function JoinRequestsCard({ isDevice = false, className }: { isDevice?: boolean; className?: string }) {
  const list = useJoinRequests(true).data ?? [];
  if (!list.length) return null;
  return (
    <Card className={cn('border-primary/30', className)}>
      <CardHeader>
        <CardTitle><IconTile className="bg-primary/10 text-primary"><UserPlus /></IconTile> Join requests</CardTitle>
        <Badge>{list.length}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">{list.map((r) => <RequestRow key={r.id} r={r} isDevice={isDevice} />)}</CardContent>
    </Card>
  );
}

/** Floating prompt on the shared home display so someone at home can approve. */
export function DeviceJoinPrompt() {
  const list = (useJoinRequests(true).data ?? []).filter((r) => !r.approved);
  if (!list.length) return null;
  return (
    <div className="fixed inset-x-3 bottom-24 z-40 mx-auto max-w-md md:bottom-6 md:left-auto md:right-6 md:mx-0">
      <JoinRequestsCard isDevice className="shadow-lift" />
    </div>
  );
}
