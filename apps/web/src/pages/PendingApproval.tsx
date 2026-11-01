import { Clock3, LogOut, RefreshCw, ShieldX } from 'lucide-react';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** Shown while the FamilyHub owner has not yet approved a new account or home. */
export function PendingApprovalPage({ status, homeName }: { status: string; homeName?: string }) {
  const rejected = status === 'REJECTED';
  const what = homeName ? 'Your new home “' + homeName + '”' : 'Your account';
  const logout = async () => {
    await api('/api/v1/auth/logout', { method: 'POST' });
    queryClient.clear();
    window.location.href = '/login';
  };
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-6 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
            {rejected ? <ShieldX className="h-8 w-8" /> : <Clock3 className="h-8 w-8" />}
          </span>
          <h1 className="font-display text-2xl font-bold leading-tight">{rejected ? 'Not approved' : 'Waiting for approval'}</h1>
          <p className="text-[15px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {rejected
              ? what + ' was not approved by the FamilyHub owner.'
              : what + ' has been sent to the FamilyHub owner for approval. We’ll email you as soon as it’s approved.'}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {!rejected && (
              <Button className="flex-1" onClick={() => void queryClient.invalidateQueries({ queryKey: ['me'] })}>
                <RefreshCw /> Check again
              </Button>
            )}
            <Button variant="secondary" className="flex-1" onClick={() => void logout()}>
              <LogOut /> Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
