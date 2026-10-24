import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addDays, endOfMonth, endOfWeek, format, isSameDay, isSameMonth,
  isToday, parseISO, startOfMonth, startOfWeek, addMonths,
} from 'date-fns'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui'
import type { CalendarEvent } from '../types'

const catBadge: Record<CalendarEvent['category'], string> = {
  family: '', school: 'amber', sports: 'green', medical: 'rose', other: 'gray',
}

export default function Calendar() {
  const qc = useQueryClient()
  const [month, setMonth] = useState(new Date())
  const [open, setOpen] = useState(false)
  const events = useQuery({ queryKey: ['events'], queryFn: api.listEvents })
  const members = useQuery({ queryKey: ['members'], queryFn: api.listMembers })

  const addMut = useMutation({
    mutationFn: (e: Omit<CalendarEvent, 'id'>) => api.addEvent(e),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }),
  })
  const delMut = useMutation({
    mutationFn: api.deleteEvent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }),
  })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    addMut.mutate({
      title: String(fd.get('title')),
      date: new Date(String(fd.get('date')) + 'T12:00:00').toISOString(),
      startTime: String(fd.get('start')) || undefined,
      endTime: String(fd.get('end')) || undefined,
      memberId: String(fd.get('member')) || undefined,
      category: String(fd.get('category')) as CalendarEvent['category'],
    })
    setOpen(false)
  }

  if (events.isLoading) return <Loading label="Loading calendar…" />
  if (events.isError || !events.data) return <ErrorState message="Could not load events." onRetry={() => events.refetch()} />

  const days: Date[] = []
  let d = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
  const last = endOfWeek(endOfMonth(month), { weekStartsOn: 1 })
  while (d <= last) { days.push(d); d = addDays(d, 1) }
  const evOn = (day: Date) => events.data.filter((e) => isSameDay(parseISO(e.date), day))

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle="Shared family schedule"
        action={<button className="btn" onClick={() => setOpen(true)}><Plus size={16} /> New event</button>}
      />

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft size={18} /></button>
          <h2>{format(month, 'MMMM yyyy')}</h2>
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month"><ChevronRight size={18} /></button>
        </div>
        <div className="cal-grid">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => <div className="cal-head" key={w}>{w}</div>)}
          {days.map((day) => (
            <div key={day.toISOString()} className={`cal-day${isSameMonth(day, month) ? '' : ' out'}${isToday(day) ? ' today' : ''}`}>
              <div className="cal-num">{format(day, 'd')}</div>
              {evOn(day).map((e) => (
                <div
                  key={e.id}
                  className="cal-ev"
                  title={`${e.title} — click to delete`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => delMut.mutate(e.id)}
                >
                  {e.startTime ? `${e.startTime} ` : ''}{e.title}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Upcoming</h2>
        <div className="list">
          {events.data
            .filter((e) => parseISO(e.date) >= startOfWeek(new Date(), { weekStartsOn: 1 }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(0, 6)
            .map((e) => {
              const m = members.data?.find((x) => x.id === e.memberId)
              return (
                <div className="row" key={e.id}>
                  <span className={`badge ${catBadge[e.category]}`}>{e.category}</span>
                  <div className="grow">
                    <div className="title">{e.title}</div>
                    <div className="sub">
                      {format(parseISO(e.date), 'EEE, MMM d')}
                      {e.startTime && ` · ${e.startTime}${e.endTime ? '–' + e.endTime : ''}`}
                      {m && ` · ${m.name}`}
                    </div>
                  </div>
                  <button className="btn secondary small" onClick={() => delMut.mutate(e.id)}>Delete</button>
                </div>
              )
            })}
        </div>
      </div>

      <Modal open={open} title="New event" onClose={() => setOpen(false)}>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Title"><input name="title" required placeholder="e.g. Soccer practice" /></Field>
          <div className="form-row">
            <Field label="Date"><input name="date" type="date" required defaultValue={format(new Date(), 'yyyy-MM-dd')} /></Field>
            <Field label="Category">
              <select name="category" defaultValue="family">
                <option value="family">Family</option><option value="school">School</option>
                <option value="sports">Sports</option><option value="medical">Medical</option><option value="other">Other</option>
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="Start (optional)"><input name="start" type="time" /></Field>
            <Field label="End (optional)"><input name="end" type="time" /></Field>
          </div>
          <Field label="Family member (optional)">
            <select name="member" defaultValue="">
              <option value="">Everyone</option>
              {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn">Add event</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
