import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Calendar from './pages/Calendar'
import Chores from './pages/Chores'
import Dashboard from './pages/Dashboard'
import Documents from './pages/Documents'
import Expenses from './pages/Expenses'
import Family from './pages/Family'
import Groceries from './pages/Groceries'
import Maintenance from './pages/Maintenance'
import Reminders from './pages/Reminders'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="family" element={<Family />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="chores" element={<Chores />} />
        <Route path="groceries" element={<Groceries />} />
        <Route path="maintenance" element={<Maintenance />} />
        <Route path="expenses" element={<Expenses />} />
        <Route path="documents" element={<Documents />} />
        <Route path="reminders" element={<Reminders />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  )
}
