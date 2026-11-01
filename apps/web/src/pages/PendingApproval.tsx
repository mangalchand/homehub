import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock3, Home, LogOut, RefreshCw, Send, ShieldX } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** Shown while the FamilyHub owner has not yet approved a new account or home. */
export function PendingApprovalPage({ status, homeName }: { status: string; homeName?: string }) {
  const rejected = status === 'REJECTED';
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const resend = async () => {
    setSending(true);
    try {
      const r = await api<{ requested: number; sent: number }>('/api/v1/approval-requests/resend', { method: 'POST' });
      if (r.requested && r.sent === r.requested) toast.success('Sent the approval request to the FamilyHub owner again');
      else toast.error('The approval email could not be sent. Please try again later.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSending(false);
    }
  };
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
            {!rejected && (
              <Button variant="secondary" className="flex-1" disabled={sending} onClick={() => void resend()}>
                <Send /> Resend request
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {homeName && (
              <Button variant="ghost" className="flex-1" onClick={() => navigate('/homes')}>
                <Home /> Homes &amp; invitations
              </Button>
            )}
            <Button variant="ghost" className="flex-1" onClick={() => void logout()}>
              <LogOut /> Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
