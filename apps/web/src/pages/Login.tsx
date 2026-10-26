import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { api, resetCsrf } from '@/lib/api';
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
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'login') await api('/api/v1/auth/login', { method: 'POST', body: { email: form.email, password: form.password } });
      if (mode === 'register') await api('/api/v1/auth/register', { method: 'POST', body: { email: form.email, password: form.password, displayName: form.displayName } });
      if (mode === 'device') await api('/api/v1/auth/device/pair', { method: 'POST', body: { code: form.code } });
      resetCsrf();
      await queryClient.resetQueries({ queryKey: ['me'] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-50 via-background to-amber-50 p-4 dark:from-indigo-950/40 dark:to-background">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/icon.svg" alt="" className="h-16 w-16 drop-shadow" />
          <h1 className="text-3xl font-bold tracking-tight">FamilyHub Pro</h1>
          <p className="text-muted-foreground">One calm place for your family’s days.</p>
        </div>
        <Card>
          <CardContent className="p-6">
            {banner && <p className="mb-4 rounded-xl bg-primary/10 p-3 text-sm text-foreground">{banner}</p>}
            <div className="mb-6 grid grid-cols-3 rounded-xl bg-muted p-1 text-sm" role="tablist">
              {(['login', 'register', 'device'] as Mode[]).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn('rounded-lg py-1.5 font-medium text-muted-foreground', mode === m && 'bg-card text-foreground shadow-sm')}>
                  {m === 'login' ? 'Sign in' : m === 'register' ? 'Create account' : 'Wall display'}
                </button>
              ))}
            </div>
            <form onSubmit={submit} className="space-y-4">
              {mode === 'device' ? (
                <>
                  <div className="flex gap-3 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
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
                    <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" required autoFocus />
                  </Field>
                  <Field label="Password" hint={mode === 'register' ? 'At least 10 characters' : undefined}>
                    <Input type="password" value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 10 : undefined} required />
                  </Field>
                </>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Pair this display'}
              </Button>
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
