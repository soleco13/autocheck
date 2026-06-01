import { useState, useMemo, FormEvent } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft, Play, FileText, Filter,
  AlertTriangle, Clock, ExternalLink, Layers, Square, Search, X,
} from 'lucide-react'
import { getStudent, getStudentWorks } from '../api/client'
import { Skeleton, SkeletonTable } from '../components/Skeleton'
import { StatusBadge, GradeBadge } from '../components/StatusBadge'
import { toast } from '../components/Toast'
import { useCheckContext } from '../context/CheckContext'

const PAGE_SIZE = 20
const EDIK_BASE = 'https://editor.good-teach.itgen.io'

export default function StudentCard() {
  const { id } = useParams<{ id: string }>()
  const { checking, checkStatuses, bulkChecks, runCheck, startBulkCheck, stopBulkCheck } = useCheckContext()
  const bulkProgress = bulkChecks.get(id!)
  const myBulkRunning = !!bulkProgress

  const [showNewCheck, setShowNewCheck] = useState(false)
  const [newEditorUrl, setNewEditorUrl] = useState('')
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')

  const { data: student, isLoading: loadingStudent } = useQuery({
    queryKey: ['student', id],
    queryFn: () => getStudent(id!),
  })

  const { data: worksData, isLoading: loadingWorks, error: worksLoadError, refetch } = useQuery({
    queryKey: ['student-works', id],
    queryFn: () => getStudentWorks(id!),
  })

  const works: any[] = worksData?.works ?? []
  const platformError: string | null = worksData?.platformError ?? null

  const filtered = useMemo(() => {
    let list = works
    if (statusFilter === 'checked') list = list.filter(w => !!w.check_status)
    else if (statusFilter === 'unchecked') list = list.filter(w => !w.check_status)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      list = list.filter(w =>
        (w.title || '').toLowerCase().includes(q) ||
        (w.topic || '').toLowerCase().includes(q) ||
        (w.platform_material_id || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [works, statusFilter, searchQuery])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const pagedWorks = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const checkedCount = works.filter(w => !!w.check_status).length
  const uncheckedCount = works.filter(w => !w.check_status).length
  // Only unchecked works with a trainerToken can be bulk-checked
  const uncheckedWithToken = works.filter(w => !w.check_status && w.trainer_token)

  // Is bulk running for THIS student?

  const handleNewCheck = (e: FormEvent) => {
    e.preventDefault()
    const url = newEditorUrl.trim()
    if (!url) return
    // Extract JWT from URL (https://editor.../s/{JWT}) or use bare JWT
    const jwtMatch = url.match(/\/s\/([^/?#]+)/)
    const token = jwtMatch ? jwtMatch[1] : url
    runCheck(id!, url, token, () => refetch())
    setShowNewCheck(false)
    setNewEditorUrl('')
  }

  const isLoading = loadingStudent || loadingWorks

  return (
    <div>
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <Link to="/students"><ArrowLeft size={13} style={{ marginRight: 2 }} />Ученики</Link>
        <span className="breadcrumb-sep">/</span>
        {loadingStudent
          ? <Skeleton width={120} height={13} />
          : <span style={{ color: 'var(--c-text)' }}>{student?.full_name}</span>
        }
      </div>

      {/* Student info card */}
      <div className="card p-5 mb-5">
        {loadingStudent ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Skeleton width={52} height={52} style={{ borderRadius: '50%' }} />
            <div style={{ flex: 1 }}>
              <Skeleton height={18} width="45%" style={{ marginBottom: 8 }} />
              <Skeleton height={13} width="25%" />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div className="avatar" style={{ width: 52, height: 52, fontSize: 20 }}>
              {student?.full_name?.charAt(0) || '?'}
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{student?.full_name}</h1>
              {student?.grade && (
                <p style={{ margin: '3px 0 0', color: 'var(--c-text-2)', fontSize: 13 }}>
                  {student.grade} класс
                </p>
              )}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{works.length}</p>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--c-text-3)' }}>Работ</p>
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--c-success)' }}>{checkedCount}</p>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--c-text-3)' }}>Проверено</p>
              </div>
              {uncheckedCount > 0 && (
                <div style={{ textAlign: 'center' }}>
                  <p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--c-warn)' }}>{uncheckedCount}</p>
                  <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--c-text-3)' }}>Ожидают</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Errors */}
      {platformError && (
        <div className="card p-4 mb-4" style={{ borderColor: '#fde68a', background: 'var(--c-warn-light)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle size={15} color="var(--c-warn)" style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ margin: 0, fontWeight: 600, color: '#92400e', fontSize: 13 }}>
                Не удалось загрузить материалы с платформы
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 12, fontFamily: 'monospace', color: '#b45309' }}>
                {platformError}
              </p>
            </div>
          </div>
        </div>
      )}
      {worksLoadError && (
        <div className="card p-4 mb-4" style={{ borderColor: '#fecaca', background: 'var(--c-danger-light)' }}>
          <AlertTriangle size={15} color="var(--c-danger)" style={{ marginRight: 8 }} />
          <span style={{ fontSize: 13, color: 'var(--c-danger)' }}>
            {(worksLoadError as any)?.response?.data?.error || (worksLoadError as any)?.message}
          </span>
        </div>
      )}

      {/* Works header */}
      <div className="page-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Работы
            {works.length > 0 && (
              <span style={{ color: 'var(--c-text-3)', fontWeight: 400, marginLeft: 6 }}>
                ({filtered.length}{filtered.length !== works.length ? ` из ${works.length}` : ''})
              </span>
            )}
          </h2>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Search */}
          {works.length > 0 && (
            <div className="search-wrap" style={{ width: 220 }}>
              <span className="search-icon"><Search size={13} /></span>
              <input
                className="input input-search"
                placeholder="Поиск по материалу..."
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setPage(1) }}
                style={{ height: 34 }}
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); setPage(1) }}
                  style={{ position: 'absolute', right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-3)', display: 'flex', padding: 2 }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          {/* Status filter */}
          {works.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Filter size={13} color="var(--c-text-3)" />
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
                className="input"
                style={{ width: 'auto', height: 34, paddingTop: 4, paddingBottom: 4 }}
              >
                <option value="">Все работы</option>
                <option value="unchecked">Не проверено ({uncheckedCount})</option>
                <option value="checked">Проверено ({checkedCount})</option>
              </select>
            </div>
          )}

          {/* Bulk buttons */}
          {uncheckedWithToken.length > 0 && !myBulkRunning && (
            <div style={{ display: 'flex', gap: 6 }}>
              {[10, 50].map(n => uncheckedWithToken.length >= n && (
                <button
                  key={n}
                  onClick={() => startBulkCheck(id!, works, n, () => refetch())}
                  disabled={myBulkRunning}
                  className="btn btn-secondary btn-sm"
                  title={`Проверить первые ${n} непроверенных работ`}
                >
                  <Layers size={12} />
                  {n} работ
                </button>
              ))}
              <button
                onClick={() => startBulkCheck(id!, works, 'all', () => refetch())}
                disabled={myBulkRunning}
                className="btn btn-secondary btn-sm"
                title={`Проверить все ${uncheckedWithToken.length} непроверенных работ`}
              >
                <Layers size={12} />
                Все ({uncheckedWithToken.length})
              </button>
            </div>
          )}

          {/* Stop bulk button — shown when bulk is running for this student */}
          {myBulkRunning && (
            <button
              onClick={() => stopBulkCheck(id!)}
              className="btn btn-sm"
              style={{ background: 'var(--c-danger)', color: '#fff', border: 'none', gap: 5 }}
            >
              <Square size={12} />
              Остановить ({bulkProgress?.done ?? 0}/{bulkProgress?.total ?? 0})
            </button>
          )}

          {/* Manual check */}
          <button
            onClick={() => setShowNewCheck(v => !v)}
            className={`btn ${showNewCheck ? 'btn-secondary' : 'btn-primary'} btn-sm`}
            style={{ height: 34 }}
          >
            <Play size={13} />
            {showNewCheck ? 'Отмена' : 'По URL'}
          </button>
        </div>
      </div>

      {/* Manual check form */}
      {showNewCheck && (
        <div className="card p-5 mb-4" style={{ borderColor: 'var(--c-primary-muted)' }}>
          <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14 }}>Проверить по URL</p>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--c-text-2)' }}>
            Откройте работу ученика на платформе, скопируйте URL из браузера и вставьте сюда
          </p>
          <form onSubmit={handleNewCheck} style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={newEditorUrl}
              onChange={e => setNewEditorUrl(e.target.value)}
              placeholder="https://editor.good-teach.itgen.io/s/eyJhbGci..."
              required
              className="input"
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn btn-primary">
              Проверить
            </button>
          </form>
        </div>
      )}

      {/* Works table */}
      {isLoading ? (
        <SkeletonTable rows={6} />
      ) : filtered.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><FileText size={36} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>Работ не найдено</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            {statusFilter ? 'Нет работ с таким статусом' : 'Нет назначенных материалов'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Материал</th>
                <th style={{ width: 140 }}>Статус</th>
                <th style={{ width: 120 }}>Оценка</th>
                <th style={{ width: 190, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {pagedWorks.map((work: any, idx: number) => {
                const matId = work.platform_material_id
                const isItemChecking = checking.has(matId)
                const itemStatus = checkStatuses[matId]
                const hasReport = !!work.check_status && !!work.id
                const edikUrl = work.trainer_token
                  ? `${EDIK_BASE}/s/${work.trainer_token}`
                  : null

                return (
                  <tr
                    key={work.id || `p-${matId}-${idx}`}
                    style={{ cursor: edikUrl ? 'pointer' : undefined }}
                    onClick={e => {
                      const t = e.target as HTMLElement
                      if (edikUrl && !t.closest('a') && !t.closest('button')) {
                        window.open(edikUrl, '_blank', 'noopener,noreferrer')
                      }
                    }}
                  >
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div>
                          <p style={{ margin: 0, fontWeight: 500, color: 'var(--c-text)' }}>
                            {work.title || matId}
                          </p>
                          {work.topic && (
                            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>
                              {work.topic}
                            </p>
                          )}
                        </div>
                        {edikUrl && (
                          <a
                            href={edikUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Открыть работу ученика в Edik"
                            onClick={e => e.stopPropagation()}
                            style={{ color: 'var(--c-text-3)', display: 'flex', flexShrink: 0 }}
                          >
                            <ExternalLink size={13} />
                          </a>
                        )}
                      </div>
                    </td>
                    <td>
                      {isItemChecking && itemStatus ? (
                        <span className="check-progress">
                          <span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} />
                          {itemStatus === 'queued' ? 'В очереди'
                            : itemStatus === 'processing' ? 'Проверка...'
                            : itemStatus}
                        </span>
                      ) : work.check_status ? (
                        <StatusBadge status={work.check_status} />
                      ) : (
                        <span className="badge badge-gray"><Clock size={10} />Не проверено</span>
                      )}
                    </td>
                    <td>
                      {work.report_grade && <GradeBadge grade={work.report_grade} />}
                      {work.percentage != null && (
                        <span style={{ fontSize: 12, color: 'var(--c-text-2)', marginLeft: 6 }}>
                          {Math.round(work.percentage)}%
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                        {hasReport && (
                          <Link to={`/reports/${work.id}`} className="btn btn-secondary btn-sm">
                            <FileText size={12} />
                            Отчёт
                          </Link>
                        )}
                        <button
                          onClick={() => runCheck(id!, matId, work.trainer_token, () => refetch())}
                          disabled={isItemChecking}
                          className="btn btn-primary btn-sm"
                          title={work.check_status ? 'Перепроверить' : 'Проверить'}
                        >
                          {isItemChecking
                            ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                            : <><Play size={12} />{work.check_status ? 'Ещё раз' : 'Проверить'}</>
                          }
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>
            Стр. {page} из {totalPages} · {filtered.length} работ
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="btn btn-secondary btn-sm">Назад</button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const start = Math.max(1, Math.min(page - 2, totalPages - 4))
              return start + i
            }).map(p => (
              <button key={p} onClick={() => setPage(p)} className="btn btn-sm" style={{
                background: p === page ? 'var(--c-primary)' : 'var(--c-surface)',
                color: p === page ? '#fff' : 'var(--c-text)',
                border: '1px solid var(--c-border-solid)',
              }}>{p}</button>
            ))}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="btn btn-secondary btn-sm">Вперёд</button>
          </div>
        </div>
      )}
    </div>
  )
}
