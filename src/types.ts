export interface FamilyMember {
  id: string
  name: string
  role: 'parent' | 'child' | 'guardian'
  avatarColor: string
  points: number
  email?: string
}

export interface Invitation {
  id: string
  email: string
  role: 'parent' | 'child' | 'guardian'
  status: 'pending' | 'accepted'
  sentAt: string
}

export interface CalendarEvent {
  id: string
  title: string
  date: string
  startTime?: string
  endTime?: string
  memberId?: string
  category: 'family' | 'school' | 'sports' | 'medical' | 'other'
}

export interface Chore {
  id: string
  title: string
  assigneeId: string
  points: number
  dueDate: string
  completed: boolean
  recurring: 'none' | 'daily' | 'weekly'
}

export interface GroceryItem {
  id: string
  name: string
  quantity: number
  category: 'produce' | 'dairy' | 'pantry' | 'meat' | 'household' | 'other'
  checked: boolean
  addedById?: string
}

export interface MaintenanceTask {
  id: string
  title: string
  area: string
  dueDate: string
  lastDone?: string
  intervalMonths?: number
  status: 'upcoming' | 'due' | 'overdue' | 'done'
  notes?: string
}

export interface Expense {
  id: string
  title: string
  amount: number
  category: 'food' | 'housing' | 'transport' | 'kids' | 'fun' | 'utilities' | 'other'
  date: string
  paidById?: string
}

export interface VaultDocument {
  id: string
  title: string
  category: 'insurance' | 'medical' | 'school' | 'finance' | 'home' | 'other'
  uploadedAt: string
  sizeLabel: string
  expiresAt?: string
}

export interface Reminder {
  id: string
  title: string
  dueAt: string
  memberId?: string
  done: boolean
  priority: 'low' | 'medium' | 'high'
}

export interface DashboardData {
  members: FamilyMember[]
  todayEvents: CalendarEvent[]
  pendingChores: Chore[]
  uncheckedGroceries: number
  upcomingMaintenance: MaintenanceTask[]
  monthSpend: number
  activeReminders: Reminder[]
}
