import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiRequestError, resetCsrf } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Mode = 'login' | 'register' | 'device';

export function LoginPage({ initialMode = 'login', initialEmail = '', banner }: { initialMode?: Mode; initialEmail?: string; banner?: string } = {}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [form, setForm] = useState({ email: initialEmail, password: '', displayName: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [loginMethod, setLoginMethod] = useState<'password' | 'code'>('password');
  const [codeSent, setCodeSent] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'login') {
        if (loginMethod === 'code') {
          if (!codeSent) {
            await api('/api/v1/auth/login-code/request', { method: 'POST', body: { email: form.email } });
            setCodeSent(true);
            return;
          }
          await api('/api/v1/auth/login-code/verify', { method: 'POST', body: { email: form.email, code: form.code } });
        } else {
          await api('/api/v1/auth/login', { method: 'POST', body: { email: form.email, password: form.password } });
        }
      }
      if (mode === 'register') await api('/api/v1/auth/register', { method: 'POST', body: { email: form.email, password: form.password, displayName: form.displayName } });
      if (mode === 'device') await api('/api/v1/auth/device/pair', { method: 'POST', body: { code: form.code } });
      resetCsrf();
      await queryClient.resetQueries({ queryKey: ['me'] });
    } catch (err) {
      toast.error((err as Error).message);
      if (mode === 'register' && err instanceof ApiRequestError && err.code === 'EMAIL_DELIVERY_FAILED') await queryClient.resetQueries({ queryKey: ['me'] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-start justify-center px-4 pb-10 pt-[max(2.5rem,env(safe-area-inset-top))] sm:items-center sm:py-10">
      <div className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <img src="/icon.svg" alt="" className="h-14 w-14 rounded-2xl" />
          <h1 className="font-display text-[28px] font-bold leading-tight tracking-tight">FamilyHub Pro</h1>
          <p className="text-[15px] text-muted-foreground">One calm place for your family’s days.</p>
        </div>
        <Card>
          <CardContent className="p-5 sm:p-6">
            {banner && <p className="mb-5 rounded-xl border border-primary/20 bg-primary/5 p-3.5 text-sm leading-relaxed text-foreground">{banner}</p>}
            <div className="mb-6 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1 text-[13px] sm:text-sm" role="tablist">
              {(['login', 'register', 'device'] as Mode[]).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn('rounded-lg px-1 py-2 font-semibold leading-tight text-muted-foreground transition-colors', mode === m && 'bg-card text-foreground shadow-sm')}>
                  {m === 'login' ? 'Sign in' : m === 'register' ? 'Create account' : 'Home display'}
                </button>
              ))}
            </div>
            {mode === 'login' && <div className="mb-5 flex gap-2" aria-label="Sign-in method">
              {(['password', 'code'] as const).map((method) => <Button key={method} type="button" variant={loginMethod === method ? 'secondary' : 'ghost'} className="flex-1" aria-pressed={loginMethod === method} onClick={() => { setLoginMethod(method); setCodeSent(false); setForm((f) => ({ ...f, code: '' })); }}>{method === 'password' ? 'Password' : 'Email code (OTP)'}</Button>)}
            </div>}
            <form onSubmit={submit} className="space-y-4">
              {mode === 'device' ? (
                <>
                  <div className="flex gap-3 rounded-xl bg-muted/70 p-3.5 text-sm leading-relaxed text-muted-foreground">
                    <MonitorSmartphone className="h-5 w-5 shrink-0" />
                    In FamilyHub on your phone, open Settings → Devices → “Pair a display” and enter the code shown there.
                  </div>
                  <Field label="Pairing code">
                    <Input value={form.code} onChange={set('code')} placeholder="ABCD-1234" className="h-14 text-center text-2xl uppercase tracking-widest" autoFocus required />
                  </Field>
                </>
              ) : (
                <>
                  {mode === 'register' && (
                    <Field label="Your name">
                      <Input value={form.displayName} onChange={set('displayName')} autoComplete="name" required />
                    </Field>
                  )}
                  <Field label="Email">
                    <Input type="email" value={form.email} onChange={(e) => { set('email')(e); setCodeSent(false); }} autoComplete="email" required autoFocus />
                  </Field>
                  {mode === 'login' && loginMethod === 'code' ? (codeSent && <Field label="Email code" hint="If an account exists, we emailed a code valid for 15 minutes. Check Spam too. In SES sandbox, your address must first be verified by AWS.">
                    <Input value={form.code} onChange={set('code')} inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" placeholder="6-digit code" required />
                  </Field>) : (
                  <Field label="Password" hint={mode === 'register' ? 'At least 10 characters. We’ll email you a 6-digit code to confirm your account.' : undefined}>
                    <Input type="password" value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 10 : undefined} required />
                  </Field>
                  )}
                </>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                {mode === 'login' ? (loginMethod === 'code' && !codeSent ? 'Email me a code' : 'Sign in') : mode === 'register' ? 'Create account' : 'Pair this display'}
              </Button>
              {mode === 'login' && loginMethod === 'code' && codeSent && <Button type="button" variant="ghost" className="w-full" onClick={() => { setCodeSent(false); setForm((f) => ({ ...f, code: '' })); }}>Request a new code</Button>}
            </form>
            {import.meta.env.DEV && mode === 'login' && (
              <button className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setForm((f) => ({ ...f, email: 'demo@familyhub.local', password: 'FamilyHub!2024' }))}>
                Use demo account
              </button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
