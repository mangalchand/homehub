import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { LoginPage } from './Login';
import { useUi } from '@/store/ui';
import type { JoinRequestDTO } from '@/lib/queries';

const KEY = 'fh_pending_invite';
export const pendingInvite = () => localStorage.getItem(KEY);
const clearInvite = () => localStorage.removeItem(KEY);

interface Preview { householdName: string; role: string; email: string; invitedBy: string; hasAccount?: boolean }
export interface AcceptResult { householdId?: string; alreadyMember?: boolean; joinRequest?: JoinRequestDTO }

/** Signed out: remember the invite, show who invited you, then create an account / sign in. */
export function InviteLanding() {
  const { token = '' } = useParams();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    localStorage.setItem(KEY, token);
    api<Preview>(`/api/v1/invitations/${encodeURIComponent(token)}`).then(setPreview, () => { setError(true); clearInvite(); });
  }, [token]);
  if (error) return <LoginPage banner="This invitation link has expired or was already used. Ask for a new one." />;
  if (!preview) return <div className="flex h-screen items-center justify-center"><Spinner /></div>;
  return <LoginPage initialMode={preview.hasAccount ? 'login' : 'register'} initialEmail={preview.email} banner={`${preview.invitedBy} invited you to join “${preview.householdName}”. ${preview.hasAccount ? 'You already have an account. Sign in to choose this home; no new account is needed.' : `Create your account with ${preview.email}, or sign in if you already have one.`} Joining still needs your emailed code and household approval.`} />;
}

/** Signed in with a pending invite: accept it and switch to that household. */
export function AcceptInvite() {
  const { token: param } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = param ?? pendingInvite();
    if (!token) return navigate('/', { replace: true });
    api<AcceptResult>('/api/v1/invitations/accept', { method: 'POST', body: { token } })
      .then(async (r) => {
        clearInvite();
        await queryClient.invalidateQueries({ queryKey: ['me'] });
        if (r.alreadyMember && r.householdId) useUi.getState().setHousehold(r.householdId);
        navigate(r.joinRequest?.status === 'pending' ? `/join/${r.joinRequest.id}` : '/', { replace: true });
      })
      .catch((e: Error) => { clearInvite(); setError(e.message); });
  }, [param, navigate]);
  if (!error) return <div className="flex h-screen items-center justify-center"><Spinner /></div>;
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="max-w-sm text-muted-foreground">Couldn’t accept the invitation: {error}</p>
      <Button onClick={() => { void queryClient.invalidateQueries(); navigate('/', { replace: true }); }}>Continue</Button>
    </div>
  );
}
