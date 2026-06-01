import { useState, useRef, useEffect } from 'react'
import { Outlet, NavLink, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Users, BookOpen, BookMarked, History, Settings, Home,
  Search, HelpCircle, LogOut, PanelLeft, X, Square,
} from 'lucide-react'
import { getMe, getStudents, logout } from '../api/client'
import { toast } from './Toast'
import { AppLogo } from './AppLogo'
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

  const { bulkChecks, stopBulkCheck, stopAllBulkChecks } = useCheckContext()
  const activeBulk = [...bulkChecks.values()]
  const teacherName = (me as any)?.teacher?.full_name || me?.teacher?.email || 'Учитель'
  const teacherInitials = teacherName.split(' ').map((w: string) => w[0]).slice(0, 2).join('')

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        {/* Logo */}
        <div className="sidebar-logo">
          <AppLogo size={30} />
          <span className="wordmark">Auto<b>Check</b></span>
        </div>

        <div className="sidebar-section">Меню</div>

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
              <Icon className="nav-icon" size={20} />
              <span className="nav-label">{label}</span>
              {to === '/students' && !collapsed && (
                <span className="nav-count">{(students as any[]).length || ''}</span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Bottom: collapse toggle */}
        <div style={{ padding: 12, borderTop: '1px solid var(--c-border-solid)' }}>
          <button
            className="nav-item"
            onClick={() => setCollapsed(v => !v)}
            title={collapsed ? 'Развернуть' : 'Свернуть'}
            style={{ justifyContent: collapsed ? 'center' : undefined }}
          >
            <PanelLeft className="nav-icon" size={20} />
            <span className="nav-label">Свернуть</span>
          </button>
        </div>
      </aside>

      {/* Header */}
      <header className={`main-header ${collapsed ? 'collapsed-sidebar' : ''}`}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/help')} style={{ fontWeight: 600 }}>
          <HelpCircle size={18} /> Помощь
        </button>

        {/* Global search */}
        <div className="search-wrap" style={{ flex: 1, maxWidth: 460, marginLeft: 6 }}>
          <span className="search-icon"><Search size={17} /></span>
          <input
            ref={searchRef}
            className="input input-search"
            placeholder="Поиск ученика по имени…"
            value={globalSearch}
            onChange={e => { setGlobalSearch(e.target.value); setSearchOpen(true) }}
            onFocus={() => globalSearch && setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 160)}
          />
          {globalSearch && (
            <button
              className="search-clear"
              onMouseDown={() => setGlobalSearch('')}
            >
              <X size={15} />
            </button>
          )}

          {/* Search dropdown */}
          {searchOpen && globalSearch.length >= 1 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 8,
              background: 'var(--c-surface)', border: '1px solid var(--c-border-solid)',
              borderRadius: 14, boxShadow: 'var(--shadow-lg)', zIndex: 300,
              maxHeight: 340, overflowY: 'auto', padding: 6,
            }}>
              {filtered.length === 0 ? (
                <div style={{ padding: '14px 14px', color: 'var(--c-text-3)', fontSize: 14 }}>
                  Ученик не найден
                </div>
              ) : filtered.slice(0, 8).map((s: any) => (
                <button
                  key={s.id}
                  onMouseDown={() => {
                    navigate(`/students/${s.id}`)
                    setGlobalSearch('')
                    setSearchOpen(false)
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                    padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer',
                    textAlign: 'left', borderRadius: 9,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-surface-2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>
                    {s.full_name?.split(' ').map((w: string) => w[0]).slice(0, 2).join('')}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14.5 }}>{s.full_name}</div>
                    {s.grade && <div style={{ fontSize: 12.5, color: 'var(--c-text-3)' }}>{s.grade} класс</div>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* User info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, paddingLeft: 12, borderLeft: '1px solid var(--c-border-solid)' }}>
          <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
            <div style={{ fontSize: 14, fontWeight: 650 }}>{teacherName}</div>
            <div style={{ fontSize: 12, color: 'var(--c-text-3)' }}>{(me as any)?.teacher?.school || 'AutoCheck'}</div>
          </div>
          <div className="avatar" style={{ width: 40, height: 40, fontSize: 15 }}>{teacherInitials}</div>
          <button className="btn btn-ghost btn-icon" onClick={handleLogout} title="Выйти">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className={`main-content ${collapsed ? 'collapsed-sidebar' : ''}`}>
        {/* Global bulk check progress banners — one per running student */}
        {activeBulk.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {activeBulk.length > 1 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-danger btn-sm" onClick={stopAllBulkChecks}>
                  <Square size={12} /> Остановить все ({activeBulk.length})
                </button>
              </div>
            )}
            {activeBulk.map(bp => (
              <div key={bp.studentId} style={{
                background: 'var(--c-primary-light)', border: '1px solid var(--c-primary-muted)',
                borderRadius: 14, padding: '12px 18px',
                display: 'flex', alignItems: 'center', gap: 14,
              }}>
                <span className="spinner spinner-dark" style={{ width: 16, height: 16, borderWidth: 2.5, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
                    <span style={{ fontWeight: 700, color: 'var(--c-primary)' }}>
                      Проверка · {bp.done} из {bp.total}
                    </span>
                    <Link
                      to={`/students/${bp.studentId}`}
                      style={{ fontSize: 12, color: 'var(--c-primary)', textDecoration: 'none', fontWeight: 600 }}
                    >
                      к ученику →
                    </Link>
                  </div>
                  <div className="progress-bar" style={{ height: 5 }}>
                    <div className="progress-bar-fill" style={{
                      width: `${bp.total > 0 ? (bp.done / bp.total) * 100 : 0}%`,
                    }} />
                  </div>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => stopBulkCheck(bp.studentId)}>
                  <Square size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
