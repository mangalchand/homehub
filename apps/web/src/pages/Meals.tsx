import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Trash2, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { MEAL_SLOTS, type MealSlotName } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { useHhMutation, useMe, useRole } from '@/lib/queries';
import { useUi } from '@/store/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';

export interface Meal {
  id: string;
  date: string;
  slot: MealSlotName;
  title: string;
  notes: string | null;
}

const SLOT_LABEL: Record<MealSlotName, string> = { BREAKFAST: 'Breakfast', LUNCH: 'Lunch', DINNER: 'Dinner', SNACK: 'Snack' };
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));

type Draft = { id?: string; date: string; slot: MealSlotName; title: string; notes: string };

export default function MealsPage() {
  const { householdId } = useUi();
  const { role } = useRole();
  const canWrite = useMe().data?.kind === 'device' || role !== 'GUEST';
  const [weekStart, setWeekStart] = useState(() => monday(new Date()));
  const [draft, setDraft] = useState<Draft | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const start = iso(days[0]!);
  const end = iso(days[6]!);
  const meals =
    useQuery({
      queryKey: ['meals', householdId, start],
      queryFn: () => api<Meal[]>(hh(householdId!, `/meals?start=${start}&end=${end}`)),
      enabled: Boolean(householdId),
    }).data ?? [];
  const save = useHhMutation<Draft>(
    (hid, d) =>
      api(hh(hid, d.id ? `/meals/${d.id}` : '/meals'), {
        method: d.id ? 'PATCH' : 'POST',
        body: { date: d.date, slot: d.slot, title: d.title, notes: d.notes.trim() || null },
      }),
    [['meals']],
  );
  const remove = useHhMutation<string>((hid, id) => api(hh(hid, `/meals/${id}`), { method: 'DELETE' }), [['meals']]);
  const today = iso(new Date());

  return (
    <div>
      <PageHeader
        title="Meal plan"
        subtitle="Plan the week's breakfasts, lunches and dinners together."
        actions={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" aria-label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft /></Button>
            <Button variant="outline" size="sm" onClick={() => setWeekStart(monday(new Date()))}>This week</Button>
            <Button variant="outline" size="sm" aria-label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight /></Button>
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {days.map((d) => {
          const date = iso(d);
          const dayMeals = meals.filter((m) => m.date === date).sort((a, b) => MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot));
          return (
            <Card key={date} className={date === today ? 'border-primary/60 shadow-md' : undefined}>
              <CardContent className="space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                  {canWrite && (
                    <Button size="sm" variant="ghost" aria-label={`Add meal on ${date}`} onClick={() => setDraft({ date, slot: 'DINNER', title: '', notes: '' })}><Plus /></Button>
                  )}
                </div>
                {dayMeals.length === 0 && <p className="text-sm text-muted-foreground">Nothing planned</p>}
                {dayMeals.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={!canWrite}
                    className="block w-full rounded-xl bg-muted/50 p-2 text-left hover:bg-muted"
                    onClick={() => setDraft({ id: m.id, date: m.date, slot: m.slot, title: m.title, notes: m.notes ?? '' })}
                  >
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{SLOT_LABEL[m.slot]}</span>
                    <span className="block break-words font-medium">{m.title}</span>
                    {m.notes && <span className="block break-words text-xs text-muted-foreground">{m.notes}</span>}
                  </button>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {meals.length === 0 && (
        <p className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><UtensilsCrossed className="h-4 w-4" /> No meals planned this week yet.</p>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={(o) => !o && setDraft(null)} title={draft?.id ? 'Edit meal' : 'Plan a meal'}>
        {draft && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft, { onSuccess: () => setDraft(null), onError: (er) => toast.error((er as Error).message) });
            }}
          >
            <Field label="Meal"><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={120} autoFocus placeholder="e.g. Chicken curry" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Day"><Input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} required /></Field>
              <Field label="Time">
                <Select value={draft.slot} onChange={(e) => setDraft({ ...draft, slot: e.target.value as MealSlotName })}>
                  {MEAL_SLOTS.map((s) => <option key={s} value={s}>{SLOT_LABEL[s]}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Notes (optional)"><Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} maxLength={500} placeholder="Who's cooking, ingredients to buy…" /></Field>
            <div className="flex gap-2">
              {draft.id && (
                <Button type="button" variant="outline" onClick={() => remove.mutate(draft.id!, { onSuccess: () => setDraft(null) })}><Trash2 /> Remove</Button>
              )}
              <Button className="flex-1" type="submit" disabled={save.isPending}>Save</Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
