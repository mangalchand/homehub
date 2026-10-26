import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DisplayMode = 'standard' | 'kiosk' | 'night';
export type Theme = 'light' | 'dark' | 'system';

interface UiState {
  householdId: string | null;
  theme: Theme;
  displayMode: DisplayMode;
  /** Auto night mode window (local hours). */
  nightStart: number;
  nightEnd: number;
  autoNight: boolean;
  hiddenCalendarIds: string[];
  memberFilter: string[];
  setHousehold: (id: string | null) => void;
  setTheme: (t: Theme) => void;
  setDisplayMode: (m: DisplayMode) => void;
  setNight: (p: Partial<Pick<UiState, 'nightStart' | 'nightEnd' | 'autoNight'>>) => void;
  toggleCalendar: (id: string) => void;
  toggleMember: (id: string) => void;
  clearMemberFilter: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (setState) => ({
      householdId: null,
      theme: 'system',
      displayMode: 'standard',
      nightStart: 21,
      nightEnd: 6,
      autoNight: false,
      hiddenCalendarIds: [],
      memberFilter: [],
      setHousehold: (householdId) => setState({ householdId, hiddenCalendarIds: [], memberFilter: [] }),
      setTheme: (theme) => setState({ theme }),
      setDisplayMode: (displayMode) => setState({ displayMode }),
      setNight: (p) => setState(p),
      toggleCalendar: (id) =>
        setState((s) => ({ hiddenCalendarIds: s.hiddenCalendarIds.includes(id) ? s.hiddenCalendarIds.filter((x) => x !== id) : [...s.hiddenCalendarIds, id] })),
      toggleMember: (id) => setState((s) => ({ memberFilter: s.memberFilter.includes(id) ? s.memberFilter.filter((x) => x !== id) : [...s.memberFilter, id] })),
      clearMemberFilter: () => setState({ memberFilter: [] }),
    }),
    { name: 'familyhub-ui' },
  ),
);
