import {
  Bell, CalendarDays, ClipboardCheck, Home, LayoutDashboard,
  Receipt, ShoppingCart, Users, Wrench,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/family', label: 'Family', icon: Users },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/chores', label: 'Chores', icon: ClipboardCheck },
  { to: '/groceries', label: 'Groceries', icon: ShoppingCart },
  { to: '/maintenance', label: 'Maintenance', icon: Wrench },
  { to: '/expenses', label: 'Expenses', icon: Receipt },
  { to: '/documents', label: 'Documents', icon: Home },
  { to: '/reminders', label: 'Reminders', icon: Bell },
]

const mobileNav = [nav[0], nav[2], nav[4], nav[3], nav[8]]

export default function Layout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">FH</span>
          <span className="brand-name">FamilyHub</span>
        </div>
        <nav className="side-nav">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot muted small">Demo mode · data stored locally</div>
      </aside>

      <main className="content">
        <Outlet />
      </main>

      <nav className="bottom-nav">
        {mobileNav.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `bottom-item${isActive ? ' active' : ''}`}>
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
