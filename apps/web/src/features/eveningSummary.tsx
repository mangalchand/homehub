import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DailySummaryPayload, DailySummaryRunDTO, HouseholdFeatureSettingsDTO } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { useHhMutation, useHid } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';

interface Settings extends HouseholdFeatureSettingsDTO { timezone: string; canManage: boolean; deliveryNote: string }
interface History { runs: DailySummaryRunDTO[]; nextBefore: string | null; deliveryNote: string }
interface Preview { localDate: string; timezone: string; payload: DailySummaryPayload }

export const summaryStatusLabel: Record<DailySummaryRunDTO['status'], string> = {
  PENDING: 'Queued', CLAIMED: 'Processing (lease protected)', SENT: 'Saved in-app · push best-effort',
  FAILED: 'In-app creation failed · retry scheduled today', SKIPPED: 'Skipped · disabled/rescheduled or obsolete day',
};

function ScheduleForm({ settings }: { settings: Settings }) {
  const [enabled, setEnabled] = useState(settings.dailySummaryEnabled);
  const [time, setTime] = useState(settings.dailySummaryTime);
  const save = useHhMutation<{ dailySummaryEnabled: boolean; dailySummaryTime: string }>(
    (hid, body) => api(hh(hid, '/summaries/settings'), { method: 'PATCH', body }), [['summaries']],
  );
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate({ dailySummaryEnabled: enabled, dailySummaryTime: time }); }}>
      <fieldset disabled={!settings.canManage || save.isPending} className="space-y-4">
        <label className="flex items-center gap-3"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Daily summaries enabled</label>
        <Field label="Daily summary time"><Input type="time" required value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        {settings.canManage && <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save schedule'}</Button>}
      </fieldset>
      {!settings.canManage && <p className="text-sm text-muted-foreground">Read-only. An owner, adult admin or PIN-unlocked home display can change this schedule.</p>}
      {save.isError && <p role="alert">{save.error.message}</p>}
      {save.isSuccess && <p role="status">Schedule saved.</p>}
    </form>
  );
}

function SummaryText({ payload }: { payload: DailySummaryPayload }) {
  return <div><h3 className="font-semibold">{payload.title}</h3><p className="mb-3 text-xs text-muted-foreground">Snapshot generated {new Date(payload.generatedAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{payload.body}</p></div>;
}

/** Register this exported page at /summaries inside the household AppShell. */
export function EveningSummaryPage() {
  const hid = useHid();
  return <EveningSummaryContent key={hid ?? 'no-home'} householdId={hid} />;
}

function EveningSummaryContent({ householdId: hid }: { householdId: string | null }) {
  const qc = useQueryClient();
  const [before, setBefore] = useState<string | null>(null);
  const settings = useQuery({ queryKey: ['summaries', hid, 'settings'], queryFn: () => api<Settings>(hh(hid!, '/summaries/settings')), enabled: Boolean(hid), refetchInterval: 60_000 });
  const preview = useQuery({ queryKey: ['summaries', hid, 'preview'], queryFn: () => api<Preview>(hh(hid!, '/summaries/preview')), enabled: Boolean(hid), refetchInterval: 60_000 });
  const history = useQuery({ queryKey: ['summaries', hid, 'history', before], queryFn: () => api<History>(hh(hid!, `/summaries${before ? `?before=${before}` : ''}`)), enabled: Boolean(hid), refetchInterval: 60_000 });
  if (!hid) return <p>Select a household to view daily summaries.</p>;
  return (
    <div className="space-y-6">
      <PageHeader title="Daily summaries" subtitle="Saved household tasks and points — one summary per local day" actions={<Button variant="outline" onClick={() => void qc.invalidateQueries({ queryKey: ['summaries', hid] })}>Refresh</Button>} />
      <Card><CardHeader><CardTitle>Schedule & delivery</CardTitle></CardHeader><CardContent className="space-y-4">
        {settings.isPending ? <p>Loading schedule…</p> : settings.isError ? <p role="alert">Could not load schedule: {settings.error.message}</p> : <>
          <p className="text-sm">Household timezone: <strong>{settings.data.timezone}</strong>. <Link to="/home-management" className="underline">Change timezone in Home Management</Link>.</p>
          <ScheduleForm key={`${hid}:${settings.data.updatedAt}:${settings.data.canManage}`} settings={settings.data} />
          <p className="text-sm text-muted-foreground">{settings.data.deliveryNote}</p>
          <p className="text-sm text-muted-foreground">The worker checks every minute and catches up later the same day. Failed in-app saves retry today; previous-day runs are never sent later. Changing the time does not send a second summary on a day already sent.</p>
        </>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Current preview (not sent)</CardTitle></CardHeader><CardContent>
        {preview.isPending ? <p>Loading preview…</p> : preview.isError ? <p role="alert">Could not load preview: {preview.error.message}</p> : <SummaryText payload={preview.data.payload} />}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Saved history</CardTitle></CardHeader><CardContent className="space-y-4">
        {history.isPending ? <p>Loading history…</p> : history.isError ? <p role="alert">Could not load history: {history.error.message}</p> : <>
          {!history.data.runs.length && <p>No saved summaries yet.</p>}
          {history.data.runs.map((run) => <details className="rounded-lg border p-3" key={run.id}>
            <summary className="cursor-pointer font-medium">{run.localDate} — {summaryStatusLabel[run.status]}</summary>
            <p className="my-3 text-xs text-muted-foreground">Attempts: {run.attempts}{run.nextAttemptAt ? ` · Next in-app retry: ${new Date(run.nextAttemptAt).toLocaleString()}` : ''}</p>
            {run.payload ? <SummaryText payload={run.payload} /> : <p>No snapshot saved yet.</p>}
          </details>)}
          <div className="flex gap-2">{before && <Button variant="outline" onClick={() => setBefore(null)}>Latest</Button>}{history.data.nextBefore && <Button variant="outline" onClick={() => setBefore(history.data.nextBefore)}>Older summaries</Button>}</div>
        </>}
      </CardContent></Card>
    </div>
  );
}

export default EveningSummaryPage;
