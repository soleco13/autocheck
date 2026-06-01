import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, RefreshCw, AlertTriangle, Search, Grid2x2, List, ChevronRight, X } from 'lucide-react'
import { getStudents, syncClassrooms } from '../api/client'
import { toast } from '../components/Toast'

function SkelLine({ w = '100%', h = 14, mb = 0 }: { w?: string | number; h?: number; mb?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, marginBottom: mb, borderRadius: 8 }} />
}

function StudentGridCard({ student, onClick }: { student: any; onClick: () => void }) {
  const initials = (student.full_name || '?').split(' ').map((w: string) => w[0]).slice(0, 2).join('')
  const classrooms: string[] = student.classrooms ?? []

  return (
    <button onClick={onClick} className="card card-pad"
      style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid var(--c-border-solid)', transition: 'all 0.18s', display: 'block', width: '100%' }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = 'var(--shadow-md)'; el.style.transform = 'translateY(-2px)'; el.style.borderColor = 'var(--c-primary-muted)' }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = ''; el.style.transform = ''; el.style.borderColor = 'var(--c-border-solid)' }}>

      {/* Avatar + name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: classrooms.length > 0 ? 14 : 0 }}>
        <div className="avatar" style={{ width: 50, height: 50, fontSize: 19, flexShrink: 0 }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {student.full_name}
          </div>
          <div style={{ fontSize: 13, color: 'var(--c-text-3)', marginTop: 2 }}>
            {student.grade ? `${student.grade} класс` : 'Класс не указан'}
          </div>
        </div>
      </div>

      {/* Classrooms as tags */}
      {classrooms.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {classrooms.slice(0, 3).map(c => (
            <span key={c} style={{
              fontSize: 12, fontWeight: 600, color: 'var(--c-teal)',
              background: 'var(--c-teal-light)', padding: '3px 10px', borderRadius: 99,
              whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{c}</span>
          ))}
          {classrooms.length > 3 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-3)', background: 'var(--c-surface-3)', padding: '3px 10px', borderRadius: 99 }}>
              +{classrooms.length - 3}
            </span>
          )}
        </div>
      )}
    </button>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [syncing, setSyncing] = useState(false)
  const [syncingClassrooms, setSyncingClassrooms] = useState(false)
  const [search, setSearch] = useState('')
  const [classroomFilter, setClassroomFilter] = useState('')
  const [gradeFilter, setGradeFilter] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')

  const { data: students = [], isLoading } = useQuery({
    queryKey: ['students'],
    queryFn: () => getStudents(),
    staleTime: 30_000,
  })

  const allStudents = students as any[]

  // Unique sorted classrooms from platform data
  const classrooms = useMemo(() => {
    const set = new Set<string>()
    allStudents.forEach(s => (s.classrooms ?? []).forEach((c: string) => set.add(c)))
    return [...set].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))
  }, [allStudents])

  // Unique grades
  const grades = useMemo(() =>
    [...new Set(allStudents.map(s => s.grade).filter(Boolean))].sort((a, b) => a - b),
    [allStudents])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allStudents.filter(s => {
      if (q && !s.full_name?.toLowerCase().includes(q)) return false
      if (classroomFilter && !(s.classrooms ?? []).includes(classroomFilter)) return false
      if (gradeFilter && String(s.grade) !== gradeFilter) return false
      return true
    })
  }, [allStudents, search, classroomFilter, gradeFilter])

  const hasClassrooms = allStudents.some(s => s.classrooms?.length > 0)

  const handleSync = async () => {
    setSyncing(true)
    try {
      await getStudents(true)
      qc.invalidateQueries({ queryKey: ['students'] })
      toast.success('Список учеников обновлён')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка синхронизации')
      qc.invalidateQueries({ queryKey: ['students'] })
    } finally { setSyncing(false) }
  }

  const handleSyncClassrooms = async () => {
    setSyncingClassrooms(true)
    try {
      const result = await syncClassrooms()
      qc.invalidateQueries({ queryKey: ['students'] })
      if (result.error) toast.error(`Классы: ${result.error}`)
      else toast.success(`Классы синхронизированы: ${result.synced} групп`)
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка синхронизации классов')
    } finally { setSyncingClassrooms(false) }
  }

  const resetFilters = () => { setSearch(''); setClassroomFilter(''); setGradeFilter('') }
  const hasFilters = !!(search || classroomFilter || gradeFilter)

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Ученики</h1>
          {!isLoading && (
            <p className="page-subtitle">
              {filtered.length !== allStudents.length
                ? `${filtered.length} из ${allStudents.length}`
                : `${allStudents.length} учеников`}
              {hasClassrooms && ` · ${classrooms.length} групп`}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="segmented">
            <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Сетка">
              <Grid2x2 size={15} />
            </button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="Список">
              <List size={15} />
            </button>
          </div>
          <button onClick={handleSync} disabled={syncing} className="btn btn-secondary btn-sm">
            <RefreshCw size={14} style={{ animation: syncing ? 'spin 0.7s linear infinite' : undefined }} />
            {syncing ? 'Синхронизация...' : 'Обновить'}
          </button>
          <button onClick={handleSyncClassrooms} disabled={syncingClassrooms} className="btn btn-secondary btn-sm">
            <RefreshCw size={14} style={{ animation: syncingClassrooms ? 'spin 0.7s linear infinite' : undefined }} />
            {syncingClassrooms ? 'Загрузка...' : 'Синхр. классы'}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div className="filter-bar">
          <div className="search-wrap" style={{ flex: 1, minWidth: 200 }}>
            <span className="search-icon"><Search size={17} /></span>
            <input className="input input-search" placeholder="Поиск по имени…" value={search}
              onChange={e => setSearch(e.target.value)} />
            {search && <button className="search-clear" onClick={() => setSearch('')}><X size={15} /></button>}
          </div>

          {/* Classroom filter — main filter from platform */}
          {classrooms.length > 0 && (
            <select className="input" style={{ width: 'auto', maxWidth: 220 }}
              value={classroomFilter} onChange={e => setClassroomFilter(e.target.value)}>
              <option value="">Все группы ({allStudents.length})</option>
              {classrooms.map(c => {
                const cnt = allStudents.filter(s => (s.classrooms ?? []).includes(c)).length
                return <option key={c} value={c}>{c} ({cnt})</option>
              })}
            </select>
          )}

          {/* Grade filter */}
          {grades.length > 0 && (
            <select className="input" style={{ width: 'auto' }}
              value={gradeFilter} onChange={e => setGradeFilter(e.target.value)}>
              <option value="">Все классы</option>
              {grades.map(g => <option key={g} value={String(g)}>{g} класс</option>)}
            </select>
          )}

          {hasFilters && (
            <button onClick={resetFilters} className="btn btn-ghost btn-sm">
              <X size={13} /> Сбросить
            </button>
          )}

          <div style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--c-text-3)', fontWeight: 600 }}>
            {filtered.length}
          </div>
        </div>
      </div>

      {/* Student list */}
      {isLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="card card-pad">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
                <SkelLine w={50} h={50} />
                <div style={{ flex: 1 }}><SkelLine w="70%" h={14} mb={6} /><SkelLine w="40%" h={12} /></div>
              </div>
              <SkelLine w="80%" h={22} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><Users size={40} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>
            {hasFilters ? 'Ничего не найдено' : 'Список учеников пуст'}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            {hasFilters ? 'Попробуйте изменить фильтры' : 'Нажмите «Обновить» для синхронизации с платформой'}
          </p>
        </div>
      ) : view === 'grid' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {filtered.map((s: any) => (
            <StudentGridCard key={s.id} student={s} onClick={() => navigate(`/students/${s.id}`)} />
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Ученик</th>
                <th style={{ width: 100 }}>Класс</th>
                <th>Группы с платформы</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s: any) => {
                const initials = (s.full_name || '?').split(' ').map((w: string) => w[0]).slice(0, 2).join('')
                const cls: string[] = s.classrooms ?? []
                return (
                  <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/students/${s.id}`)}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div className="avatar" style={{ width: 38, height: 38, fontSize: 14, flexShrink: 0 }}>{initials}</div>
                        <span style={{ fontWeight: 600 }}>{s.full_name}</span>
                      </div>
                    </td>
                    <td>
                      {s.grade ? <span className="badge badge-gray">{s.grade} кл.</span> : <span style={{ color: 'var(--c-text-3)' }}>—</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {cls.length > 0
                          ? cls.slice(0, 3).map(c => (
                            <span key={c} style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-teal)', background: 'var(--c-teal-light)', padding: '2px 9px', borderRadius: 99 }}>{c}</span>
                          ))
                          : <span style={{ color: 'var(--c-text-3)', fontSize: 13 }}>—</span>}
                        {cls.length > 3 && <span style={{ fontSize: 12, color: 'var(--c-text-3)' }}>+{cls.length - 3}</span>}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={18} color="var(--c-text-3)" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !hasClassrooms && (
        <div className="card" style={{ marginTop: 18, padding: '14px 18px', borderColor: '#fde68a', background: 'var(--c-warn-light)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <AlertTriangle size={15} color="var(--c-warn)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 14, color: '#92400e' }}>
              Группы с платформы не загружены.{' '}
              <button onClick={handleSyncClassrooms} disabled={syncingClassrooms}
                style={{ fontWeight: 700, color: 'var(--c-warn)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                Синхронизировать
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
