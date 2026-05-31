import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Filter, BookOpen, X, Search, ExternalLink } from 'lucide-react'
import { getMaterials } from '../api/client'
import { SkeletonTable } from '../components/Skeleton'

interface MaterialsData {
  materials: any[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  filters: { skills: any[]; grades: string[]; types: string[] }
}

const TYPE_LABEL: Record<string, string> = {
  interactive: 'Интерактивный',
  test: 'Тест',
  homework: 'ДЗ',
  presentation: 'Презентация',
}

const EDIK_BASE = 'https://editor.good-teach.itgen.io'

function getEdikUrl(mat: any): string {
  if (mat.materialLink) return mat.materialLink
  return `${EDIK_BASE}/materials/${mat._id}`
}

export default function Materials() {
  const [page, setPage] = useState(1)
  const [grade, setGrade] = useState('')
  const [skillId, setSkillId] = useState('')
  const [type, setType] = useState('')
  const [search, setSearch] = useState('')

  const resetFilters = () => { setGrade(''); setSkillId(''); setType(''); setSearch(''); setPage(1) }
  const hasFilters = !!(grade || skillId || type || search)

  const { data, isLoading, isFetching } = useQuery<MaterialsData>({
    queryKey: ['materials', page, grade, skillId, type, search],
    queryFn: () => getMaterials({ page, pageSize: 20, grade: grade || null, skillId: skillId || null, type: type || null, search: search || null }),
    placeholderData: prev => prev,
    staleTime: 60_000,
  })

  const materials: any[] = data?.materials ?? []
  const pagination = data?.pagination ?? { page: 1, totalPages: 1, total: 0 }
  const filters = data?.filters ?? { skills: [], grades: [], types: [] }

  const changeFilter = (fn: () => void) => { fn(); setPage(1) }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Материалы</h1>
          {data && !isLoading && (
            <p className="page-subtitle">{pagination.total} материалов</p>
          )}
        </div>
      </div>

      {/* Filters */}
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
              placeholder="Название материала..."
              value={search}
              onChange={e => changeFilter(() => setSearch(e.target.value))}
              style={{ width: 220, height: 34, paddingTop: 4, paddingBottom: 4 }}
            />
            {search && (
              <button
                onClick={() => changeFilter(() => setSearch(''))}
                style={{ position: 'absolute', right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-3)', display: 'flex', padding: 2 }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--c-text-2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Класс
          </label>
          <select
            value={grade}
            onChange={e => changeFilter(() => setGrade(e.target.value))}
            className="input"
            style={{ width: 120, height: 34, paddingTop: 4, paddingBottom: 4 }}
          >
            <option value="">Все классы</option>
            {(filters.grades as string[]).map(g => (
              <option key={g} value={g}>{g} класс</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--c-text-2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Предмет
          </label>
          <select
            value={skillId}
            onChange={e => changeFilter(() => setSkillId(e.target.value))}
            className="input"
            style={{ width: 200, height: 34, paddingTop: 4, paddingBottom: 4 }}
          >
            <option value="">Все предметы</option>
            {(filters.skills as any[]).map(s => (
              <option key={s.skillId} value={s.skillId}>{s.skillName}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--c-text-2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Тип
          </label>
          <select
            value={type}
            onChange={e => changeFilter(() => setType(e.target.value))}
            className="input"
            style={{ width: 160, height: 34, paddingTop: 4, paddingBottom: 4 }}
          >
            <option value="">Все типы</option>
            {(filters.types as string[]).map(t => (
              <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>
            ))}
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

        {isFetching && !isLoading && (
          <div style={{ marginLeft: 'auto', alignSelf: 'flex-end', marginBottom: 4 }}>
            <span className="spinner spinner-dark" />
          </div>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <SkeletonTable rows={8} />
      ) : materials.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><BookOpen size={36} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>Материалы не найдены</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            Попробуйте изменить фильтры или поисковый запрос
          </p>
        </div>
      ) : (
        <div className="table-wrap" style={{ opacity: isFetching ? 0.7 : 1, transition: 'opacity 0.2s' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Название</th>
                <th style={{ width: 80 }}>Класс</th>
                <th style={{ width: 200 }}>Предмет</th>
                <th style={{ width: 130 }}>Тип</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {materials.map((mat: any) => (
                <tr
                  key={mat._id}
                  style={{ cursor: 'pointer' }}
                  onClick={e => {
                    // Row click → open on Edik (only if not clicking the title link itself)
                    const target = e.target as HTMLElement
                    if (!target.closest('a')) {
                      window.open(getEdikUrl(mat), '_blank', 'noopener,noreferrer')
                    }
                  }}
                >
                  <td>
                    <Link
                      to={`/materials/${mat._id}`}
                      style={{ color: 'var(--c-primary)', textDecoration: 'none', fontWeight: 500 }}
                      onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                      onClick={e => e.stopPropagation()}
                    >
                      {mat.title}
                    </Link>
                  </td>
                  <td style={{ color: 'var(--c-text-2)' }}>
                    {mat.grade ? `${mat.grade} кл.` : '—'}
                  </td>
                  <td style={{ color: 'var(--c-text-2)', fontSize: 13 }}>
                    {mat.skillName || '—'}
                  </td>
                  <td>
                    {mat.type && (
                      <span className="badge badge-gray">
                        {TYPE_LABEL[mat.type] || mat.type}
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      title="Открыть в Edik"
                      onClick={e => {
                        e.stopPropagation()
                        window.open(getEdikUrl(mat), '_blank', 'noopener,noreferrer')
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--c-text-3)', padding: '4px',
                        display: 'flex', alignItems: 'center',
                      }}
                    >
                      <ExternalLink size={13} />
                    </button>
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
            Стр. {pagination.page} из {pagination.totalPages}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="btn btn-secondary btn-sm"
            >Назад</button>
            <button
              onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
              disabled={page >= pagination.totalPages}
              className="btn btn-secondary btn-sm"
            >Вперёд</button>
          </div>
        </div>
      )}
    </div>
  )
}
