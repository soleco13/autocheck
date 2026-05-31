import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Users, BookOpen, History as HistoryIcon, CheckCircle, Clock, AlertCircle } from 'lucide-react'
import { getStudents } from '../api/client'
import api from '../api/client'
import { useCheckContext } from '../context/CheckContext'
import { GradeBadge, StatusBadge } from '../components/StatusBadge'
import { Skeleton } from '../components/Skeleton'

function formatDate(ts: string | null) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch { return '—' }
}

const getRecentHistory = () =>
  api.get('/reports/history', { params: { page: '1', pageSize: '8' } }).then(r => r.data)
    .catch(() => ({ reports: [], pagination: { total: 0 } }))

export default function Home() {
  const { bulkRunning, bulkProgress } = useCheckContext()

  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['students'],
    queryFn: () => getStudents(),
    staleTime: 60_000,
  })

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['history', 1, '', '', ''],
    queryFn: getRecentHistory,
    staleTime: 30_000,
  })

  const recentReports: any[] = historyData?.reports ?? []
  const totalReports: number = historyData?.pagination?.total ?? 0
  const totalStudents = (students as any[]).length

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800 }}>Главная</h1>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-2)' }}>Обзор системы AutoCheck</p>
      </div>

      {/* Active bulk check banner */}
      {bulkRunning && bulkProgress && (
        <div className="card p-5 mb-5" style={{ borderColor: 'var(--c-primary-muted)', background: 'var(--c-primary-light)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="spinner spinner-dark" style={{ width: 16, height: 16, borderWidth: 2, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <p style={{ margin: '0 0 6px', fontWeight: 600, color: 'var(--c-primary)' }}>
                Идёт массовая проверка: {bulkProgress.done} / {bulkProgress.total}
              </p>
              <div style={{ height: 6, background: 'var(--c-primary-muted)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${bulkProgress.total > 0 ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%`,
                  background: 'var(--c-primary)', borderRadius: 99, transition: 'width 0.4s ease',
                }} />
              </div>
            </div>
            <Link to={`/students/${bulkProgress.studentId}`} className="btn btn-sm btn-secondary" style={{ flexShrink: 0 }}>
              Перейти
            </Link>
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 28 }}>
        <Link to="/students" style={{ textDecoration: 'none' }}>
          <div className="stat-card" style={{ cursor: 'pointer', transition: 'box-shadow var(--transition), border-color var(--transition)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-primary-muted)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-border-solid)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--c-primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Users size={18} color="var(--c-primary)" />
              </div>
              <span style={{ fontSize: 14, color: 'var(--c-text-2)', fontWeight: 500 }}>Ученики</span>
            </div>
            {studentsLoading
              ? <div className="skeleton" style={{ height: 32, width: 60 }} />
              : <p style={{ fontSize: 30, fontWeight: 800, margin: 0, color: 'var(--c-text)' }}>{totalStudents}</p>
            }
          </div>
        </Link>

        <Link to="/history" style={{ textDecoration: 'none' }}>
          <div className="stat-card" style={{ cursor: 'pointer', transition: 'box-shadow var(--transition), border-color var(--transition)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-teal)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-border-solid)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--c-teal-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CheckCircle size={18} color="var(--c-teal)" />
              </div>
              <span style={{ fontSize: 14, color: 'var(--c-text-2)', fontWeight: 500 }}>Проверок</span>
            </div>
            {historyLoading
              ? <div className="skeleton" style={{ height: 32, width: 60 }} />
              : <p style={{ fontSize: 30, fontWeight: 800, margin: 0, color: 'var(--c-text)' }}>{totalReports}</p>
            }
          </div>
        </Link>

        <Link to="/materials" style={{ textDecoration: 'none' }}>
          <div className="stat-card" style={{ cursor: 'pointer', transition: 'box-shadow var(--transition), border-color var(--transition)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; (e.currentTarget as HTMLElement).style.borderColor = '#f59e0b' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-border-solid)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: '#fffbeb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <BookOpen size={18} color="#f59e0b" />
              </div>
              <span style={{ fontSize: 14, color: 'var(--c-text-2)', fontWeight: 500 }}>Материалы</span>
            </div>
            <p style={{ fontSize: 30, fontWeight: 800, margin: 0, color: 'var(--c-text)' }}>→</p>
          </div>
        </Link>
      </div>

      {/* Recent checks */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <HistoryIcon size={17} color="var(--c-text-2)" />
          Последние проверки
        </h2>
        <Link to="/history" style={{ fontSize: 13, color: 'var(--c-primary)', textDecoration: 'none' }}>
          Все проверки →
        </Link>
      </div>

      {historyLoading ? (
        <div className="table-wrap">
          {[1,2,3,4,5].map(i => (
            <div key={i} style={{ padding: '13px 16px', borderBottom: i < 5 ? '1px solid var(--c-border-solid)' : 'none', display: 'flex', gap: 16 }}>
              <div className="skeleton" style={{ flex: 3, height: 14 }} />
              <div className="skeleton" style={{ flex: 1.5, height: 14 }} />
              <div className="skeleton" style={{ width: 70, height: 20, borderRadius: 99 }} />
              <div className="skeleton" style={{ width: 40, height: 20, borderRadius: 99 }} />
            </div>
          ))}
        </div>
      ) : recentReports.length === 0 ? (
        <div className="card empty-state" style={{ padding: '40px 32px' }}>
          <div className="empty-state-icon"><Clock size={32} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>Проверок ещё нет</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            Перейдите к ученикам и запустите первую проверку
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Работа</th>
                <th style={{ width: 170 }}>Ученик</th>
                <th style={{ width: 120 }}>Статус</th>
                <th style={{ width: 90 }}>Оценка</th>
                <th style={{ width: 100 }}>Дата</th>
                <th style={{ width: 80, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {recentReports.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <p style={{ margin: 0, fontWeight: 500 }}>{r.title || 'Без названия'}</p>
                    {r.topic && <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>{r.topic}</p>}
                  </td>
                  <td>
                    <Link
                      to={`/students/${r.student_id}`}
                      style={{ color: 'var(--c-primary)', textDecoration: 'none', fontWeight: 500 }}
                      onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                    >
                      {r.student_name}
                    </Link>
                    {r.grade && <span style={{ fontSize: 12, color: 'var(--c-text-3)', marginLeft: 5 }}>{r.grade} кл.</span>}
                  </td>
                  <td><StatusBadge status={r.status || 'completed'} /></td>
                  <td>
                    {r.report_grade && <GradeBadge grade={r.report_grade} />}
                    {r.percentage != null && (
                      <span style={{ fontSize: 12, color: 'var(--c-text-2)', marginLeft: 5 }}>{Math.round(Number(r.percentage))}%</span>
                    )}
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--c-text-2)' }}>{formatDate(r.generated_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Link to={`/reports/${r.id}`} className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
                      Отчёт
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
