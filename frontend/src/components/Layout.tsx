import { useState, useRef, useEffect } from 'react'
import { Outlet, NavLink, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Users, BookOpen, BookMarked, History, Settings, Home,
  Search, HelpCircle, LogOut, ChevronLeft, ChevronRight, X, Square,
} from 'lucide-react'
import { getMe, getStudents, logout } from '../api/client'
import { toast } from './Toast'
import { AppLogoFull } from './AppLogo'
import { useCheckContext } from '../context/CheckContext'

const NAV = [
  { to: '/',          label: 'Главная',   Icon: Home },
  { to: '/students',  label: 'Ученики',   Icon: Users },
  { to: '/materials', label: 'Материалы', Icon: BookOpen },
  { to: '/textbooks', label: 'Учебники',  Icon: BookMarked },
  { to: '/history',   label: 'История',   Icon: History },
  { to: '/settings',  label: 'Настройки', Icon: Settings },
]

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe })
  const { data: students = [] } = useQuery({
    queryKey: ['students'],
    queryFn: () => getStudents(),
    staleTime: 60_000,
  })

  const filtered = globalSearch.trim().length >= 1
    ? (students as any[]).filter(s =>
        s.full_name?.toLowerCase().includes(globalSearch.toLowerCase())
      )
    : []

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (!globalSearch) setSearchOpen(false)
  }, [location.pathname])

  const handleLogout = async () => {
    try {
      await logout()
      qc.clear()
      navigate('/login')
    } catch {
      toast.error('Ошибка выхода')
    }
  }

  const { bulkRunning, bulkProgress, stopBulkCheck } = useCheckContext()
  const initials = me?.teacher?.email?.charAt(0)?.toUpperCase() || 'T'

  return (
    <div style={{ display: 'flex' }}>
      {/* Sidebar */}
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        {/* Logo */}
        <div className="sidebar-logo">
          <AppLogoFull collapsed={collapsed} />
        </div>

        {/* Nav */}
        <nav className="sidebar-nav">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              title={collapsed ? label : undefined}
            >
              <Icon className="nav-icon" />
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Bottom: collapse toggle */}
        <div style={{ padding: '8px', borderTop: '1px solid var(--c-border-solid)' }}>
          <button
            className="nav-item"
            onClick={() => setCollapsed(v => !v)}
            title={collapsed ? 'Развернуть' : 'Свернуть'}
            style={{ justifyContent: collapsed ? 'center' : undefined }}
          >
            {collapsed ? <ChevronRight className="nav-icon" /> : <ChevronLeft className="nav-icon" />}
            <span className="nav-label">Свернуть</span>
          </button>
        </div>
      </aside>

      {/* Header */}
      <header className={`main-header ${collapsed ? 'collapsed-sidebar' : ''}`}>
        {/* Global search */}
        <div className="search-wrap global-search" style={{ flex: 1, maxWidth: 380 }}>
          <span className="search-icon"><Search size={15} /></span>
          <input
            ref={searchRef}
            className="input input-search"
            placeholder="Поиск ученика..."
            value={globalSearch}
            onChange={e => { setGlobalSearch(e.target.value); setSearchOpen(true) }}
            onFocus={() => globalSearch && setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
          />
          {globalSearch && (
            <button
              onClick={() => setGlobalSearch('')}
              style={{
                position: 'absolute', right: 8, background: 'none', border: 'none',
                cursor: 'pointer', color: 'var(--c-text-3)', display: 'flex', padding: 2,
              }}
            >
              <X size={13} />
            </button>
          )}

          {/* Search dropdown */}
          {searchOpen && globalSearch.length >= 1 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
              background: 'var(--c-surface)', border: '1px solid var(--c-border-solid)',
              borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', zIndex: 300,
              maxHeight: 280, overflowY: 'auto',
            }}>
              {filtered.length === 0 ? (
                <div style={{ padding: '12px 14px', color: 'var(--c-text-3)', fontSize: 13 }}>
                  Ученик не найден
                </div>
              ) : (
                filtered.slice(0, 10).map((s: any) => (
                  <button
                    key={s.id}
                    onMouseDown={() => {
                      navigate(`/students/${s.id}`)
                      setGlobalSearch('')
                      setSearchOpen(false)
                    }}

                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                      padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer',
                      borderBottom: '1px solid var(--c-border-solid)', textAlign: 'left',
                    }}
                    className="hover-bg-surface"
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-surface-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
                      {s.full_name?.charAt(0)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--c-text)' }}>
                        {s.full_name}
                      </div>
                      {s.grade && (
                        <div style={{ fontSize: 12, color: 'var(--c-text-3)' }}>{s.grade} класс</div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Help */}
        <button className="btn btn-ghost btn-sm" title="Справка">
          <HelpCircle size={16} />
        </button>

        {/* User */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="avatar" style={{ width: 32, height: 32, fontSize: 12 }}>{initials}</div>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout} title="Выйти">
            <LogOut size={15} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className={`main-content ${collapsed ? 'collapsed-sidebar' : ''}`}>
        {/* Global bulk check progress banner — persists across navigation */}
        {bulkRunning && bulkProgress && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 80, marginBottom: 16,
            background: 'var(--c-primary-light)',
            border: '1px solid var(--c-primary-muted)',
            borderRadius: 10, padding: '10px 16px',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span className="spinner spinner-dark" style={{ width: 14, height: 14, borderWidth: 2, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 13 }}>
                <span style={{ fontWeight: 600, color: 'var(--c-primary)' }}>
                  Массовая проверка: {bulkProgress.done} / {bulkProgress.total}
                </span>
                <Link
                  to={`/students/${bulkProgress.studentId}`}
                  style={{ fontSize: 12, color: 'var(--c-primary)', textDecoration: 'none' }}
                >
                  перейти к ученику →
                </Link>
              </div>
              <div style={{ height: 5, background: 'var(--c-primary-muted)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${bulkProgress.total > 0 ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%`,
                  background: 'var(--c-primary)', borderRadius: 99,
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>
            <button
              onClick={stopBulkCheck}
              className="btn btn-sm"
              title="Остановить проверку"
              style={{
                flexShrink: 0, background: 'var(--c-danger)', color: '#fff',
                border: 'none', gap: 5,
              }}
            >
              <Square size={12} />
              Стоп
            </button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
