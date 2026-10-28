import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { whatsappCallUrlSchema } from '@familyhub/shared';
import { ExternalLink, Phone } from 'lucide-react';
import { api, hh } from '@/lib/api';
import { useHid, useRole } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, IconTile } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';

export interface FamilyCallSettings {
  whatsappCallUrl: string | null;
}
export const familyCallQueryKey = (householdId: string) => ['family-call', householdId] as const;

export function FamilyCallCard() {
  const hid = useHid();
  const { isAdmin } = useRole();
  if (!hid) return null;
  return <HouseholdFamilyCallCard key={hid} householdId={hid} canManage={isAdmin} />;
}

function HouseholdFamilyCallCard({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const id = useId();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const settings = useQuery({
    queryKey: familyCallQueryKey(householdId),
    queryFn: () => api<FamilyCallSettings>(hh(householdId, '/family-call')),
    staleTime: 0,
    gcTime: 0,
  });
  const save = useMutation({
    mutationFn: (whatsappCallUrl: string | null) =>
      api<FamilyCallSettings>(hh(householdId, '/family-call'), {
        method: 'PATCH',
        body: { whatsappCallUrl },
      }),
    onSuccess: (data) => {
      qc.setQueryData(familyCallQueryKey(householdId), data);
      setDraft(null);
      setError('');
      setStatus(data.whatsappCallUrl ? 'Call link saved.' : 'Call link removed from FamilyHub.');
      void qc.invalidateQueries({ queryKey: familyCallQueryKey(householdId) });
    },
    onError: (err: Error) => {
      setError(err.message);
      setStatus('');
    },
  });
  const parsed = whatsappCallUrlSchema.safeParse(settings.data?.whatsappCallUrl);
  const url = !settings.isError && parsed.success ? parsed.data : null;
  const ready = settings.isSuccess;
  const value = draft ?? settings.data?.whatsappCallUrl ?? '';

  const submit = () => {
    const result = whatsappCallUrlSchema.safeParse(value);
    setStatus('');
    if (!result.success) {
      setError(
        'Paste an exact https://call.whatsapp.com/voice/… or /video/… link without spaces, query parameters or fragments (maximum 500 characters).',
      );
      return;
    }
    setError('');
    save.mutate(result.data);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <IconTile className="bg-emerald-500/10 text-emerald-600">
            <Phone />
          </IconTile>{' '}
          Family call
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Open the family’s WhatsApp call link, then tap Join in WhatsApp. Everyone joins individually; this
          does not automatically ring the whole family.
        </p>
        {settings.isPending && <p role="status">Loading family call…</p>}
        {settings.isError && (
          <div role="alert" className="space-y-2 text-sm">
            <p>Could not load the family call link. {settings.error.message}</p>
            <Button variant="outline" onClick={() => void settings.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {url && (
          <Button asChild size="lg">
            <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
              <Phone /> Join family {url.includes('/video/') ? 'video' : 'voice'} call <ExternalLink />
            </a>
          </Button>
        )}
        {ready && !settings.data.whatsappCallUrl && (
          <p className="text-sm">
            No family call link yet.{' '}
            {canManage
              ? 'Set one up below.'
              : 'Ask a household owner or admin to add one, or unlock this home display with the household PIN.'}
          </p>
        )}
        {ready && settings.data.whatsappCallUrl && !url && (
          <p role="alert" className="text-sm text-destructive">
            The saved link is invalid. Ask an owner or admin to replace or clear it.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Privacy: anyone with the link may join. Only share it with people you trust. Links expire after 30
          days without use and may be revoked by WhatsApp. Replace the saved link if it stops working.
        </p>
        {canManage && ready && (
          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <p className="text-sm">
              In WhatsApp, open Calls &gt; Create call link (or Create new call link), choose Voice or Video,
              then Copy link and paste it here. FamilyHub does not create the call.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor={id}>WhatsApp call link</Label>
              <Input
                id={id}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={500}
                value={value}
                disabled={save.isPending}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${id}-error` : undefined}
                placeholder="https://call.whatsapp.com/voice/…"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError('');
                  setStatus('');
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={save.isPending || !value}>
                Save call link
              </Button>
              {settings.data.whatsappCallUrl && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() => {
                    setError('');
                    setStatus('');
                    save.mutate(null);
                  }}
                >
                  Clear call link
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Clearing only removes the shortcut from FamilyHub; it does not revoke the WhatsApp link or end a
              call.
            </p>
          </form>
        )}
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="text-sm">
            {status}
          </p>
        )}
        <a
          className="inline-flex items-center gap-1 text-xs text-primary underline"
          href="https://faq.whatsapp.com/456694046556486/"
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          WhatsApp call-link help <ExternalLink className="h-3 w-3" />
        </a>
      </CardContent>
    </Card>
  );
}
