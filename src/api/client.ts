import { isThisMonth, isToday, parseISO } from 'date-fns'
import type {
  CalendarEvent, Chore, DashboardData, Expense, FamilyMember,
  GroceryItem, Invitation, MaintenanceTask, Reminder, VaultDocument,
} from '../types'
import { load, reset, save, uid, type DemoData } from './demo'

const delay = () => new Promise((r) => setTimeout(r, 80 + Math.random() * 120))

async function mutate<T>(fn: (d: DemoData) => T): Promise<T> {
  const data = load()
  const out = fn(data)
  save(data)
  await delay()
  return out
}

async function read<T>(fn: (d: DemoData) => T): Promise<T> {
  await delay()
  return fn(load())
}

export const api = {
  resetDemo: () => { reset(); return Promise.resolve() },

  getDashboard: (): Promise<DashboardData> => read((d) => ({
    members: d.members,
    todayEvents: d.events.filter((e) => isToday(parseISO(e.date))),
    pendingChores: d.chores.filter((c) => !c.completed),
    uncheckedGroceries: d.groceries.filter((g) => !g.checked).length,
    upcomingMaintenance: d.maintenance.filter((m) => m.status !== 'done').slice(0, 3),
    monthSpend: d.expenses.filter((e) => isThisMonth(parseISO(e.date))).reduce((s, e) => s + e.amount, 0),
    activeReminders: d.reminders.filter((r) => !r.done),
  })),

  listMembers: () => read((d) => d.members),
  listInvitations: () => read((d) => d.invitations),
  inviteMember: (email: string, role: Invitation['role']) =>
    mutate((d) => { const inv: Invitation = { id: uid(), email, role, status: 'pending', sentAt: new Date().toISOString() }; d.invitations.push(inv); return inv }),
  removeMember: (id: string) => mutate((d) => { d.members = d.members.filter((m) => m.id !== id) }),
  cancelInvitation: (id: string) => mutate((d) => { d.invitations = d.invitations.filter((i) => i.id !== id) }),
  addMember: (name: string, role: FamilyMember['role']) =>
    mutate((d) => {
      const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6']
      const m: FamilyMember = { id: uid(), name, role, points: 0, avatarColor: colors[d.members.length % colors.length] }
      d.members.push(m); return m
    }),

  listEvents: () => read((d) => d.events),
  addEvent: (e: Omit<CalendarEvent, 'id'>) => mutate((d) => { const ev = { ...e, id: uid() }; d.events.push(ev); return ev }),
  deleteEvent: (id: string) => mutate((d) => { d.events = d.events.filter((e) => e.id !== id) }),

  listChores: () => read((d) => d.chores),
  addChore: (c: Omit<Chore, 'id' | 'completed'>) => mutate((d) => { const ch: Chore = { ...c, id: uid(), completed: false }; d.chores.push(ch); return ch }),
  toggleChore: (id: string) => mutate((d) => {
    const c = d.chores.find((x) => x.id === id)
    if (!c) return
    c.completed = !c.completed
    const m = d.members.find((x) => x.id === c.assigneeId)
    if (m) m.points = Math.max(0, m.points + (c.completed ? c.points : -c.points))
  }),
  deleteChore: (id: string) => mutate((d) => { d.chores = d.chores.filter((c) => c.id !== id) }),

  listGroceries: () => read((d) => d.groceries),
  addGrocery: (name: string, quantity: number, category: GroceryItem['category']) =>
    mutate((d) => { const g: GroceryItem = { id: uid(), name, quantity, category, checked: false }; d.groceries.unshift(g); return g }),
  toggleGrocery: (id: string) => mutate((d) => { const g = d.groceries.find((x) => x.id === id); if (g) g.checked = !g.checked }),
  deleteGrocery: (id: string) => mutate((d) => { d.groceries = d.groceries.filter((g) => g.id !== id) }),
  clearCheckedGroceries: () => mutate((d) => { d.groceries = d.groceries.filter((g) => !g.checked) }),

  listMaintenance: () => read((d) => d.maintenance),
  addMaintenance: (t: Omit<MaintenanceTask, 'id' | 'status'>) =>
    mutate((d) => { const mt: MaintenanceTask = { ...t, id: uid(), status: 'upcoming' }; d.maintenance.push(mt); return mt }),
  completeMaintenance: (id: string) => mutate((d) => {
    const t = d.maintenance.find((x) => x.id === id)
    if (t) { t.status = 'done'; t.lastDone = new Date().toISOString() }
  }),
  deleteMaintenance: (id: string) => mutate((d) => { d.maintenance = d.maintenance.filter((t) => t.id !== id) }),

  listExpenses: () => read((d) => d.expenses),
  addExpense: (e: Omit<Expense, 'id'>) => mutate((d) => { const ex = { ...e, id: uid() }; d.expenses.unshift(ex); return ex }),
  deleteExpense: (id: string) => mutate((d) => { d.expenses = d.expenses.filter((e) => e.id !== id) }),

  listDocuments: () => read((d) => d.documents),
  addDocument: (doc: Omit<VaultDocument, 'id' | 'uploadedAt'>) =>
    mutate((d) => { const v: VaultDocument = { ...doc, id: uid(), uploadedAt: new Date().toISOString() }; d.documents.unshift(v); return v }),
  deleteDocument: (id: string) => mutate((d) => { d.documents = d.documents.filter((x) => x.id !== id) }),

  listReminders: () => read((d) => d.reminders),
  addReminder: (r: Omit<Reminder, 'id' | 'done'>) => mutate((d) => { const rem: Reminder = { ...r, id: uid(), done: false }; d.reminders.push(rem); return rem }),
  toggleReminder: (id: string) => mutate((d) => { const r = d.reminders.find((x) => x.id === id); if (r) r.done = !r.done }),
  deleteReminder: (id: string) => mutate((d) => { d.reminders = d.reminders.filter((r) => r.id !== id) }),
}
