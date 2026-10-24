import cors from '@fastify/cors'
import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

const prisma = new PrismaClient()
const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

app.get('/api/health', () => ({ ok: true }))

app.get('/api/members', () => prisma.familyMember.findMany())
app.post('/api/members', async (req) => {
  const body = req.body as { name: string; role: string; email?: string; avatarColor?: string }
  return prisma.familyMember.create({ data: { ...body, role: body.role ?? 'child' } })
})

app.get('/api/events', () => prisma.calendarEvent.findMany({ orderBy: { date: 'asc' } }))
app.post('/api/events', async (req) => {
  const body = req.body as { title: string; date: string; startTime?: string; endTime?: string; memberId?: string; category?: string }
  return prisma.calendarEvent.create({ data: { ...body, date: new Date(body.date) } })
})
app.delete('/api/events/:id', async (req) => {
  const { id } = req.params as { id: string }
  return prisma.calendarEvent.delete({ where: { id } })
})

app.get('/api/chores', () => prisma.chore.findMany())
app.post('/api/chores', async (req) => {
  const body = req.body as { title: string; assigneeId?: string; points?: number; dueDate: string; recurring?: string }
  return prisma.chore.create({ data: { ...body, dueDate: new Date(body.dueDate) } })
})
app.patch('/api/chores/:id/toggle', async (req) => {
  const { id } = req.params as { id: string }
  const chore = await prisma.chore.findUniqueOrThrow({ where: { id } })
  return prisma.chore.update({ where: { id }, data: { completed: !chore.completed } })
})

app.get('/api/groceries', () => prisma.groceryItem.findMany())
app.post('/api/groceries', async (req) => {
  const body = req.body as { name: string; quantity?: number; category?: string }
  return prisma.groceryItem.create({ data: body })
})
app.patch('/api/groceries/:id/toggle', async (req) => {
  const { id } = req.params as { id: string }
  const item = await prisma.groceryItem.findUniqueOrThrow({ where: { id } })
  return prisma.groceryItem.update({ where: { id }, data: { checked: !item.checked } })
})

app.get('/api/maintenance', () => prisma.maintenanceTask.findMany())
app.get('/api/expenses', () => prisma.expense.findMany({ orderBy: { date: 'desc' } }))
app.post('/api/expenses', async (req) => {
  const body = req.body as { title: string; amount: number; category?: string; date: string; paidById?: string }
  return prisma.expense.create({ data: { ...body, date: new Date(body.date) } })
})
app.get('/api/documents', () => prisma.vaultDocument.findMany({ orderBy: { uploadedAt: 'desc' } }))
app.get('/api/reminders', () => prisma.reminder.findMany({ orderBy: { dueAt: 'asc' } }))
app.post('/api/reminders', async (req) => {
  const body = req.body as { title: string; dueAt: string; memberId?: string; priority?: string }
  return prisma.reminder.create({ data: { ...body, dueAt: new Date(body.dueAt) } })
})

const port = Number(process.env.PORT ?? 4000)
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
