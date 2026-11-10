import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Languages } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export type Lang = 'en' | 'hi';

/** English text is the key; missing Hindi entries fall back to English. */
const HI: Record<string, string> = {
  Home: 'होम',
  Calendar: 'कैलेंडर',
  Chores: 'घर के काम',
  Lists: 'सूचियाँ',
  Meals: 'भोजन',
  Family: 'परिवार',
  Rewards: 'इनाम',
  Photos: 'फ़ोटो',
  Board: 'सूचना पट',
  'Home & safety': 'घर और सुरक्षा',
  Settings: 'सेटिंग्स',
  Everyday: 'रोज़मर्रा',
  'Home & settings': 'घर और सेटिंग्स',
  Announcements: 'घोषणाएँ',
  Notes: 'नोट्स',
  'Daily summary': 'दैनिक सारांश',
  'Evening summary': 'शाम का सारांश',
  'Home & devices': 'घर और उपकरण',
  'Safety & SOS': 'सुरक्षा और SOS',
  More: 'और',
  Announce: 'घोषणा',
  Summary: 'सारांश',
  Safety: 'सुरक्षा',
  'Sign out': 'साइन आउट',
  Language: 'भाषा',
  'Points by person': 'व्यक्ति अनुसार अंक',
  Person: 'व्यक्ति',
  Today: 'आज',
  Total: 'कुल',
  Available: 'उपलब्ध',
  'Chores left': 'बाकी काम',
  'Pending tasks and chores': 'बाकी कार्य और काम',
  'AI summary': 'AI सारांश',
  'Does not repeat': 'दोहराव नहीं',
  'Every day': 'हर दिन',
  Weekdays: 'सोम–शुक्र',
  Weekends: 'शनि–रवि',
  'Choose days': 'दिन चुनें',
  'Monthly dates': 'महीने की तारीखें',
  'Add time': 'समय जोड़ें',
  'Times per day': 'दिन में कितनी बार',
  Repeat: 'दोहराएँ',
  Save: 'सहेजें',
  Cancel: 'रद्द करें',
  Edit: 'बदलें',
  Delete: 'हटाएँ',
  Add: 'जोड़ें',
};

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}
export const useLangStore = create<LangState>()(
  persist((set) => ({ lang: 'en', setLang: (lang) => set({ lang }) }), { name: 'familyhub-lang' }),
);

export const translate = (lang: Lang, text: string) => (lang === 'hi' ? (HI[text] ?? text) : text);
export function useT() {
  const lang = useLangStore((s) => s.lang);
  return (text: string) => translate(lang, text);
}
export const currentLang = (): Lang => useLangStore.getState().lang;

export function LanguageSection() {
  const { lang, setLang } = useLangStore();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Languages className="h-5 w-5" /> Language / भाषा
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2" role="radiogroup" aria-label="Language">
          {(
            [
              ['en', 'English'],
              ['hi', 'हिन्दी (Hindi)'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={lang === value}
              onClick={() => setLang(value)}
              className={`rounded-xl border px-4 py-2 text-sm font-semibold ${lang === value ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Changes menus on this device and speaks announcements with a Hindi voice. Announcements are read exactly as
          written: type them in Hindi to hear them in Hindi.
        </p>
      </CardContent>
    </Card>
  );
}
