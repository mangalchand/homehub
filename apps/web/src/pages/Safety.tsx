import { useSearchParams } from 'react-router-dom';
import { SafetyPanel, useSafety } from '@/features/safety';
import { FamilyCallCard } from '@/features/familyCall';

export function Safety() {
  const { householdId } = useSafety();
  const [params] = useSearchParams();
  const requestedHousehold = params.get('householdId');
  return <main className="mx-auto max-w-3xl space-y-6 p-4">
    <h1 className="text-2xl font-bold">Household Safety</h1>
    {requestedHousehold && requestedHousehold !== householdId && <p role="alert" className="rounded-xl border p-4">This notification is for a different household. Select that home from Homes using your personal account. A paired home display cannot switch homes. The alerts below belong only to your currently selected household.</p>}
    <SafetyPanel />
    <FamilyCallCard />
  </main>;
}
