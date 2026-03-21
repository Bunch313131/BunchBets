import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import Dashboard from '@/pages/Dashboard'
import Tasks from '@/pages/Tasks'
import QuickShare from '@/pages/QuickShare'
import Files from '@/pages/Files'
import Notes from '@/pages/Notes'
import Settings from '@/pages/Settings'
import DocToCalendar from '@/pages/DocToCalendar'

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/share" element={<QuickShare />} />
          <Route path="/files" element={<Files />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/calendar" element={<DocToCalendar />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
