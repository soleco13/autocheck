import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, X, Search, ExternalLink, FileText } from 'lucide-react'
import { getMaterials } from '../api/client'

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

function SkelTable({ rows = 8 }: { rows?: number }) {
  return (
    <div className="table-wrap">
      <div style={{ padding: '13px 18px', background: 'var(--c-surface-2)', borderBottom: '1px solid var(--c-border-solid)' }}>
        <div className="skeleton" style={{ width: 180, height: 12, borderRadius: 8 }} />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', borderBottom: i < rows - 1 ? '1px solid var(--c-border-solid)' : 'none' }}>
          <div className="skeleton" style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0 }} />
          <div style={{ flex: 1 }}><div className="skeleton" style={{ width: '60%', height: 13, borderRadius: 8, marginBottom: 6 }} /><div className="skeleton" style={{ width: '30%', height: 11, borderRadius: 8 }} /></div>
          <div className="skeleton" style={{ width: 80, height: 22, borderRadius: 99 }} />
        </div>
      ))}
    </div>
  )
}

export default function Materials() {
  const [page, setPage] = useState(1)
  const [grade, setGrade] = useState('')
  const [skillId, setSkillId] = useState('')
  const [type, setType] = useState('')
  const [search, setSearch] = useState('')

  const hasFilters = !!(grade || skillId || type || search)
  const resetFilters = () => { setGrade(''); setSkillId(''); setType(''); setSearch(''); setPage(1) }

  const { data, isLoading, isFetching } = useQuery<MaterialsData>({
    queryKey: ['materials', page, grade, skillId, type, search],
    queryFn: () => getMaterials({ page, pageSize: 20, grade: grade || null, skillId: skillId || null, type: type || null, search: search || null }),
    placeholderData: prev => prev,
    staleTime: 60_000,
  })

  const materials: any[] = data?.materials ?? []
  const pagination = data?.pagination ?? { page: 1, totalPages: 1, total: 0 }
  const filters = data?.filters ?? { skills: [], grades: [], types: [] }

  const cf = (fn: () => void) => { fn(); setPage(1) }

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Материалы</h1>
          {!isLoading && <p className="page-subtitle">Все учебные материалы платформы</p>}
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div className="filter-bar">
          <div className="search-wrap" style={{ flex: 1, minWidth: 240 }}>
            <span className="search-icon"><Search size={17} /></span>
            <input className="input input-search" placeholder="Поиск по названию материала…" value={search} onChange={e => cf(() => setSearch(e.target.value))} />
            {search && <button className="search-clear" onClick={() => cf(() => setSearch(''))}><X size={15} /></button>}
          </div>
          <select className="input" style={{ width: 'auto' }} value={grade} onChange={e => cf(() => setGrade(e.target.value))}>
            <option value="">Все классы</option>
            {(filters.grades as string[]).map(g => <option key={g} value={g}>{g} класс</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} value={skillId} onChange={e => cf(() => setSkillId(e.target.value))}>
            <option value="">Все предметы</option>
            {(filters.skills as any[]).map(s => <option key={s.skillId} value={s.skillId}>{s.skillName}</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} value={type} onChange={e => cf(() => setType(e.target.value))}>
            <option value="">Все типы</option>
            {(filters.types as string[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
          </select>
          {hasFilters && <button onClick={resetFilters} className="btn btn-ghost btn-sm"><X size={13} /> Сбросить</button>}
          <div style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--c-text-3)', fontWeight: 600 }}>
            Найдено: {pagination.total}
          </div>
        </div>
      </div>

      {isLoading ? (
        <SkelTable rows={8} />
      ) : materials.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><BookOpen size={40} strokeWidth={1.5} /></div>
          <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 6px' }}>Материалов не найдено</p>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-3)' }}>
            {hasFilters ? 'Измените параметры фильтрации' : 'Материалы появятся после синхронизации с платформой'}
          </p>
        </div>
      ) : (
        <div className="table-wrap" style={{ opacity: isFetching ? 0.7 : 1, transition: 'opacity 0.2s' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Материал</th>
                <th style={{ width: 150 }}>Предмет</th>
                <th style={{ width: 90 }}>Класс</th>
                <th style={{ width: 130 }}>Тип</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {materials.map((mat: any) => (
                <tr key={mat._id} style={{ cursor: 'pointer' }}
                  onClick={e => { if (!(e.target as HTMLElement).closest('a,button')) window.open(getEdikUrl(mat), '_blank', 'noopener,noreferrer') }}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--c-primary-light)', color: 'var(--c-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <FileText size={17} />
                      </span>
                      <div>
                        <Link to={`/materials/${mat._id}`} style={{ color: 'var(--c-text)', textDecoration: 'none', fontWeight: 600 }}
                          onMouseEnter={e => (e.currentTarget.style.color = 'var(--c-primary)')}
                          onMouseLeave={e => (e.currentTarget.style.color = 'var(--c-text)')}
                          onClick={e => e.stopPropagation()}>
                          {mat.title}
                        </Link>
                        {mat.taskCount != null && (
                          <div style={{ fontSize: 12.5, color: 'var(--c-text-3)', marginTop: 2 }}>{mat.taskCount} заданий</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ fontSize: 13.5, color: 'var(--c-text-2)' }}>{mat.skillName || '—'}</td>
                  <td><span className="badge badge-gray">{mat.grade ? `${mat.grade} кл.` : '—'}</span></td>
                  <td>{mat.type && <span className="badge badge-gray">{TYPE_LABEL[mat.type] || mat.type}</span>}</td>
                  <td>
                    <button title="Открыть в Edik" onClick={e => { e.stopPropagation(); window.open(getEdikUrl(mat), '_blank', 'noopener,noreferrer') }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-3)', display: 'flex', padding: 4, borderRadius: 6 }}>
                      <ExternalLink size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination.totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>Стр. {pagination.page} из {pagination.totalPages}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="btn btn-secondary btn-sm">Назад</button>
            <button onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))} disabled={page >= pagination.totalPages} className="btn btn-secondary btn-sm">Вперёд</button>
          </div>
        </div>
      )}
    </div>
  )
}
