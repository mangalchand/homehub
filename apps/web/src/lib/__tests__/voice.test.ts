import { describe, expect, it } from 'vitest';
import { parseCommand } from '../voice/parse';

// Monday 26 Oct 2026, 10:00 local
const now = new Date(2026, 9, 26, 10, 0);

describe('voice command parser', () => {
  it('recognizes household readouts before the existing agenda and loose task fallbacks', () => {
    expect(parseCommand('Announce dinner is ready!')).toEqual({ kind: 'announce', title: 'Dinner is ready' });
    expect(parseCommand('Please read announcements')).toEqual({ kind: 'announcements' });
    expect(parseCommand('read unread notifications')).toEqual({ kind: 'notifications' });
    expect(parseCommand('read my points')).toEqual({ kind: 'points' });
    expect(parseCommand('How many points does Mary Jane have?')).toEqual({ kind: 'points', memberName: 'mary jane' });
    expect(parseCommand('read pending tasks')).toEqual({ kind: 'pendingTasks' });
    expect(parseCommand('announce')).toEqual({ kind: 'unknown', text: 'announce' });
  });
  it('adds tasks with due dates and assignees', () => {
    const c = parseCommand('Add task call the plumber tomorrow at 5 pm', now);
    expect(c).toMatchObject({ kind: 'task', title: 'call the plumber' });
    if (c.kind !== 'task') throw new Error();
    expect(c.due).toEqual(new Date(2026, 9, 27, 17, 0));
    expect(parseCommand('remind me to pay the electricity bill on friday', now)).toMatchObject({ kind: 'task', title: 'pay the electricity bill', due: new Date(2026, 9, 30, 9, 0) });
    expect(parseCommand('add a task take out the trash for leo', now)).toMatchObject({ kind: 'task', title: 'take out the trash', memberName: 'leo', due: null });
  });

  it('adds grocery items', () => {
    expect(parseCommand('Add milk, eggs and bread to the grocery list', now)).toEqual({ kind: 'grocery', items: ['milk', 'eggs', 'bread'] });
    expect(parseCommand('we need some bananas', now)).toEqual({ kind: 'grocery', items: ['bananas'] });
  });

  it('adds events, timed or all day', () => {
    expect(parseCommand('add event dentist on friday at 4:30 pm', now)).toMatchObject({ kind: 'event', title: 'dentist', allDay: false, start: new Date(2026, 9, 30, 16, 30) });
    expect(parseCommand('schedule an appointment school trip tomorrow', now)).toMatchObject({ kind: 'event', title: 'school trip', allDay: true });
  });

  it('answers questions', () => {
    expect(parseCommand("what's on today", now)).toEqual({ kind: 'agenda', day: 'today' });
    expect(parseCommand('What is happening tomorrow?', now)).toEqual({ kind: 'agenda', day: 'tomorrow' });
    expect(parseCommand('which chores are left', now)).toEqual({ kind: 'chores' });
    expect(parseCommand('blah blah', now).kind).toBe('unknown');
  });
});
