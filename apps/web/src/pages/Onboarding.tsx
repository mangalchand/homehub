import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { useUi } from '@/store/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';

const ZONES = Intl.supportedValuesOf?.('timeZone') ?? ['UTC'];

export function OnboardingPage() {
  const setHousehold = useUi((s) => s.setHousehold);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const h = await api<{ id: string }>('/api/v1/households', { method: 'POST', body: { name, timezone } });
      setHousehold(h.id);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    await api('/api/v1/auth/logout', { method: 'POST' });
    await queryClient.resetQueries();
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-6">
          <div>
            <h1 className="text-2xl font-bold">Set up your household</h1>
            <p className="text-sm text-muted-foreground">You can invite your family and connect calendars next. If someone invited you, open their invitation link instead.</p>
          </div>
          <form onSubmit={create} className="space-y-4">
            <Field label="Household name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="The Rivera Family" required autoFocus />
            </Field>
            <Field label="Time zone">
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {ZONES.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </Select>
            </Field>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              Create household
            </Button>
          </form>
          <button className="w-full text-xs text-muted-foreground hover:underline" onClick={() => void logout()}>
            Sign out
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
