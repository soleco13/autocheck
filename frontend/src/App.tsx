import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getMe } from './api/client'
import Login from './pages/Login'
import Home from './pages/Home'
import Dashboard from './pages/Dashboard'
import StudentCard from './pages/StudentCard'
import Report from './pages/Report'
import Textbooks from './pages/Textbooks'
import Materials from './pages/Materials'
import MaterialDetail from './pages/MaterialDetail'
import History from './pages/History'
import Settings from './pages/Settings'
import Help from './pages/Help'
import Layout from './components/Layout'
import { ToastProvider } from './components/Toast'
import { Skeleton } from './components/Skeleton'
import { CheckProvider } from './context/CheckContext'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    retry: false,
  })

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--c-bg)',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
            <span className="spinner spinner-dark" style={{ width: 28, height: 28, borderWidth: 3 }} />
          </div>
          <p style={{ color: 'var(--c-text-3)', fontSize: 14, margin: 0 }}>Загрузка...</p>
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider />
      <CheckProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<Home />} />
          <Route path="students" element={<Dashboard />} />
          <Route path="students/:id" element={<StudentCard />} />
          <Route path="reports/:sessionId" element={<Report />} />
          <Route path="textbooks" element={<Textbooks />} />
          <Route path="materials" element={<Materials />} />
          <Route path="materials/:materialId" element={<MaterialDetail />} />
          <Route path="history" element={<History />} />
          <Route path="settings" element={<Settings />} />
          <Route path="help" element={<Help />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </CheckProvider>
    </BrowserRouter>
  )
}
