import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format, isToday, parseISO } from 'date-fns'
import { Bell, CalendarDays, ClipboardCheck, RefreshCw, Receipt, ShoppingCart, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { Avatar, ErrorState, Loading, PageHeader, StatCard } from '../components/ui'

export default function Dashboard() {
  const qc = useQueryClient()
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['dashboard'], queryFn: api.getDashboard })

  if (isLoading) return <Loading label="Loading your family hub…" />
  if (isError || !data) return <ErrorState message="Could not load the dashboard." onRetry={() => refetch()} />

  const doneChores = data.pendingChores.length === 0
  return (
    <>
      <PageHeader
        title={`Good day! 👋`}
        subtitle={format(new Date(), 'EEEE, MMMM d')}
        action={
          <button className="btn secondary small" onClick={async () => { await api.resetDemo(); qc.invalidateQueries() }}>
            <RefreshCw size={14} /> Reset demo
          </button>
        }
      />

      <div className="grid cols-4" style={{ marginBottom: 20 }}>
        <StatCard icon={CalendarDays} label="events today" value={data.todayEvents.length} tone="indigo" />
        <StatCard icon={ClipboardCheck} label="chores to do" value={doneChores ? 'All done!' : data.pendingChores.length} tone="green" />
        <StatCard icon={ShoppingCart} label="groceries needed" value={data.uncheckedGroceries} tone="amber" />
        <StatCard icon={Receipt} label="spent this month" value={`$${data.monthSpend.toFixed(2)}`} tone="rose" />
      </div>

      <div className="grid cols-2">
        <section className="card">
          <h2>Today's schedule</h2>
          <div className="list">
            {data.todayEvents.length === 0 && <p className="muted small">Nothing scheduled today. Enjoy the calm!</p>}
            {data.todayEvents.map((e) => {
              const m = data.members.find((x) => x.id === e.memberId)
              return (
                <div className="row" key={e.id}>
                  <span className="badge sky">{e.startTime ?? 'All day'}</span>
                  <div className="grow">
                    <div className="title">{e.title}</div>
                    {m && <div className="sub">{m.name}</div>}
                  </div>
                </div>
              )
            })}
          </div>
          <p style={{ marginTop: 12 }}><Link to="/calendar" className="small" style={{ color: 'var(--brand)' }}>View calendar →</Link></p>
        </section>

        <section className="card">
          <h2>Chores leaderboard</h2>
          <div className="list">
            {[...data.members].sort((a, b) => b.points - a.points).map((m) => (
              <div className="row" key={m.id}>
                <Avatar name={m.name} color={m.avatarColor} />
                <div className="grow">
                  <div className="title">{m.name}</div>
                  <div className="sub">{m.role}</div>
                </div>
                <span className="badge amber">{m.points} pts</span>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 12 }}><Link to="/chores" className="small" style={{ color: 'var(--brand)' }}>Manage chores →</Link></p>
        </section>

        <section className="card">
          <h2><Wrench size={16} style={{ verticalAlign: '-2px' }} /> Home maintenance</h2>
          <div className="list">
            {data.upcomingMaintenance.length === 0 && <p className="muted small">All caught up.</p>}
            {data.upcomingMaintenance.map((t) => (
              <div className="row" key={t.id}>
                <div className="grow">
                  <div className="title">{t.title}</div>
                  <div className="sub">{t.area} · due {format(parseISO(t.dueDate), 'MMM d')}</div>
                </div>
                <span className={`badge ${t.status === 'overdue' ? 'rose' : t.status === 'due' ? 'amber' : 'gray'}`}>{t.status}</span>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 12 }}><Link to="/maintenance" className="small" style={{ color: 'var(--brand)' }}>All tasks →</Link></p>
        </section>

        <section className="card">
          <h2><Bell size={16} style={{ verticalAlign: '-2px' }} /> Active reminders</h2>
          <div className="list">
            {data.activeReminders.length === 0 && <p className="muted small">No open reminders.</p>}
            {data.activeReminders.slice(0, 4).map((r) => (
              <div className="row" key={r.id}>
                <div className="grow">
                  <div className="title">{r.title}</div>
                  <div className="sub">
                    {isToday(parseISO(r.dueAt)) ? 'Today' : format(parseISO(r.dueAt), 'MMM d')}
                  </div>
                </div>
                <span className={`badge ${r.priority === 'high' ? 'rose' : r.priority === 'medium' ? 'amber' : 'gray'}`}>{r.priority}</span>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 12 }}><Link to="/reminders" className="small" style={{ color: 'var(--brand)' }}>Reminder center →</Link></p>
        </section>
      </div>
    </>
  )
}
