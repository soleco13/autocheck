import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { History as HistoryIcon, Search, FileText, Filter, X } from 'lucide-react'
import { getStudents } from '../api/client'
import api from '../api/client'
import { SkeletonTable } from '../components/Skeleton'
import { StatusBadge, GradeBadge } from '../components/StatusBadge'

function formatDate(ts: string | null) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch { return '—' }
}

const getHistory = (params: { page: number; pageSize: number; studentId?: string; status?: string; search?: string }) => {
  const p: Record<string, string> = {
    page: String(params.page),
    pageSize: String(params.pageSize),
  }
  if (params.studentId) p.studentId = params.studentId
  if (params.status) p.status = params.status
  if (params.search) p.search = params.search
  return api.get('/reports/history', { params: p }).then(r => r.data).catch(() => ({ reports: [], pagination: { total: 0, totalPages: 1, page: 1 } }))
}

export default function History() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [studentFilter, setStudentFilter] = useState('')

  const debouncedSearch = search
  const hasFilters = !!(statusFilter || studentFilter || search)

  const { data: studentsData = [] } = useQuery({
    queryKey: ['students'],
    queryFn: () => getStudents(),
    staleTime: 60_000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['history', page, debouncedSearch, statusFilter, studentFilter],
    queryFn: () => getHistory({ page, pageSize: 20, status: statusFilter, studentId: studentFilter, search: debouncedSearch }),
    placeholderData: prev => prev,
    staleTime: 30_000,
  })

  const reports: any[] = data?.reports ?? []
  const pagination = data?.pagination ?? { total: 0, totalPages: 1, page: 1 }

  const resetFilters = () => { setSearch(''); setStatusFilter(''); setStudentFilter(''); setPage(1) }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">История проверок</h1>
          {!isLoading && (
            <p className="page-subtitle">{pagination.total} записей</p>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="filter-bar mb-5">
        <Filter size={14} color="var(--c-text-3)" style={{ flexShrink: 0 }} />

        {/* Search */}
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--c-text-2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Поиск
          </label>
          <div className="search-wrap">
            <span className="search-icon"><Search size={13} /></span>
            <input
              className="input input-search"
              placeholder="Название работы..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              style={{ width: 200, height: 34, paddingTop: 4, paddingBottom: 4 }}
            />
          </div>
        </div>

        {/* Student */}
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--c-text-2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Ученик
          </label>
          <select
            value={studentFilter}
            onChange={e => { setStudentFilter(e.target.value); setPage(1) }}
            className="input"
            style={{ width: 200, height: 34, paddingTop: 4, paddingBottom: 4 }}
          >
            <option value="">Все ученики</option>
            {(studentsData as any[]).map(s => (
              <option key={s.id} value={s.id}>{s.full_name}</option>
            ))}
          </select>
        </div>

        {/* Status */}
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--c-text-2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Статус
          </label>
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
            className="input"
            style={{ width: 160, height: 34, paddingTop: 4, paddingBottom: 4 }}
          >
            <option value="">Все статусы</option>
            <option value="completed">Проверено</option>
            <option value="manual_required">Частично</option>
            <option value="error">Ошибка</option>
          </select>
        </div>

        {hasFilters && (
          <button
            onClick={resetFilters}
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 20, alignSelf: 'flex-end' }}
          >
            <X size={13} />
            Сбросить
          </button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <SkeletonTable rows={8} />
      ) : reports.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><HistoryIcon size={36} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>История пуста</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            {hasFilters ? 'Ничего не найдено — попробуйте изменить фильтры' : 'Здесь будут отображаться завершённые проверки'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Работа</th>
                <th style={{ width: 160 }}>Ученик</th>
                <th style={{ width: 110 }}>Статус</th>
                <th style={{ width: 100 }}>Оценка</th>
                <th style={{ width: 110 }}>Дата</th>
                <th style={{ width: 80, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <p style={{ margin: 0, fontWeight: 500 }}>{r.title || 'Без названия'}</p>
                    {r.topic && (
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>{r.topic}</p>
                    )}
                  </td>
                  <td style={{ color: 'var(--c-text-2)', fontSize: 13 }}>
                    <Link
                      to={`/students/${r.student_id}`}
                      style={{ color: 'var(--c-primary)', textDecoration: 'none' }}
                      onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                    >
                      {r.student_name}
                    </Link>
                    {r.grade && <span style={{ color: 'var(--c-text-3)' }}> · {r.grade} кл.</span>}
                  </td>
                  <td><StatusBadge status={r.status || 'completed'} /></td>
                  <td>
                    {r.report_grade && <GradeBadge grade={r.report_grade} />}
                    {r.percentage != null && (
                      <span style={{ fontSize: 12, color: 'var(--c-text-2)', marginLeft: 6 }}>
                        {Math.round(Number(r.percentage))}%
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--c-text-2)' }}>{formatDate(r.generated_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Link
                      to={`/reports/${r.id}`}
                      className="btn btn-secondary btn-sm"
                      style={{ textDecoration: 'none' }}
                    >
                      <FileText size={12} />
                      Отчёт
                    </Link>
                  </td>
                </tr>
              ))}
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
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="btn btn-secondary btn-sm">
              Назад
            </button>
            <button onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))} disabled={page >= pagination.totalPages} className="btn btn-secondary btn-sm">
              Вперёд
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
