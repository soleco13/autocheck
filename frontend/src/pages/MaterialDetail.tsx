import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Play, Users, Filter, FileText, Loader2,
  Square, CheckCircle, Layers, ExternalLink,
} from 'lucide-react'
import { getMaterialStudentsDb, getMaterialStudents, startCheck, getCheckJob, bulkCheck, waitForJobs } from '../api/client'
import { SkeletonTable } from '../components/Skeleton'
import { StatusBadge, GradeBadge } from '../components/StatusBadge'
import { toast } from '../components/Toast'

const EDIK_BASE = 'https://editor.good-teach.itgen.io'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function formatDate(ts: string | null) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch { return '—' }
}

export default function MaterialDetail() {
  const { materialId } = useParams<{ materialId: string }>()
  const qc = useQueryClient()

  // Per-student individual checks (non-blocking)
  const [checking, setChecking]       = useState<Set<string>>(new Set())
  const [checkStatuses, setCheckStatuses] = useState<Record<string, string>>({})
  const [checkReports, setCheckReports]   = useState<Record<string, string>>({}) // studentId → reportId

  // Bulk check
  const [bulkRunning, setBulkRunning]   = useState(false)
  const [bulkStopped, setBulkStopped]   = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)

  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 30

  // ── Query 1: instant DB-only (checked students) ────────────────────────
  const { data: dbData, isLoading: dbLoading, error: dbError } = useQuery({
    queryKey: ['material-students-db', materialId],
    queryFn: () => getMaterialStudentsDb(materialId!),
    enabled: !!materialId,
    staleTime: 30_000,
  })

  // ── Query 2: full platform fetch (slow, runs in background) ──────────
  const { data: fullData, isFetching: platformLoading, error: platformError } = useQuery({
    queryKey: ['material-students-full', materialId],
    queryFn: () => getMaterialStudents(materialId!),
    enabled: !!materialId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })

  // Merge: full data takes priority when loaded
  const allStudents: any[] = useMemo(() => {
    if (fullData?.students) return fullData.students
    return dbData?.students ?? []
  }, [fullData, dbData])

  const platformStillLoading = platformLoading && !fullData

  const counts = fullData?.counts ?? {
    pending: 0,
    checked: dbData?.students?.length ?? 0,
    total: dbData?.students?.length ?? 0,
  }

  // Students ready to check (platform, done, not yet checked)
  const pendingStudents = useMemo(
    () => allStudents.filter((s: any) => s.status === 'done' && s.trainerToken && !s.reportId && !checkReports[s.studentId]),
    [allStudents, checkReports]
  )

  const filtered = useMemo(() => {
    if (!statusFilter) return allStudents
    return allStudents.filter((s: any) => s.status === statusFilter)
  }, [allStudents, statusFilter])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // ── Single check ─────────────────────────────────────────────────────
  const handleCheck = async (student: any) => {
    const key = student.studentId
    if (checking.has(key) || !student.trainerToken || !materialId) return
    setChecking(prev => new Set(prev).add(key))
    setCheckStatuses(prev => ({ ...prev, [key]: 'queued' }))

    try {
      const job = await startCheck(key, materialId, student.trainerToken, materialId)
      if (job.status === 'completed') {
        if (job.reportId) setCheckReports(prev => ({ ...prev, [key]: job.reportId! }))
        qc.invalidateQueries({ queryKey: ['material-students-db', materialId] })
        qc.invalidateQueries({ queryKey: ['material-students-full', materialId] })
        toast.success(`Работа ${student.fullName} проверена`)
        return
      }
      if (job.status === 'failed') throw new Error(job.error || 'Ошибка')
      if (!job.jobId) throw new Error('Не удалось поставить в очередь')

      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        await sleep(1500)
        const cur = await getCheckJob(job.jobId)
        setCheckStatuses(prev => ({ ...prev, [key]: cur.status }))
        if (cur.status === 'completed') {
          if (cur.reportId) setCheckReports(prev => ({ ...prev, [key]: cur.reportId! }))
          qc.invalidateQueries({ queryKey: ['material-students-db', materialId] })
          qc.invalidateQueries({ queryKey: ['material-students-full', materialId] })
          toast.success(`Работа ${student.fullName} проверена`)
          return
        }
        if (cur.status === 'failed') throw new Error(cur.error || 'Ошибка')
      }
      throw new Error('Превышено время ожидания')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка проверки')
    } finally {
      setChecking(prev => { const n = new Set(prev); n.delete(key); return n })
      setCheckStatuses(prev => { const n = { ...prev }; delete n[key]; return n })
    }
  }

  // ── Bulk check ────────────────────────────────────────────────────────
  const stopFlagRef = { current: false }

  const handleBulkCheck = async () => {
    if (pendingStudents.length === 0 || !materialId) return
    stopFlagRef.current = false
    setBulkRunning(true)
    setBulkStopped(false)
    setBulkProgress({ done: 0, total: pendingStudents.length })

    try {
      const items = pendingStudents.map((s: any) => ({
        studentId: s.studentId, materialId, trainerToken: s.trainerToken,
      }))
      const { jobIds } = await bulkCheck(items)
      if (jobIds.length === 0) {
        toast.success('Все работы уже поставлены в очередь')
        return
      }

      const total = jobIds.length
      const pending = new Set(jobIds)
      const deadline = Date.now() + 20 * 60_000

      while (pending.size > 0 && Date.now() < deadline) {
        if (stopFlagRef.current) {
          toast.success(`Остановлено. Проверено: ${total - pending.size} / ${total}`)
          return
        }
        await sleep(2000)
        if (stopFlagRef.current) break

        for (const jobId of [...pending]) {
          if (stopFlagRef.current) break
          try {
            const job = await getCheckJob(jobId)
            if (job.status === 'completed' || job.status === 'failed') pending.delete(jobId)
          } catch { /* skip */ }
        }

        const done = total - pending.size
        setBulkProgress({ done, total })

        if (done > 0 && (done % 5 === 0 || pending.size === 0)) {
          qc.invalidateQueries({ queryKey: ['material-students-db', materialId] })
          qc.invalidateQueries({ queryKey: ['material-students-full', materialId] })
        }
      }

      if (!stopFlagRef.current) {
        qc.invalidateQueries({ queryKey: ['material-students-db', materialId] })
        qc.invalidateQueries({ queryKey: ['material-students-full', materialId] })
        toast.success(`Проверено ${total} работ`)
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка массовой проверки')
    } finally {
      if (!stopFlagRef.current) {
        setBulkRunning(false)
        setBulkProgress(null)
      }
    }
  }

  const stopBulk = () => {
    stopFlagRef.current = true
    setBulkStopped(true)
    setBulkRunning(false)
    setBulkProgress(null)
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <Link to="/materials"><ArrowLeft size={13} style={{ marginRight: 2 }} />Материалы</Link>
        <span className="breadcrumb-sep">/</span>
        <span style={{ color: 'var(--c-text-3)', fontFamily: 'monospace', fontSize: 12 }}>{materialId}</span>
      </div>

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Ученики по материалу</h1>
          <p className="page-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {dbLoading ? (
              <span>Загрузка...</span>
            ) : (
              <>
                {counts.checked > 0 && (
                  <span style={{ color: 'var(--c-teal)' }}>
                    <CheckCircle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                    {counts.checked} проверено
                  </span>
                )}
                {counts.pending > 0 && (
                  <span style={{ color: 'var(--c-warn)' }}>· {counts.pending} ожидают</span>
                )}
                {platformStillLoading && (
                  <span style={{ color: 'var(--c-text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    · <Loader2 size={12} className="animate-spin" /> загрузка учеников с платформы...
                  </span>
                )}
              </>
            )}
          </p>
        </div>

        {/* Bulk buttons */}
        {pendingStudents.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            {bulkRunning ? (
              <button onClick={stopBulk} className="btn btn-sm" style={{ background: 'var(--c-danger)', color: '#fff', border: 'none' }}>
                <Square size={12} />
                Стоп ({bulkProgress?.done}/{bulkProgress?.total})
              </button>
            ) : (
              <>
                {pendingStudents.length >= 10 && (
                  <button onClick={() => {/* TODO: check first 10 */}} className="btn btn-secondary btn-sm">
                    <Layers size={12} /> 10
                  </button>
                )}
                <button
                  onClick={handleBulkCheck}
                  className="btn btn-primary"
                >
                  <Play size={14} />
                  Проверить все ({pendingStudents.length})
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Bulk progress bar */}
      {bulkProgress && (
        <div className="card p-4 mb-4" style={{ borderColor: 'var(--c-primary-muted)', background: 'var(--c-primary-light)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 500, color: 'var(--c-primary)' }}>Массовая проверка...</span>
            <span style={{ fontWeight: 600 }}>{bulkProgress.done} / {bulkProgress.total}</span>
          </div>
          <div className="progress-bar" style={{ height: 6 }}>
            <div
              className="progress-bar-fill"
              style={{ width: `${bulkProgress.total > 0 ? Math.round(bulkProgress.done / bulkProgress.total * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Platform loading banner */}
      {platformStillLoading && (
        <div className="card p-4 mb-4" style={{ borderColor: '#e2e8f0', background: '#f8fafc' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--c-text-2)' }}>
            <span className="spinner spinner-dark" style={{ width: 14, height: 14, borderWidth: 2, flexShrink: 0 }} />
            <span>
              Загружаем данные с платформы — это может занять до 30 секунд.
              {counts.checked > 0 && ' Уже проверенные ученики показаны ниже.'}
            </span>
          </div>
        </div>
      )}

      {/* Errors */}
      {dbError && (
        <div className="card p-4 mb-4" style={{ borderColor: '#fecaca', background: 'var(--c-danger-light)' }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>
            {(dbError as any).response?.data?.error || (dbError as any).message}
          </p>
        </div>
      )}
      {platformError && !platformLoading && (
        <div className="card p-4 mb-4" style={{ borderColor: '#fde68a', background: 'var(--c-warn-light)' }}>
          <p style={{ margin: 0, fontSize: 13, color: '#92400e' }}>
            Не удалось загрузить данные с платформы: {(platformError as any).message}
          </p>
        </div>
      )}

      {/* Filter bar */}
      {!dbLoading && allStudents.length > 0 && (
        <div className="filter-bar mb-4">
          <Filter size={14} color="var(--c-text-3)" style={{ flexShrink: 0 }} />
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--c-text-2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Статус
            </label>
            <select
              value={statusFilter}
              onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
              className="input"
              style={{ width: 180, height: 34, paddingTop: 4, paddingBottom: 4 }}
            >
              <option value="">Все ({allStudents.length})</option>
              <option value="done">Выполнено</option>
              <option value="checked">Проверено</option>
              <option value="completed">Проверено (ИИ)</option>
              <option value="inProgress">В процессе</option>
              <option value="notStarted">Не начато</option>
            </select>
          </div>
          <span style={{ fontSize: 13, color: 'var(--c-text-2)', alignSelf: 'flex-end', paddingBottom: 2 }}>
            Показано: {filtered.length}
          </span>
        </div>
      )}

      {/* Table */}
      {dbLoading ? (
        <SkeletonTable rows={6} />
      ) : paginated.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><Users size={36} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>
            {platformStillLoading ? 'Загрузка учеников...' : 'Нет учеников'}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            {statusFilter
              ? 'Нет учеников с таким статусом'
              : platformStillLoading
              ? 'Данные загружаются с платформы'
              : 'Этот материал не назначен ни одному ученику'
            }
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Ученик</th>
                <th style={{ width: 80 }}>Класс</th>
                <th style={{ width: 160 }}>Статус</th>
                <th style={{ width: 160 }}>Дата / Оценка</th>
                <th style={{ width: 200, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((student: any) => {
                const key = student.studentId
                const isItemChecking = checking.has(key)
                const itemStatus = checkStatuses[key]
                const reportId = checkReports[key] || student.reportId || student.sessionId
                const canCheck = student.status === 'done' && student.trainerToken && !student.reportId && !checkReports[key]
                const edikUrl = student.trainerToken ? `${EDIK_BASE}/s/${student.trainerToken}` : null

                return (
                  <tr
                    key={key}
                    style={{ cursor: edikUrl ? 'pointer' : undefined }}
                    onClick={e => {
                      const t = e.target as HTMLElement
                      if (edikUrl && !t.closest('a') && !t.closest('button')) {
                        window.open(edikUrl, '_blank', 'noopener,noreferrer')
                      }
                    }}
                  >
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <Link
                          to={`/students/${student.studentId}`}
                          style={{ color: 'var(--c-primary)', textDecoration: 'none', fontWeight: 500 }}
                          onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                          onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                          onClick={e => e.stopPropagation()}
                        >
                          {student.fullName}
                        </Link>
                        {edikUrl && (
                          <a
                            href={edikUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Открыть работу ученика в Edik"
                            onClick={e => e.stopPropagation()}
                            style={{ color: 'var(--c-text-3)', display: 'flex', flexShrink: 0 }}
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    </td>
                    <td style={{ color: 'var(--c-text-2)' }}>
                      {student.grade ? `${student.grade} кл.` : '—'}
                    </td>
                    <td>
                      {isItemChecking && itemStatus ? (
                        <span className="check-progress">
                          <span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} />
                          {itemStatus === 'queued' ? 'В очереди' : itemStatus === 'processing' ? 'Проверяется...' : itemStatus}
                        </span>
                      ) : (
                        <StatusBadge status={student.status || 'notStarted'} />
                      )}
                    </td>
                    <td>
                      <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>{formatDate(student.lastActivity)}</span>
                      {student.reportGrade && (
                        <span style={{ marginLeft: 8 }}><GradeBadge grade={student.reportGrade} /></span>
                      )}
                      {student.percentage != null && (
                        <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--c-text-3)' }}>
                          {student.percentage}%
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                        {/* Report link — shown when report exists */}
                        {reportId && (
                          <Link
                            to={`/reports/${reportId}`}
                            className="btn btn-secondary btn-sm"
                            style={{ textDecoration: 'none' }}
                            onClick={e => e.stopPropagation()}
                          >
                            <FileText size={12} />
                            Отчёт
                          </Link>
                        )}
                        {/* Check button — only when can check, non-blocking */}
                        {canCheck && (
                          <button
                            onClick={e => { e.stopPropagation(); handleCheck(student) }}
                            disabled={isItemChecking}
                            className="btn btn-primary btn-sm"
                          >
                            {isItemChecking
                              ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                              : <><Play size={12} />Проверить</>
                            }
                          </button>
                        )}
                        {/* Re-check for already checked */}
                        {student.reportId && student.trainerToken && !isItemChecking && (
                          <button
                            onClick={e => { e.stopPropagation(); handleCheck(student) }}
                            disabled={isItemChecking}
                            className="btn btn-ghost btn-sm"
                            title="Перепроверить"
                          >
                            <Play size={11} />
                          </button>
                        )}
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
          <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>Стр. {page} из {totalPages}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="btn btn-secondary btn-sm">Назад</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="btn btn-secondary btn-sm">Вперёд</button>
          </div>
        </div>
      )}
    </div>
  )
}
