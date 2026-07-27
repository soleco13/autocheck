import { createContext, useContext, useState, useRef, useCallback, useEffect, ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { startCheck, bulkCheck, waitForJobs, getActiveJobs, cancelStudentJobs } from '../api/client'
import { toast } from '../components/Toast'

// ── SSE job-event subscription ───────────────────────────────────────────────
// One persistent EventSource per browser session. Job completion events arrive
// here instead of each bulk check polling individually, reducing HTTP load by ~90%.
type JobEventHandler = (event: {
  jobId: string;
  status: string;
  reportId?: string | null;
  error?: string | null;
  done?: number;
  total?: number;
}) => void

let _sse: EventSource | null = null
const _handlers = new Map<string, Set<JobEventHandler>>()

function getSSE(): EventSource {
  if (!_sse || _sse.readyState === EventSource.CLOSED) {
    _sse = new EventSource('/api/events', { withCredentials: true })
    _sse.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (!data.jobId) return
        const handlers = _handlers.get(data.jobId)
        if (handlers) for (const h of handlers) h(data)
      } catch {}
    }
    _sse.onerror = () => {
      // Browser will auto-reconnect on error; no explicit action needed
    }
  }
  return _sse
}

function subscribeToJob(jobId: string, handler: JobEventHandler): () => void {
  getSSE() // ensure connection is open
  if (!_handlers.has(jobId)) _handlers.set(jobId, new Set())
  _handlers.get(jobId)!.add(handler)
  return () => {
    _handlers.get(jobId)?.delete(handler)
    if (_handlers.get(jobId)?.size === 0) _handlers.delete(jobId)
  }
}

/**
 * Watch a set of job IDs via SSE with polling fallback.
 * SSE: O(1) HTTP connections regardless of job count.
 * Fallback: standard polling if SSE is not available.
 */
async function waitForJobsSSE(
  jobIds: string[],
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<{ completed: number; failed: number }> {
  const pending = new Set(jobIds)
  const total = jobIds.length
  let completed = 0
  let failed = 0
  // Track per-job answer progress for smooth fractional progress bar
  const jobProgress = new Map<string, { done: number; total: number }>()

  const reportProgress = () => {
    const finishedJobs = total - pending.size
    const fractional = [...pending].reduce((sum, jId) => {
      const p = jobProgress.get(jId)
      return sum + (p && p.total > 0 ? p.done / p.total : 0)
    }, 0)
    onProgress(finishedJobs + fractional, total)
  }

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      // Timeout fallback: switch to polling for remaining jobs
      unsubAll()
      waitForJobs([...pending], (done) => onProgress(total - pending.size + done, total), isCancelled)
        .then(({ completed: c, failed: f }) => resolve({ completed: completed + c, failed: failed + f }))
    }, 5 * 60_000)

    const unsubFns: Array<() => void> = []

    const handleEvent = (jobId: string) => (event: { status: string; done?: number; total?: number }) => {
      if (!pending.has(jobId)) return
      if (event.status === 'completed') { completed++; pending.delete(jobId); jobProgress.delete(jobId) }
      else if (event.status === 'failed') { failed++; pending.delete(jobId); jobProgress.delete(jobId) }
      else if (event.status === 'progress' && typeof event.done === 'number' && typeof event.total === 'number') {
        jobProgress.set(jobId, { done: event.done, total: event.total })
      }
      reportProgress()
      if (pending.size === 0 || isCancelled()) {
        clearTimeout(deadline)
        unsubAll()
        resolve({ completed, failed })
      }
    }

    const unsubAll = () => { for (const fn of unsubFns) fn() }

    // Check if SSE is supported (EventSource is not available in all environments)
    if (typeof EventSource === 'undefined') {
      clearTimeout(deadline)
      waitForJobs(jobIds, onProgress, isCancelled).then(resolve)
      return
    }

    for (const jobId of jobIds) {
      unsubFns.push(subscribeToJob(jobId, handleEvent(jobId)))
    }
  })
}

export interface BulkProgress {
  done: number
  total: number
  studentId: string
}

interface CheckContextValue {
  checking: Set<string>
  checkStatuses: Record<string, string>

  // Map of studentId → progress for ALL currently running bulk checks
  bulkChecks: Map<string, BulkProgress>

  runCheck: (studentId: string, materialId: string, trainerToken?: string, onDone?: () => void) => void
  startBulkCheck: (studentId: string, works: any[], count: number | 'all', onDone?: () => void) => void
  stopBulkCheck: (studentId: string) => void
  stopAllBulkChecks: () => void
}

const CheckContext = createContext<CheckContextValue | null>(null)

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function CheckProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [checkStatuses, setCheckStatuses] = useState<Record<string, string>>({})
  const [bulkChecks, setBulkChecks] = useState<Map<string, BulkProgress>>(new Map())

  // Per-student stop flags — add studentId to stop that student's check
  const stopFlags = useRef<Set<string>>(new Set())

  // On mount: restore progress-bar state for any jobs that were still running
  // when the page was last refreshed. Fetches queued/processing jobs from the DB
  // and resumes SSE tracking so the banner stays visible across reloads.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const groups = await getActiveJobs()
        if (cancelled || groups.length === 0) return
        for (const { studentId, jobIds, total } of groups) {
          if (stopFlags.current.has(studentId)) continue
          setBulkChecks(prev => new Map(prev).set(studentId, { done: 0, total, studentId }))
          let lastFloor = -1
          waitForJobsSSE(
            jobIds,
            (done, jobTotal) => {
              if (cancelled) return
              setBulkChecks(prev => {
                const next = new Map(prev)
                if (next.has(studentId)) next.set(studentId, { done, total: jobTotal, studentId })
                return next
              })
              const f = Math.floor(done)
              if (f !== lastFloor) { lastFloor = f; qc.invalidateQueries({ queryKey: ['student-works', studentId] }) }
            },
            () => cancelled || stopFlags.current.has(studentId),
          ).then(() => {
            if (cancelled) return
            setBulkChecks(prev => { const next = new Map(prev); next.delete(studentId); return next })
            qc.invalidateQueries({ queryKey: ['student-works', studentId] })
            qc.invalidateQueries({ queryKey: ['student', studentId] })
          }).catch(() => {
            setBulkChecks(prev => { const next = new Map(prev); next.delete(studentId); return next })
          })
        }
      } catch { /* silent — best-effort restore */ }
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Single item check ──────────────────────────────────────────────────────
  const runCheck = useCallback(async (
    studentId: string,
    materialId: string,
    trainerToken?: string,
    onDone?: () => void,
  ) => {
    if (checking.has(materialId)) return
    setChecking(prev => new Set(prev).add(materialId))
    setCheckStatuses(prev => ({ ...prev, [materialId]: 'queued' }))

    try {
      const job = await startCheck(studentId, materialId, trainerToken, trainerToken ? materialId : undefined)
      if (job.status === 'completed') {
        onDone?.()
        qc.invalidateQueries({ queryKey: ['student-works', studentId] })
        qc.invalidateQueries({ queryKey: ['student', studentId] })
        toast.success('Работа проверена')
        return
      }
      if (job.status === 'failed') throw new Error(job.error || 'Ошибка проверки')
      if (!job.jobId) throw new Error('Не удалось поставить в очередь')

      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        await sleep(1500)
        const { getCheckJob } = await import('../api/client')
        const cur = await getCheckJob(job.jobId)
        setCheckStatuses(prev => ({ ...prev, [materialId]: cur.status }))
        if (cur.status === 'completed') {
          onDone?.()
          qc.invalidateQueries({ queryKey: ['student-works', studentId] })
          qc.invalidateQueries({ queryKey: ['student', studentId] })
          toast.success('Работа проверена')
          return
        }
        if (cur.status === 'failed') throw new Error(cur.error || 'Ошибка проверки')
      }
      throw new Error('Превышено время ожидания')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка проверки')
    } finally {
      setChecking(prev => { const n = new Set(prev); n.delete(materialId); return n })
      setCheckStatuses(prev => { const n = { ...prev }; delete n[materialId]; return n })
    }
  }, [checking, qc])

  // ── Bulk check (supports multiple students simultaneously) ─────────────────
  const startBulkCheck = useCallback(async (
    studentId: string,
    works: any[],
    count: number | 'all',
    onDone?: () => void,
  ) => {
    const unchecked = works.filter(w => !w.check_status && w.trainer_token)
    const toCheck = count === 'all' ? unchecked : unchecked.slice(0, count)

    if (toCheck.length === 0) {
      toast.error('Нет непроверенных работ для массовой проверки')
      return
    }

    stopFlags.current.delete(studentId)
    const total = toCheck.length
    setBulkChecks(prev => new Map(prev).set(studentId, { done: 0, total, studentId }))

    try {
      const result = await bulkCheck(toCheck.map((w: any) => ({
        studentId,
        materialId: w.platform_material_id,
        trainerToken: w.trainer_token,
      })))

      const { jobIds, enqueued, skipped } = result

      if (enqueued === 0) {
        toast.success(skipped > 0 ? 'Все работы уже проверены или в очереди' : 'Нет работ для проверки')
        onDone?.()
        return
      }

      // Update total to reflect actually enqueued jobs (dedup may have skipped some)
      setBulkChecks(prev => {
        const next = new Map(prev)
        if (next.has(studentId)) next.set(studentId, { done: 0, total: enqueued, studentId })
        return next
      })

      let lastDone = -1

      // SSE-based job tracking (falls back to polling if SSE unavailable).
      // One shared EventSource connection for the whole session vs N polling loops.
      const { completed, failed } = await waitForJobsSSE(
        jobIds,
        (done, jobTotal) => {
          if (stopFlags.current.has(studentId)) return
          setBulkChecks(prev => {
            const next = new Map(prev)
            if (next.has(studentId)) next.set(studentId, { done, total: jobTotal, studentId })
            return next
          })
          // Only refetch works list when a complete job finishes (integer part changes),
          // not on every fractional per-answer progress event — avoids N×answers refetches.
          if (Math.floor(done) !== Math.floor(lastDone)) {
            qc.invalidateQueries({ queryKey: ['student-works', studentId] })
          }
          lastDone = done
        },
        () => stopFlags.current.has(studentId),
      )

      if (!stopFlags.current.has(studentId)) {
        qc.invalidateQueries({ queryKey: ['student-works', studentId] })
        qc.invalidateQueries({ queryKey: ['student', studentId] })
        onDone?.()

        const skipNote = skipped > 0 ? ` · пропущено: ${skipped}` : ''
        if (failed === 0) {
          toast.success(`Проверено: ${completed} из ${total}${skipNote}`)
        } else if (completed === 0) {
          toast.error(`Ни одна работа не проверена (${failed} ошибок платформы${skipNote})`)
        } else {
          toast.success(`Проверено: ${completed} из ${total} · ошибок: ${failed}${skipNote}`)
        }
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка массовой проверки')
    } finally {
      stopFlags.current.delete(studentId)
      setBulkChecks(prev => {
        const next = new Map(prev)
        next.delete(studentId)
        return next
      })
    }
  }, [qc])

  const stopBulkCheck = useCallback((studentId: string) => {
    stopFlags.current.add(studentId)
    setBulkChecks(prev => {
      const next = new Map(prev)
      next.delete(studentId)
      return next
    })
    // Cancel backend jobs so page-refresh doesn't restore the banner
    cancelStudentJobs(studentId).catch(() => {})
    toast.success('Проверка остановлена')
  }, [])

  const stopAllBulkChecks = useCallback(() => {
    setBulkChecks(prev => {
      prev.forEach((_, id) => {
        stopFlags.current.add(id)
        cancelStudentJobs(id).catch(() => {})
      })
      return new Map()
    })
  }, [])

  return (
    <CheckContext.Provider value={{
      checking, checkStatuses,
      bulkChecks,
      runCheck, startBulkCheck, stopBulkCheck, stopAllBulkChecks,
    }}>
      {children}
    </CheckContext.Provider>
  )
}

export function useCheckContext() {
  const ctx = useContext(CheckContext)
  if (!ctx) throw new Error('useCheckContext must be used inside CheckProvider')
  return ctx
}
