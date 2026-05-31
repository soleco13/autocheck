import { createContext, useContext, useState, useRef, useCallback, ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { startCheck, getCheckJob, bulkCheck } from '../api/client'
import { toast } from '../components/Toast'

interface BulkProgress {
  done: number
  total: number
  studentId: string
}

interface CheckContextValue {
  // Per-item individual checks
  checking: Set<string>          // set of materialIds being checked right now
  checkStatuses: Record<string, string>

  // Bulk check
  bulkRunning: boolean
  bulkProgress: BulkProgress | null

  runCheck: (
    studentId: string,
    materialId: string,
    trainerToken?: string,
    onDone?: () => void,
  ) => void

  startBulkCheck: (
    studentId: string,
    works: any[],
    count: number | 'all',
    onDone?: () => void,
  ) => void

  stopBulkCheck: () => void
}

const CheckContext = createContext<CheckContextValue | null>(null)

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function CheckProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [checkStatuses, setCheckStatuses] = useState<Record<string, string>>({})
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null)
  const stopFlag = useRef(false)

  // ── Single item check (non-blocking for other rows) ──────────────────────
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
      // Enqueue
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

      // Poll
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        await sleep(1500)
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

  // ── Bulk check ────────────────────────────────────────────────────────────
  const startBulkCheck = useCallback(async (
    studentId: string,
    works: any[],
    count: number | 'all',
    onDone?: () => void,
  ) => {
    // Filter: only unchecked works with trainerToken
    const unchecked = works.filter(w => !w.check_status && w.trainer_token)
    const toCheck = count === 'all' ? unchecked : unchecked.slice(0, count)

    if (toCheck.length === 0) {
      toast.error('Нет непроверенных работ для массовой проверки')
      return
    }

    stopFlag.current = false
    setBulkRunning(true)
    setBulkProgress({ done: 0, total: toCheck.length, studentId })

    try {
      const items = toCheck.map((w: any) => ({
        studentId,
        materialId: w.platform_material_id,
        trainerToken: w.trainer_token,
      }))

      const { jobIds } = await bulkCheck(items)
      if (jobIds.length === 0) {
        toast.success('Все работы уже проверены или поставлены в очередь')
        return
      }

      const total = jobIds.length
      const pending = new Set(jobIds)
      const deadline = Date.now() + 15 * 60_000

      while (pending.size > 0 && Date.now() < deadline) {
        if (stopFlag.current) {
          toast.success(`Остановлено. Проверено: ${total - pending.size} из ${total}`)
          return
        }

        await sleep(2000)
        if (stopFlag.current) {
          toast.success(`Остановлено. Проверено: ${total - pending.size} из ${total}`)
          return
        }

        // Check each pending job
        for (const jobId of [...pending]) {
          if (stopFlag.current) break
          try {
            const job = await getCheckJob(jobId)
            if (job.status === 'completed' || job.status === 'failed') {
              pending.delete(jobId)
            }
          } catch { /* skip */ }
        }

        const done = total - pending.size
        setBulkProgress({ done, total, studentId })

        // Refresh every 5 completed jobs or when all done
        if (done > 0 && (done % 5 === 0 || pending.size === 0)) {
          qc.invalidateQueries({ queryKey: ['student-works', studentId] })
          qc.invalidateQueries({ queryKey: ['student', studentId] })
        }
      }

      if (!stopFlag.current) {
        qc.invalidateQueries({ queryKey: ['student-works', studentId] })
        qc.invalidateQueries({ queryKey: ['student', studentId] })
        onDone?.()
        toast.success(`Проверено: ${total - pending.size} из ${total}`)
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка массовой проверки')
    } finally {
      if (!stopFlag.current) {
        setBulkRunning(false)
        setBulkProgress(null)
      }
    }
  }, [qc])

  const stopBulkCheck = useCallback(() => {
    stopFlag.current = true
    setBulkRunning(false)
    setBulkProgress(null)
  }, [])

  return (
    <CheckContext.Provider value={{
      checking, checkStatuses,
      bulkRunning, bulkProgress,
      runCheck, startBulkCheck, stopBulkCheck,
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
