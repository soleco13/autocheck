import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 60_000,  // 60 s — matches backend connect-timeout
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
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

// Students
export const getStudents = (sync = false) =>
  api.get(`/students${sync ? '?sync=true' : ''}`).then(r => r.data)

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

// Polls a set of job ids until all reach a terminal state. `onProgress(done, total)`
// reports completion count for a progress indicator.
export async function waitForJobs(
  jobIds: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (jobIds.length === 0) return
  const pending = new Set(jobIds)
  const deadline = Date.now() + 15 * 60 * 1000
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    for (const id of [...pending]) {
      try {
        const job = await getCheckJob(id)
        if (job.status === 'completed' || job.status === 'failed') pending.delete(id)
      } catch { /* keep polling */ }
    }
    onProgress?.(jobIds.length - pending.size, jobIds.length)
  }
}

export const getCheckReport = (sessionId: string) =>
  api.get(`/checks/${sessionId}/report`).then(r => r.data)

// Reports
export const getReport = (id: string) =>
  api.get(`/reports/${id}`).then(r => r.data)

export const overrideAnswerScore = (answerId: string, score: number, note?: string) =>
  api.patch(`/reports/answers/${answerId}/override`, { score, note }).then(r => r.data)

// Textbooks
export const getTextbooks = () =>
  api.get('/textbooks').then(r => r.data)

export const createTextbook = (data: any) =>
  api.post('/textbooks', data).then(r => r.data)

export const uploadTextbookContent = (id: string, sections: any[]) =>
  api.post(`/textbooks/${id}/content`, { sections }).then(r => r.data)

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

// Instant DB-only fetch (returns only already-checked students)
export const getMaterialStudentsDb = (materialId: string) =>
  api.get(`/materials/${materialId}/students?dbOnly=true`).then(r => r.data)

// Full fetch including slow platform DDP call
export const getMaterialStudents = (materialId: string) =>
  api.get(`/materials/${materialId}/students`).then(r => r.data)
