import { beforeEach, describe, expect, it } from 'vitest'
import { api } from '../api/client'
import { reset } from '../api/demo'

describe('demo data store', () => {
  beforeEach(() => {
    localStorage.clear()
    reset()
  })

  it('seeds all modules with data', async () => {
    expect((await api.listMembers()).length).toBeGreaterThanOrEqual(4)
    expect((await api.listEvents()).length).toBeGreaterThan(0)
    expect((await api.listChores()).length).toBeGreaterThan(0)
    expect((await api.listGroceries()).length).toBeGreaterThan(0)
    expect((await api.listMaintenance()).length).toBeGreaterThan(0)
    expect((await api.listExpenses()).length).toBeGreaterThan(0)
    expect((await api.listDocuments()).length).toBeGreaterThan(0)
    expect((await api.listReminders()).length).toBeGreaterThan(0)
  })

  it('toggles a chore and awards points to the assignee', async () => {
    const chores = await api.listChores()
    const chore = chores.find((c) => !c.completed)!
    const before = (await api.listMembers()).find((m) => m.id === chore.assigneeId)!.points

    await api.toggleChore(chore.id)

    const after = await api.listChores()
    expect(after.find((c) => c.id === chore.id)!.completed).toBe(true)
    const member = (await api.listMembers()).find((m) => m.id === chore.assigneeId)!
    expect(member.points).toBe(before + chore.points)
  })

  it('adds and checks off a grocery item', async () => {
    const item = await api.addGrocery('Apples', 4, 'produce')
    let list = await api.listGroceries()
    expect(list.find((g) => g.id === item.id)).toMatchObject({ name: 'Apples', checked: false })

    await api.toggleGrocery(item.id)
    list = await api.listGroceries()
    expect(list.find((g) => g.id === item.id)!.checked).toBe(true)

    await api.clearCheckedGroceries()
    list = await api.listGroceries()
    expect(list.find((g) => g.id === item.id)).toBeUndefined()
  })

  it('creates and cancels an invitation', async () => {
    const inv = await api.inviteMember('uncle@example.com', 'guardian')
    expect((await api.listInvitations()).some((i) => i.id === inv.id)).toBe(true)
    await api.cancelInvitation(inv.id)
    expect((await api.listInvitations()).some((i) => i.id === inv.id)).toBe(false)
  })

  it('persists data across loads', async () => {
    await api.addReminder({ title: 'Persist me', dueAt: new Date().toISOString(), priority: 'high' })
    const list = await api.listReminders()
    expect(list.some((r) => r.title === 'Persist me')).toBe(true)
    const raw = localStorage.getItem('familyhub-demo-v1')
    expect(raw).toContain('Persist me')
  })
})
