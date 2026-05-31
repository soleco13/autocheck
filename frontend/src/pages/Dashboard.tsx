import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Users, RefreshCw, AlertTriangle, Search,
  ChevronDown, ChevronRight, Grid2x2, List,
} from 'lucide-react'
import { getStudents, syncClassrooms } from '../api/client'
import { SkeletonDashboard } from '../components/Skeleton'
import { toast } from '../components/Toast'

type GroupBy = 'none' | 'grade' | 'classroom'
type ViewMode = 'grid' | 'list'

export default function Dashboard() {
  const qc = useQueryClient()
  const [syncing, setSyncing] = useState(false)
  const [syncingClassrooms, setSyncingClassrooms] = useState(false)
  const [search, setSearch] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('classroom')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const { data: students = [], isLoading, error } = useQuery({
    queryKey: ['students'],
    queryFn: () => getStudents(),
    staleTime: 30_000,
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return students as any[]
    return (students as any[]).filter(s => s.full_name?.toLowerCase().includes(q))
  }, [students, search])

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, items: filtered }]

    if (groupBy === 'classroom') {
      // Group by first classroom name (from platform sync)
      const map = new Map<string, any[]>()
      for (const s of filtered) {
        const classrooms: string[] = s.classrooms || []
        if (classrooms.length === 0) {
          const k = 'Без класса'
          if (!map.has(k)) map.set(k, [])
          map.get(k)!.push(s)
        } else {
          // Student can appear in multiple classrooms — add to first one only
          const k = classrooms[0]
          if (!map.has(k)) map.set(k, [])
          map.get(k)!.push(s)
        }
      }
      return Array.from(map.entries())
        .map(([key, items]) => ({ key, label: key, items }))
        .sort((a, b) => {
          if (a.key === 'Без класса') return 1
          if (b.key === 'Без класса') return -1
          return a.key.localeCompare(b.key, 'ru', { numeric: true })
        })
    }

    // Group by grade number
    const map = new Map<string, any[]>()
    for (const s of filtered) {
      const k = s.grade ? `${s.grade} класс` : 'Без класса'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(s)
    }
    return Array.from(map.entries())
      .map(([key, items]) => ({ key, label: key, items }))
      .sort((a, b) => {
        if (a.key === 'Без класса') return 1
        if (b.key === 'Без класса') return -1
        const na = parseInt(a.key), nb = parseInt(b.key)
        if (!isNaN(na) && !isNaN(nb)) return na - nb
        return a.key.localeCompare(b.key, 'ru', { numeric: true })
      })
  }, [filtered, groupBy])

  const toggleGroup = (key: string) =>
    setCollapsedGroups(prev => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key); else n.add(key)
      return n
    })

  const handleSync = async () => {
    setSyncing(true)
    try {
      await getStudents(true)
      qc.invalidateQueries({ queryKey: ['students'] })
      toast.success('Список учеников обновлён')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка синхронизации')
      qc.invalidateQueries({ queryKey: ['students'] })
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncClassrooms = async () => {
    setSyncingClassrooms(true)
    try {
      const result = await syncClassrooms()
      qc.invalidateQueries({ queryKey: ['students'] })
      if (result.error) {
        toast.error(`Классы: ${result.error}`)
      } else {
        toast.success(`Классы синхронизированы: ${result.synced} групп`)
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка синхронизации классов')
    } finally {
      setSyncingClassrooms(false)
    }
  }

  const total = (students as any[]).length
  const hasClassrooms = (students as any[]).some(s => s.classrooms?.length > 0)

  return (
    <div>
      {error && (
        <div className="card p-4 mb-5" style={{ borderColor: '#fecaca', background: 'var(--c-danger-light)' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <AlertTriangle size={16} color="var(--c-danger)" style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ margin: 0, fontWeight: 600, color: 'var(--c-danger)' }}>Ошибка загрузки</p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--c-text-2)', fontFamily: 'monospace' }}>
                {(error as any)?.message}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Мои ученики</h1>
          {!isLoading && (
            <p className="page-subtitle">
              {filtered.length !== total ? `${filtered.length} из ${total}` : `${total} учеников`}
              {hasClassrooms && <span style={{ color: 'var(--c-text-3)' }}> · {groups.filter(g => g.label && g.key !== 'Без класса').length} групп</span>}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="search-wrap" style={{ width: 220 }}>
            <span className="search-icon"><Search size={14} /></span>
            <input
              className="input input-search"
              placeholder="Поиск по имени..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ height: 36 }}
            />
          </div>

          <select
            value={groupBy}
            onChange={e => setGroupBy(e.target.value as GroupBy)}
            className="input"
            style={{ width: 'auto', height: 36, paddingTop: 4, paddingBottom: 4 }}
          >
            <option value="classroom">По классу (платформа)</option>
            <option value="grade">По номеру класса</option>
            <option value="none">Без группировки</option>
          </select>

          {/* View mode toggle */}
          <div style={{ display: 'flex', border: '1px solid var(--c-border-solid)', borderRadius: 8, overflow: 'hidden' }}>
            <button
              onClick={() => setViewMode('grid')}
              style={{
                padding: '7px 10px', border: 'none', cursor: 'pointer',
                background: viewMode === 'grid' ? 'var(--c-primary)' : 'var(--c-surface)',
                color: viewMode === 'grid' ? '#fff' : 'var(--c-text-2)',
              }}
              title="Сетка"
            >
              <Grid2x2 size={15} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              style={{
                padding: '7px 10px', border: 'none', cursor: 'pointer',
                background: viewMode === 'list' ? 'var(--c-primary)' : 'var(--c-surface)',
                color: viewMode === 'list' ? '#fff' : 'var(--c-text-2)',
              }}
              title="Список"
            >
              <List size={15} />
            </button>
          </div>

          <button onClick={handleSync} disabled={syncing} className="btn btn-secondary" style={{ height: 36 }}>
            <RefreshCw size={14} style={{ animation: syncing ? 'spin 0.7s linear infinite' : undefined }} />
            {syncing ? 'Синхронизация...' : 'Учеников'}
          </button>

          <button onClick={handleSyncClassrooms} disabled={syncingClassrooms} className="btn btn-secondary" style={{ height: 36 }}>
            <RefreshCw size={14} style={{ animation: syncingClassrooms ? 'spin 0.7s linear infinite' : undefined }} />
            {syncingClassrooms ? 'Загрузка...' : 'Классы'}
          </button>
        </div>
      </div>

      {/* No classrooms hint */}
      {!isLoading && !hasClassrooms && groupBy === 'classroom' && (
        <div className="card p-4 mb-5" style={{ borderColor: '#fde68a', background: 'var(--c-warn-light)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <AlertTriangle size={15} color="var(--c-warn)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 14, color: '#92400e' }}>
              Классы не загружены. Нажмите{' '}
              <button onClick={handleSyncClassrooms} disabled={syncingClassrooms} style={{ fontWeight: 700, color: 'var(--c-warn)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 'inherit', textDecoration: 'underline' }}>
                «Классы»
              </button>{' '}
              для синхронизации с платформой.
            </span>
          </div>
        </div>
      )}

      {/* Student list */}
      {isLoading ? (
        <SkeletonDashboard count={9} />
      ) : filtered.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><Users size={40} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>
            {search ? 'Ученик не найден' : 'Список учеников пуст'}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            {search ? 'Попробуйте другой запрос' : 'Нажмите «Учеников» для синхронизации с платформой'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: groupBy === 'none' ? 0 : 20 }}>
          {groups.map(({ key, label, items }) => {
            const isCollapsed = collapsedGroups.has(key)
            return (
              <div key={key}>
                {/* Group header */}
                {label && (
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => toggleGroup(key)}
                  >
                    {isCollapsed
                      ? <ChevronRight size={15} color="var(--c-text-3)" />
                      : <ChevronDown size={15} color="var(--c-text-3)" />
                    }
                    <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--c-text)' }}>{label}</span>
                    <span className="badge badge-gray">{items.length}</span>
                    <div style={{ flex: 1, height: 1, background: 'var(--c-border-solid)' }} />
                  </div>
                )}

                {/* Students */}
                {!isCollapsed && (
                  viewMode === 'grid' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                      {items.map((student: any) => (
                        <Link key={student.id} to={`/students/${student.id}`} style={{ textDecoration: 'none' }}>
                          <div
                            className="card"
                            style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', transition: 'box-shadow var(--transition), border-color var(--transition)' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-primary-muted)' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-border-solid)' }}
                          >
                            <div className="avatar" style={{ width: 40, height: 40, flexShrink: 0 }}>
                              {student.full_name?.charAt(0) || '?'}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{ margin: 0, fontWeight: 600, color: 'var(--c-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 14 }}>
                                {student.full_name}
                              </p>
                              {student.grade && groupBy !== 'classroom' && (
                                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>
                                  {student.grade} класс
                                </p>
                              )}
                              {student.classrooms?.length > 0 && groupBy === 'classroom' && student.classrooms.length > 1 && (
                                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--c-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  +{student.classrooms.length - 1} ещё
                                </p>
                              )}
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <tbody>
                          {items.map((student: any) => (
                            <tr key={student.id} style={{ cursor: 'pointer' }} onClick={() => window.location.href = `/students/${student.id}`}>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <div className="avatar" style={{ width: 32, height: 32, flexShrink: 0, fontSize: 13 }}>
                                    {student.full_name?.charAt(0) || '?'}
                                  </div>
                                  <span style={{ fontWeight: 500 }}>{student.full_name}</span>
                                </div>
                              </td>
                              <td style={{ width: 120, color: 'var(--c-text-2)', fontSize: 13 }}>
                                {student.grade ? `${student.grade} класс` : '—'}
                              </td>
                              <td style={{ width: 200, fontSize: 13, color: 'var(--c-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {student.classrooms?.join(', ') || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
