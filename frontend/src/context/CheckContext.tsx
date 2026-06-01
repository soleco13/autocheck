import { createContext, useContext, useState, useRef, useCallback, ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { startCheck, bulkCheck, getStudentWorks } from '../api/client'
import { toast } from '../components/Toast'

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

    // Allow restarting a stopped check for the same student
    stopFlags.current.delete(studentId)

    const total = toCheck.length
    const targetIds = new Set(toCheck.map((w: any) => w.platform_material_id as string))

    setBulkChecks(prev => new Map(prev).set(studentId, { done: 0, total, studentId }))

    try {
      await bulkCheck(toCheck.map((w: any) => ({
        studentId,
        materialId: w.platform_material_id,
        trainerToken: w.trainer_token,
      })))

      const deadline = Date.now() + 15 * 60_000
      let done = 0
      let lastDone = -1

      while (done < total && Date.now() < deadline && !stopFlags.current.has(studentId)) {
        await sleep(2500)
        if (stopFlags.current.has(studentId)) break

        try {
          const result = await getStudentWorks(studentId)
          const currentWorks: any[] = result.works ?? []

          done = currentWorks.filter((cw: any) =>
            targetIds.has(cw.platform_material_id) && !!cw.check_status
          ).length

          setBulkChecks(prev => {
            const next = new Map(prev)
            // Only update if this check is still tracked (not stopped)
            if (next.has(studentId)) next.set(studentId, { done, total, studentId })
            return next
          })

          if (done !== lastDone) {
            qc.invalidateQueries({ queryKey: ['student-works', studentId] })
            qc.invalidateQueries({ queryKey: ['student', studentId] })
            lastDone = done
          }
        } catch {
          // Network hiccup — keep polling
        }
      }

      const wasStopped = stopFlags.current.has(studentId)
      if (!wasStopped) {
        qc.invalidateQueries({ queryKey: ['student-works', studentId] })
        qc.invalidateQueries({ queryKey: ['student', studentId] })
        onDone?.()
        toast.success(`${studentId}: проверено ${done} из ${total}`)
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
    toast.success('Проверка остановлена')
  }, [])

  const stopAllBulkChecks = useCallback(() => {
    setBulkChecks(prev => {
      prev.forEach((_, id) => stopFlags.current.add(id))
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
