import { addDays, setHours, setMinutes, startOfDay } from 'date-fns';

export type VoiceCommand =
  | { kind: 'task'; title: string; due: Date | null; memberName?: string }
  | { kind: 'grocery'; items: string[] }
  | { kind: 'event'; title: string; start: Date; allDay: boolean; memberName?: string }
  | { kind: 'agenda'; day: 'today' | 'tomorrow' }
  | { kind: 'chores' }
  | { kind: 'announce'; title: string }
  | { kind: 'announcements' }
  | { kind: 'notifications' }
  | { kind: 'points'; memberName?: string }
  | { kind: 'pendingTasks' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Pulls "tomorrow at 5 pm", "on friday", "tonight" etc. out of a phrase. */
export function extractWhen(text: string, now = new Date()) {
  let rest = ` ${text} `;
  let day: Date | null = null;
  let hour: number | null = null;
  let minute = 0;

  const time = rest.match(/\s(?:at|by)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?=\s)/i) ?? rest.match(/\s(?:at|by)\s+(\d{1,2})(?:[:.](\d{2}))?(?=\s)/i);
  if (time) {
    hour = Number(time[1]);
    minute = Number(time[2] ?? 0);
    const ampm = time[3]?.toLowerCase().replace(/[.\s]/g, '');
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!ampm && hour >= 1 && hour <= 7) hour += 12; // "at 5" in a family app almost always means 5 PM
    if (hour > 23 || minute > 59) hour = null;
    else rest = rest.replace(time[0], ' ');
  } else if (/\s(?:at\s+)?noon(?=\s)/i.test(rest)) {
    hour = 12;
    rest = rest.replace(/\s(?:at\s+)?noon(?=\s)/i, ' ');
  }

  const today = startOfDay(now);
  if (/\s(?:by\s+|for\s+)?tonight(?=\s)/i.test(rest)) {
    day = today;
    hour ??= 19;
    rest = rest.replace(/\s(?:by\s+|for\s+)?tonight(?=\s)/i, ' ');
  } else if (/\s(?:by\s+|for\s+|on\s+)?today(?=\s)/i.test(rest)) {
    day = today;
    rest = rest.replace(/\s(?:by\s+|for\s+|on\s+)?today(?=\s)/i, ' ');
  } else if (/\s(?:by\s+|for\s+|on\s+)?tomorrow(?=\s)/i.test(rest)) {
    day = addDays(today, 1);
    rest = rest.replace(/\s(?:by\s+|for\s+|on\s+)?tomorrow(?=\s)/i, ' ');
  } else {
    const wd = rest.match(new RegExp(`\\s(?:by\\s+|on\\s+|this\\s+|next\\s+)?(${WEEKDAYS.join('|')})(?=\\s)`, 'i'));
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[1]!.toLowerCase());
      const ahead = (target - today.getDay() + 7) % 7 || 7;
      day = addDays(today, ahead);
      rest = rest.replace(wd[0], ' ');
    }
  }

  let date: Date | null = null;
  if (day || hour !== null) {
    date = day ?? today;
    if (hour !== null) {
      date = setMinutes(setHours(date, hour), minute);
      if (!day && date < now) date = addDays(date, 1);
    }
  }
  return { rest: rest.replace(/\s+/g, ' ').trim(), date, hasTime: hour !== null };
}

function splitMember(text: string) {
  const m = text.match(/^(.*\S)\s+for\s+([a-z][a-z'-]+)$/i);
  return m ? { title: m[1]!, memberName: m[2]! } : { title: text };
}

const tidy = (s: string) => s.replace(/^(?:to|that|a|an)\s+/i, '').replace(/\s+/g, ' ').trim();

export function parseCommand(raw: string, now = new Date()): VoiceCommand {
  const t = raw
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^(?:hey|hi|ok|okay)[,\s]+/, '')
    .replace(/^family\s?hub[,\s]+/, '')
    .replace(/^(?:please|can you|could you)\s+/, '')
    .trim();
  if (!t) return { kind: 'unknown', text: raw };

  if (/^(?:help|what can (?:you|i) (?:do|say))/.test(t)) return { kind: 'help' };

  const announce = t.match(/^announce\s+(.+)$/);
  if (announce) return { kind: 'announce', title: capitalize(announce[1]!) };
  if (/^read\s+(?:(?:the|our|active)\s+)?announcements$/.test(t)) return { kind: 'announcements' };
  if (/^read\s+(?:(?:my|the|unread)\s+)?notifications$/.test(t)) return { kind: 'notifications' };
  if (/^read\s+my\s+points$/.test(t)) return { kind: 'points' };
  const points = t.match(/^how many points does\s+(.+?)\s+have$/);
  if (points) return { kind: 'points', memberName: points[1]! };
  if (/^read\s+(?:(?:the|our)\s+)?(?:pending|open|incomplete)\s+tasks$/.test(t)) return { kind: 'pendingTasks' };

  if (/\bchores?\b/.test(t) && /\b(?:what|which|left|remaining|show|read|any|how many)\b/.test(t)) return { kind: 'chores' };

  if (/^(?:what(?:'s| is)|whats|show|read|tell me)\b/.test(t) && /\b(?:today|tonight|tomorrow|schedule|agenda|calendar|on|happening|next|planned)\b/.test(t)) {
    return { kind: 'agenda', day: /\btomorrow\b/.test(t) ? 'tomorrow' : 'today' };
  }

  const grocery =
    t.match(/^(?:add|put)\s+(.+?)\s+(?:to|on|in|into)\s+(?:the\s+|my\s+|our\s+)?(?:grocery|groceries|shopping)(?:\s+list)?$/) ??
    t.match(/^(?:we need(?: to buy)?|we're out of|we are out of|buy)\s+(.+)$/);
  if (grocery) {
    const items = grocery[1]!.split(/\s*,\s*|\s+and\s+/).map((s) => tidy(s.replace(/^some\s+/, ''))).filter(Boolean);
    if (items.length) return { kind: 'grocery', items };
  }

  const event = t.match(/^(?:add|create|schedule|book|new)\s+(?:an?\s+|the\s+)?(?:event|appointment|meeting)\s+(?:for\s+|called\s+)?(.+)$/);
  if (event) {
    const when = extractWhen(event[1]!, now);
    const { title, memberName } = splitMember(tidy(when.rest));
    if (title) return { kind: 'event', title, start: when.date ?? startOfDay(now), allDay: !when.hasTime, memberName };
  }

  const task = t.match(/^(?:add|create|new)\s+(?:a\s+|the\s+)?(?:task|to-?do|todo|reminder)\s+(.+)$/) ?? t.match(/^remind\s+(?:me|us)\s+(.+)$/);
  if (task) {
    const when = extractWhen(task[1]!, now);
    const { title, memberName } = splitMember(tidy(when.rest));
    let due = when.date;
    if (due && !when.hasTime) due = setHours(due, 9);
    if (title) return { kind: 'task', title, due, memberName };
  }

  // Loose fallback: "add call the plumber tomorrow" / "new pick up dry cleaning" → a task.
  const loose = t.match(/^(?:add|create|new|note)\s+(.+)$/);
  if (loose) {
    const when = extractWhen(loose[1]!, now);
    const { title, memberName } = splitMember(tidy(when.rest));
    let due = when.date;
    if (due && !when.hasTime) due = setHours(due, 9);
    if (title) return { kind: 'task', title, due, memberName };
  }

  return { kind: 'unknown', text: raw };
}

export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
