import { useState } from 'react';
import { MAX_TIMES_PER_DAY, WEEKDAY_PRESETS, type ScheduleInput } from '@familyhub/shared';
import { Field, Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export type ScheduleDraft = ScheduleInput;
export const emptySchedule: ScheduleDraft = { repeatDaily: false, repeatDays: [], monthDays: [], dailyTimes: [] };
type Mode = 'none' | 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly';
const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function scheduleMode(s: ScheduleDraft): Mode {
  if (!s.repeatDaily) return 'none';
  if (s.monthDays.length) return 'monthly';
  if (!s.repeatDays.length || s.repeatDays.length === 7) return 'daily';
  if (sameSet(s.repeatDays, WEEKDAY_PRESETS.weekdays)) return 'weekdays';
  if (sameSet(s.repeatDays, WEEKDAY_PRESETS.weekends)) return 'weekends';
  return 'weekly';
}

/** Normalizes a draft for submission: no stray days/times when repeating is off. */
export function scheduleForSubmit(s: ScheduleDraft): ScheduleDraft {
  if (!s.repeatDaily) return emptySchedule;
  return { repeatDaily: true, repeatDays: s.monthDays.length ? [] : [...s.repeatDays].sort(), monthDays: [...s.monthDays].sort((a, b) => a - b), dailyTimes: [...new Set(s.dailyTimes)].sort() };
}

export function ScheduleEditor({ value, onChange, disabled, timezone, label = 'Repeat', defaultTime = '20:30' }: { value: ScheduleDraft; onChange: (v: ScheduleDraft) => void; disabled?: boolean; timezone?: string; label?: string; defaultTime?: string }) {
  const [picked, setPicked] = useState<Mode | null>(null);
  // Keep the chosen mode while editing days (e.g. weekly with all 7 days stays weekly).
  const mode: Mode = !value.repeatDaily ? 'none' : picked && picked !== 'none' ? picked : scheduleMode(value);
  const times = value.dailyTimes.length ? value.dailyTimes : value.repeatDaily ? [defaultTime] : [];
  const setMode = (m: Mode) => {
    setPicked(m);
    const today = ((new Date().getDay() + 6) % 7) + 1;
    const base = { ...value, repeatDaily: m !== 'none', dailyTimes: m === 'none' ? [] : times };
    if (m === 'none') onChange(emptySchedule);
    else if (m === 'daily') onChange({ ...base, repeatDays: [], monthDays: [] });
    else if (m === 'weekdays') onChange({ ...base, repeatDays: [...WEEKDAY_PRESETS.weekdays], monthDays: [] });
    else if (m === 'weekends') onChange({ ...base, repeatDays: [...WEEKDAY_PRESETS.weekends], monthDays: [] });
    else if (m === 'weekly') onChange({ ...base, repeatDays: mode === 'weekly' && value.repeatDays.length ? value.repeatDays : [today], monthDays: [] });
    else onChange({ ...base, repeatDays: [], monthDays: value.monthDays.length ? value.monthDays : [new Date().getDate()] });
  };
  const toggle = (key: 'repeatDays' | 'monthDays', n: number) => {
    const on = value[key].includes(n);
    if (on && value[key].length === 1) return;
    onChange({ ...value, [key]: on ? value[key].filter((d) => d !== n) : [...value[key], n].sort((a, b) => a - b) });
  };
  const setTime = (i: number, t: string) => onChange({ ...value, dailyTimes: times.map((x, j) => (j === i ? t : x)) });
  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={label}>
          <Select value={mode} disabled={disabled} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="none">Does not repeat</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekends">Weekends (Sat–Sun)</option>
            <option value="weekly">Weekly on chosen days</option>
            <option value="monthly">Monthly on chosen dates</option>
          </Select>
        </Field>
        {value.repeatDaily && (
          <Field label={`Time${times.length > 1 ? 's' : ''}${timezone ? ` (${timezone})` : ''}`}>
            <div className="space-y-2">
              {times.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input type="time" required value={t} disabled={disabled} aria-label={`Time ${i + 1}`} onChange={(e) => setTime(i, e.target.value)} />
                  {times.length > 1 && <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`Remove time ${i + 1}`} onClick={() => onChange({ ...value, dailyTimes: times.filter((_, j) => j !== i) })}>✕</Button>}
                </div>
              ))}
              {times.length < MAX_TIMES_PER_DAY && (
                <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange({ ...value, dailyTimes: [...times, times[times.length - 1] ?? defaultTime] })}>
                  + Add another time ({times.length}/{MAX_TIMES_PER_DAY} per day)
                </Button>
              )}
            </div>
          </Field>
        )}
      </div>
      {mode === 'weekly' && (
        <div role="group" aria-label="Repeat on days" className="flex flex-wrap gap-2">
          {WEEKDAY_LABELS.map((l, i) => { const d = i + 1; const on = value.repeatDays.includes(d); return <button key={l} type="button" aria-pressed={on} disabled={disabled || (on && value.repeatDays.length === 1)} onClick={() => toggle('repeatDays', d)} className={cn('min-w-12 rounded-full border px-3 py-1.5 text-sm', on ? 'border-primary bg-primary/10 font-semibold' : 'opacity-70')}>{l}</button>; })}
        </div>
      )}
      {mode === 'monthly' && (
        <div role="group" aria-label="Repeat on dates" className="grid grid-cols-7 gap-1 sm:grid-cols-11">
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => { const on = value.monthDays.includes(d); return <button key={d} type="button" aria-pressed={on} disabled={disabled || (on && value.monthDays.length === 1)} onClick={() => toggle('monthDays', d)} className={cn('rounded-lg border px-0 py-1.5 text-sm', on ? 'border-primary bg-primary/10 font-semibold' : 'opacity-70')}>{d}</button>; })}
        </div>
      )}
    </div>
  );
}
