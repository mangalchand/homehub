import { addDays, addMonths, formatISO, subDays, subMonths } from 'date-fns'
import type {
  CalendarEvent, Chore, Expense, FamilyMember, GroceryItem,
  Invitation, MaintenanceTask, Reminder, VaultDocument,
} from '../types'

const KEY = 'familyhub-demo-v1'

export interface DemoData {
  members: FamilyMember[]
  invitations: Invitation[]
  events: CalendarEvent[]
  chores: Chore[]
  groceries: GroceryItem[]
  maintenance: MaintenanceTask[]
  expenses: Expense[]
  documents: VaultDocument[]
  reminders: Reminder[]
}

const iso = (d: Date) => formatISO(d)

export function seedData(now = new Date()): DemoData {
  const m1 = { id: 'm1', name: 'Alex', role: 'parent' as const, avatarColor: '#6366f1', points: 0, email: 'alex@familyhub.app' }
  const m2 = { id: 'm2', name: 'Jordan', role: 'parent' as const, avatarColor: '#ec4899', points: 0, email: 'jordan@familyhub.app' }
  const m3 = { id: 'm3', name: 'Riley', role: 'child' as const, avatarColor: '#f59e0b', points: 120 }
  const m4 = { id: 'm4', name: 'Sam', role: 'child' as const, avatarColor: '#10b981', points: 85 }
  return {
    members: [m1, m2, m3, m4],
    invitations: [
      { id: 'i1', email: 'grandma@familyhub.app', role: 'guardian', status: 'pending', sentAt: iso(subDays(now, 2)) },
    ],
    events: [
      { id: 'e1', title: 'Soccer practice', date: iso(now), startTime: '17:00', endTime: '18:30', memberId: 'm3', category: 'sports' },
      { id: 'e2', title: 'Dentist — Sam', date: iso(addDays(now, 1)), startTime: '09:00', memberId: 'm4', category: 'medical' },
      { id: 'e3', title: 'Family movie night', date: iso(addDays(now, 3)), startTime: '19:30', category: 'family' },
      { id: 'e4', title: 'Parent-teacher conference', date: iso(addDays(now, 6)), startTime: '15:00', memberId: 'm3', category: 'school' },
      { id: 'e5', title: 'Piano recital', date: iso(addDays(now, 12)), startTime: '18:00', memberId: 'm4', category: 'school' },
    ],
    chores: [
      { id: 'c1', title: 'Empty the dishwasher', assigneeId: 'm3', points: 10, dueDate: iso(now), completed: false, recurring: 'daily' },
      { id: 'c2', title: 'Take out recycling', assigneeId: 'm4', points: 15, dueDate: iso(now), completed: true, recurring: 'weekly' },
      { id: 'c3', title: 'Walk the dog', assigneeId: 'm3', points: 20, dueDate: iso(addDays(now, 1)), completed: false, recurring: 'daily' },
      { id: 'c4', title: 'Clean bedroom', assigneeId: 'm4', points: 25, dueDate: iso(addDays(now, 2)), completed: false, recurring: 'weekly' },
      { id: 'c5', title: 'Mow the lawn', assigneeId: 'm1', points: 40, dueDate: iso(addDays(now, 4)), completed: false, recurring: 'weekly' },
    ],
    groceries: [
      { id: 'g1', name: 'Milk', quantity: 2, category: 'dairy', checked: false, addedById: 'm2' },
      { id: 'g2', name: 'Bananas', quantity: 6, category: 'produce', checked: false, addedById: 'm1' },
      { id: 'g3', name: 'Chicken breast', quantity: 1, category: 'meat', checked: true, addedById: 'm2' },
      { id: 'g4', name: 'Pasta', quantity: 3, category: 'pantry', checked: false },
      { id: 'g5', name: 'Paper towels', quantity: 1, category: 'household', checked: false, addedById: 'm3' },
      { id: 'g6', name: 'Yogurt', quantity: 4, category: 'dairy', checked: false },
    ],
    maintenance: [
      { id: 'mt1', title: 'Replace HVAC filter', area: 'HVAC', dueDate: iso(addDays(now, 5)), lastDone: iso(subMonths(now, 3)), intervalMonths: 3, status: 'upcoming' },
      { id: 'mt2', title: 'Clean gutters', area: 'Exterior', dueDate: iso(subDays(now, 3)), intervalMonths: 6, status: 'overdue' },
      { id: 'mt3', title: 'Test smoke detectors', area: 'Safety', dueDate: iso(addDays(now, 20)), intervalMonths: 6, status: 'upcoming' },
      { id: 'mt4', title: 'Service water heater', area: 'Plumbing', dueDate: iso(now), status: 'due', notes: 'Annual flush' },
    ],
    expenses: [
      { id: 'x1', title: 'Weekly groceries', amount: 142.5, category: 'food', date: iso(subDays(now, 1)), paidById: 'm1' },
      { id: 'x2', title: 'Electricity bill', amount: 96.2, category: 'utilities', date: iso(subDays(now, 4)), paidById: 'm2' },
      { id: 'x3', title: 'Soccer cleats', amount: 54.99, category: 'kids', date: iso(subDays(now, 6)), paidById: 'm1' },
      { id: 'x4', title: 'Movie tickets', amount: 38.0, category: 'fun', date: iso(subDays(now, 9)), paidById: 'm2' },
      { id: 'x5', title: 'Gas', amount: 45.3, category: 'transport', date: iso(subDays(now, 11)), paidById: 'm1' },
      { id: 'x6', title: 'Streaming subscriptions', amount: 29.97, category: 'other', date: iso(subDays(now, 15)), paidById: 'm2' },
    ],
    documents: [
      { id: 'd1', title: 'Home insurance policy', category: 'insurance', uploadedAt: iso(subMonths(now, 2)), sizeLabel: '1.2 MB', expiresAt: iso(addMonths(now, 10)) },
      { id: 'd2', title: "Riley's vaccination record", category: 'medical', uploadedAt: iso(subMonths(now, 1)), sizeLabel: '340 KB' },
      { id: 'd3', title: 'Mortgage statement', category: 'finance', uploadedAt: iso(subDays(now, 12)), sizeLabel: '210 KB' },
      { id: 'd4', title: 'Warranty — dishwasher', category: 'home', uploadedAt: iso(subDays(now, 30)), sizeLabel: '180 KB', expiresAt: iso(addMonths(now, 22)) },
    ],
    reminders: [
      { id: 'r1', title: 'Book dentist for Riley', dueAt: iso(addDays(now, 1)), memberId: 'm1', done: false, priority: 'high' },
      { id: 'r2', title: 'RSVP to birthday party', dueAt: iso(addDays(now, 2)), memberId: 'm2', done: false, priority: 'medium' },
      { id: 'r3', title: 'Renew library books', dueAt: iso(addDays(now, 5)), done: false, priority: 'low' },
      { id: 'r4', title: 'Sign permission slip', dueAt: iso(subDays(now, 1)), memberId: 'm1', done: true, priority: 'medium' },
    ],
  }
}

export function load(): DemoData {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as DemoData
  } catch { /* fall through to seed */ }
  const data = seedData()
  save(data)
  return data
}

export function save(data: DemoData) {
  try { localStorage.setItem(KEY, JSON.stringify(data)) } catch { /* storage unavailable */ }
}

export function reset() {
  const data = seedData()
  save(data)
  return data
}

export function uid() {
  return Math.random().toString(36).slice(2, 10)
}
