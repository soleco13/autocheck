import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Search, FileText, X } from 'lucide-react'
import { getStudents } from '../api/client'
import api from '../api/client'
import { GradeBadge, StatusBadge } from '../components/StatusBadge'

function formatDate(ts: string | null) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '—' }
}

const getHistory = (params: { page: number; pageSize: number; studentId?: string; status?: string; search?: string }) => {
  const p: Record<string, string> = { page: String(params.page), pageSize: String(params.pageSize) }
  if (params.studentId) p.studentId = params.studentId
  if (params.status) p.status = params.status
  if (params.search) p.search = params.search
  return api.get('/reports/history', { params: p }).then(r => r.data).catch(() => ({ reports: [], pagination: { total: 0, totalPages: 1, page: 1 } }))
}

function SkelTable({ rows = 8 }: { rows?: number }) {
  return (
    <div className="table-wrap">
      <div style={{ padding: '13px 18px', background: 'var(--c-surface-2)', borderBottom: '1px solid var(--c-border-solid)' }}>
        <div className="skeleton" style={{ width: 180, height: 12, borderRadius: 8 }} />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 18px', borderBottom: i < rows - 1 ? '1px solid var(--c-border-solid)' : 'none' }}>
          <div className="skeleton" style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0 }} />
          <div className="skeleton" style={{ width: '40%', height: 13, borderRadius: 8 }} />
          <div style={{ flex: 1 }} />
          <div className="skeleton" style={{ width: 90, height: 22, borderRadius: 99 }} />
          <div className="skeleton" style={{ width: 70, height: 28, borderRadius: 8 }} />
        </div>
      ))}
    </div>
  )
}

export default function History() {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [studentFilter, setStudentFilter] = useState('')
  const hasFilters = !!(statusFilter || studentFilter || search)

  const { data: studentsData = [] } = useQuery({
    queryKey: ['students'],
    queryFn: () => getStudents(),
    staleTime: 60_000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['history', page, search, statusFilter, studentFilter],
    queryFn: () => getHistory({ page, pageSize: 20, status: statusFilter, studentId: studentFilter, search }),
    placeholderData: prev => prev,
    staleTime: 30_000,
  })

  const reports: any[] = data?.reports ?? []
  const pagination = data?.pagination ?? { total: 0, totalPages: 1, page: 1 }

  const resetFilters = () => { setSearch(''); setStatusFilter(''); setStudentFilter(''); setPage(1) }

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">История проверок</h1>
          {!isLoading && <p className="page-subtitle">{pagination.total} проверенных работ</p>}
        </div>
      </div>

      {/* Filter bar */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div className="filter-bar">
          <div className="search-wrap" style={{ flex: 1, minWidth: 240 }}>
            <span className="search-icon"><Search size={17} /></span>
            <input className="input input-search" placeholder="Поиск по ученику или материалу…" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
            {search && <button className="search-clear" onClick={() => { setSearch(''); setPage(1) }}><X size={15} /></button>}
          </div>
          <select className="input" style={{ width: 'auto' }} value={studentFilter} onChange={e => { setStudentFilter(e.target.value); setPage(1) }}>
            <option value="">Все ученики</option>
            {(studentsData as any[]).map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
            <option value="">Любой статус</option>
            <option value="completed">Проверено</option>
            <option value="manual_required">Ручная проверка</option>
            <option value="error">Ошибка</option>
          </select>
          {hasFilters && (
            <button onClick={resetFilters} className="btn btn-ghost btn-sm">
              <X size={13} /> Сбросить
            </button>
          )}
          <div style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--c-text-3)', fontWeight: 600 }}>
            Найдено: {pagination.total}
          </div>
        </div>
      </div>

      {isLoading ? (
        <SkelTable rows={8} />
      ) : reports.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><FileText size={40} strokeWidth={1.5} /></div>
          <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 6px' }}>{hasFilters ? 'Записей не найдено' : 'История пуста'}</p>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-3)' }}>{hasFilters ? 'Измените параметры поиска' : 'Здесь будут отображаться завершённые проверки'}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Ученик</th>
                <th>Материал</th>
                <th style={{ width: 130 }}>Дата</th>
                <th style={{ width: 100 }}>Результат</th>
                <th style={{ width: 90 }}>Оценка</th>
                <th style={{ width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r: any) => {
                const initials = (r.student_name || '?').split(' ').map((w: string) => w[0]).slice(0, 2).join('')
                const pct = r.percentage != null ? Math.round(Number(r.percentage)) : null
                return (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/reports/${r.id}`)}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                        <div className="avatar" style={{ width: 34, height: 34, fontSize: 12, flexShrink: 0 }}>{initials}</div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{r.student_name || '—'}</div>
                          {r.grade && <div style={{ fontSize: 12.5, color: 'var(--c-text-3)' }}>{r.grade} класс</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 550 }}>{r.title || 'Без названия'}</div>
                      {r.topic && <div style={{ fontSize: 12.5, color: 'var(--c-text-3)', marginTop: 2 }}>{r.topic}</div>}
                    </td>
                    <td>
                      <div style={{ fontSize: 13.5, color: 'var(--c-text-2)' }}>{formatDate(r.generated_at)}</div>
                    </td>
                    <td>
                      {pct != null && (
                        <span style={{ fontWeight: 800, fontSize: 15.5, color: pct >= 70 ? 'var(--c-success)' : pct >= 50 ? 'var(--c-warn)' : 'var(--c-danger)' }}>
                          {pct}%
                        </span>
                      )}
                    </td>
                    <td>{r.report_grade && <GradeBadge grade={r.report_grade} />}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/reports/${r.id}`) }}>
                        <FileText size={13} /> Отчёт
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>
            Стр. {pagination.page} из {pagination.totalPages} · {pagination.total} записей
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="btn btn-secondary btn-sm">Назад</button>
            <button onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))} disabled={page >= pagination.totalPages} className="btn btn-secondary btn-sm">Вперёд</button>
          </div>
        </div>
      )}
    </div>
  )
}
