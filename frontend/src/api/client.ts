import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 60_000,  // 60 s — matches backend connect-timeout
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

// Auth
export const login = (email: string, password: string) =>
  api.post('/auth/login', { email, password }).then(r => r.data)

export const logout = () =>
  api.post('/auth/logout').then(r => r.data)

export const getMe = () =>
  api.get('/auth/me').then(r => r.data)

/** Refresh session JWT (call every ~6 days or on 401 to extend the session). */
export const refreshSession = () =>
  api.post('/auth/refresh').then(r => r.data)

/** Refresh the Gena platform token (call when works page shows platformError). */
export const refreshPlatformToken = () =>
  api.post('/auth/refresh-platform').then(r => r.data)

// Students — returns { students: [], pagination: {...} }
export const getStudentsPaginated = (opts?: { sync?: boolean; search?: string; page?: number; pageSize?: number }) => {
  const params = new URLSearchParams()
  if (opts?.sync) params.set('sync', 'true')
  if (opts?.search) params.set('search', opts.search)
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.pageSize) params.set('pageSize', String(opts.pageSize))
  const qs = params.toString()
  return api.get(`/students${qs ? '?' + qs : ''}`).then(r => r.data as { students: any[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } })
}

// Backward-compat: returns flat array (uses large pageSize to get all students)
export const getStudents = (opts?: { sync?: boolean }) =>
  getStudentsPaginated({ ...opts, pageSize: 500 }).then(d => d.students)

export const syncClassrooms = () =>
  api.post('/students/sync-classrooms').then(r => r.data)

export const getStudent = (id: string) =>
  api.get(`/students/${id}`).then(r => r.data)

export const getStudentWorks = (id: string) =>
  api.get(`/students/${id}/works`).then(r => {
    const data = r.data
    // Handle both array (legacy) and { works, platformError } shape
    if (Array.isArray(data)) return { works: data, platformError: null }
    return data as { works: any[]; platformError: string | null }
  })

// Checks
// editorUrl can be: full editor URL, bare JWT token, or legacy platform material ID
// trainerToken (optional): direct JWT from getChildsMaterials interactiveData
export interface CheckJob {
  jobId: string | null
  status: 'queued' | 'processing' | 'completed' | 'failed'
  sessionId?: string | null
  reportId?: string | null
  error?: string | null
}

// Enqueues a check. Returns { jobId, status } — 'queued' when a worker will process it,
// or 'completed'/'failed' when the server processed it inline (no queue available).
export const startCheck = (studentId: string, editorUrl: string, trainerToken?: string, materialId?: string): Promise<CheckJob> =>
  api.post('/checks', {
    studentId,
    editorUrl: trainerToken ? undefined : editorUrl,
    platformMaterialId: trainerToken ? materialId : undefined,
    trainerToken,
  }).then(r => r.data)

export const getCheckJob = (jobId: string): Promise<CheckJob> =>
  api.get(`/checks/jobs/${jobId}`).then(r => r.data)

export const getActiveJobs = (): Promise<Array<{ studentId: string; jobIds: string[]; total: number }>> =>
  api.get('/checks/jobs/active').then(r => r.data)

export const cancelStudentJobs = (studentId: string): Promise<{ ok: boolean }> =>
  api.post('/checks/jobs/cancel', { studentId }).then(r => r.data)

// Enqueues a check and resolves only once it has finished (or failed). Handles both
// modes: if the POST already returned a terminal status (inline), returns immediately;
// otherwise polls the job until done. `onStatus` reports intermediate states for the UI.
export async function runCheckAndWait(
  studentId: string,
  editorUrl: string,
  trainerToken?: string,
  materialId?: string,
  onStatus?: (status: CheckJob['status']) => void,
): Promise<CheckJob> {
  const job = await startCheck(studentId, editorUrl, trainerToken, materialId)
  onStatus?.(job.status)
  if (job.status === 'completed') return job
  if (job.status === 'failed') throw new Error(job.error || 'Проверка не удалась')
  if (!job.jobId) throw new Error('Не удалось поставить проверку в очередь')

  const deadline = Date.now() + 5 * 60 * 1000 // 5 min safety timeout
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    const cur = await getCheckJob(job.jobId)
    onStatus?.(cur.status)
    if (cur.status === 'completed') return cur
    if (cur.status === 'failed') throw new Error(cur.error || 'Проверка не удалась')
  }
  throw new Error('Превышено время ожидания проверки')
}

// Bulk-enqueue checks (background prefetch / "check all"). Returns { enqueued, skipped, jobIds }.
export interface BulkCheckItem { studentId: string; materialId: string; trainerToken?: string }
export const bulkCheck = (items: BulkCheckItem[]): Promise<{ enqueued: number; skipped: number; jobIds: string[] }> =>
  api.post('/checks/bulk', { items }).then(r => r.data)

// Batch job status — single request for up to 1000 job IDs.
// Returns [{ id, status, error }] for whichever IDs the teacher owns.
export const getBulkJobStatus = (
  ids: string[],
): Promise<Array<{ id: string; status: string; error?: string | null }>> =>
  api.post('/checks/jobs/status', { ids }).then(r => r.data)

// Polls a set of job IDs until all reach a terminal state (completed / failed).
// Uses batch status endpoint (one HTTP request per poll tick regardless of job count).
// Returns { completed, failed } counts once all jobs reach a terminal state or deadline.
// `onProgress(done, total)` fires after each tick with combined terminal count.
// `isCancelled()` — if provided and returns true, exits the loop early.
// Timeout scales with batch size (includes BullMQ retry window: 2 s/job + 65 s retry buffer).
export async function waitForJobs(
  jobIds: string[],
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<{ completed: number; failed: number }> {
  if (jobIds.length === 0) return { completed: 0, failed: 0 }
  const pending = new Set(jobIds)
  const total = jobIds.length
  let completedCount = 0
  let failedCount = 0
  // Dynamic deadline: at least 20 min (to allow one 65s BullMQ retry + processing time),
  // 5 s per job estimate, max 4 h.
  const deadline = Date.now() + Math.min(4 * 60 * 60_000, Math.max(20 * 60_000, total * 5_000))
  let noProgressTicks = 0

  while (pending.size > 0 && Date.now() < deadline) {
    if (isCancelled?.()) break

    // Adaptive interval: back off when no progress to reduce server load
    const intervalMs = noProgressTicks >= 4 ? 6_000 : 3_000
    await new Promise(r => setTimeout(r, intervalMs))
    if (isCancelled?.()) break

    const prevSize = pending.size

    // Poll in chunks of 200 to stay within URL-safe limits
    const ids = [...pending]
    for (let i = 0; i < ids.length; i += 200) {
      try {
        const statuses = await getBulkJobStatus(ids.slice(i, i + 200))
        for (const job of statuses) {
          if (job.status === 'completed') { completedCount++; pending.delete(job.id) }
          else if (job.status === 'failed') { failedCount++; pending.delete(job.id) }
        }
      } catch { /* network hiccup — keep polling */ }
    }

    if (pending.size === prevSize) noProgressTicks++
    else noProgressTicks = 0

    onProgress?.(total - pending.size, total)
  }

  return { completed: completedCount, failed: failedCount }
}

export const getCheckReport = (sessionId: string) =>
  api.get(`/checks/${sessionId}/report`).then(r => r.data)

// Reports
export const getReport = (id: string) =>
  api.get(`/reports/${id}`).then(r => r.data)

export const overrideAnswerScore = (answerId: string, score: number, note?: string) =>
  api.patch(`/reports/answers/${answerId}/override`, { score, note }).then(r => r.data)

// Textbooks (RAG)
export const getTextbooks = () =>
  api.get('/textbooks').then(r => r.data)

export const uploadTextbookPdf = (formData: FormData) =>
  api.post('/textbooks/upload-pdf', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120_000,
  }).then(r => r.data as { id: string; status: string })

export const getTextbookStatus = (id: string) =>
  api.get(`/textbooks/${id}/status`).then(r => r.data as {
    id: string
    status: 'pending' | 'processing' | 'ready' | 'error'
    progress_step: string | null
    progress_pct: number
    chunk_count: number
    error_msg: string | null
  })

export const deleteTextbook = (id: string) =>
  api.delete(`/textbooks/${id}`).then(r => r.data)

export const reindexTextbook = (id: string, file: File) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post(`/textbooks/${id}/reindex`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120_000,
  }).then(r => r.data as { id: string; status: string })
}

// Materials
export const getMaterials = (params: {
  page?: number
  pageSize?: number
  grade?: string | null
  skillId?: string | null
  type?: string | null
  search?: string | null
}) => {
  const p: Record<string, string> = {}
  if (params.page) p.page = String(params.page)
  if (params.pageSize) p.pageSize = String(params.pageSize)
  if (params.grade) p.grade = params.grade
  if (params.skillId) p.skillId = params.skillId
  if (params.type) p.type = params.type
  if (params.search) p.search = params.search
  return api.get('/materials', { params: p }).then(r => r.data)
}

// AI settings
export const getAiUsage = () =>
  api.get('/settings/ai-usage').then(r => r.data)

export const getAiPrompts = () =>
  api.get('/settings/ai-prompts').then(r => r.data)

export const saveAiPrompt = (key: string, text: string) =>
  api.post('/settings/ai-prompts', { key, text }).then(r => r.data)

// Platform monitoring (Monti APM)
export const getPlatformStatus = () =>
  api.get('/platform/status').then(r => r.data)

export const getPlatformReport = () =>
  api.post('/platform/report').then(r => r.data)

// Instant DB-only fetch (returns only already-checked students)
export const getMaterialStudentsDb = (materialId: string) =>
  api.get(`/materials/${materialId}/students?dbOnly=true`).then(r => r.data)

// Full fetch including slow platform DDP call
export const getMaterialStudents = (materialId: string) =>
  api.get(`/materials/${materialId}/students`).then(r => r.data)
