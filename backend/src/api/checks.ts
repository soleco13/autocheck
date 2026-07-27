import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { db } from '../db';
import { enqueueCheckJob, enqueueCheckBatch, EnqueueParams } from '../services/check-runner';
import { safeError } from '../lib/safe-error';
import { logger } from '../lib/logger';
import rateLimit from 'express-rate-limit';
import { configStore } from '../lib/config-store';

const router = Router();

// Rate limits read from configStore on every request — changes in Settings UI take effect
// immediately without a server restart (check_rate_per_min / bulk_rate_per_min params).
const checkLimiter = rateLimit({
  windowMs: 60_000,
  max: (_req: any) => configStore.get('check_rate_per_min'),
  keyGenerator: (req: any) => req.teacherId || req.ip,
  message: { error: 'Слишком много запросов на проверку. Подождите минуту.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const bulkLimiter = rateLimit({
  windowMs: 60_000,
  max: (_req: any) => configStore.get('bulk_rate_per_min'),
  keyGenerator: (req: any) => req.teacherId || req.ip,
  message: { error: 'Слишком много массовых запросов. Подождите минуту.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Verify that a studentId belongs to the requesting teacher
async function verifyStudentOwnership(teacherId: string, studentId: string): Promise<boolean> {
  const r = await db.query(
    'SELECT 1 FROM teacher_students WHERE teacher_id = $1 AND student_id = $2 LIMIT 1',
    [teacherId, studentId],
  );
  return r.rows.length > 0;
}

// POST /api/checks
router.post('/', requireAuth, checkLimiter, async (req: AuthRequest, res: Response) => {
  const { studentId, editorUrl, platformMaterialId, trainerToken } = req.body;
  const rawInput: string = editorUrl || platformMaterialId || '';
  if (!studentId || (!rawInput && !trainerToken)) {
    res.status(400).json({ error: 'studentId and editorUrl (or trainerToken + materialId) required' });
    return;
  }

  // Verify student belongs to this teacher
  if (!await verifyStudentOwnership(req.teacherId!, studentId)) {
    res.status(403).json({ error: 'Нет доступа к этому ученику.' });
    return;
  }

  try {
    const { jobId, status } = await enqueueCheckJob({
      teacherId: req.teacherId!,
      studentId,
      editorUrl,
      platformMaterialId,
      trainerToken,
      source: 'manual',
    });
    res.status(202).json({ jobId, status });
  } catch (err: any) {
    logger.error({ err }, 'Check enqueue error');
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/checks/bulk
// Accepts up to bulk_max_items items, deduplicates in one batch query,
// inserts all new check_jobs in one statement, and returns all jobIds immediately.
// Processing happens in the background (BullMQ or inline with concurrency control).
router.post('/bulk', requireAuth, bulkLimiter, async (req: AuthRequest, res: Response) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rawItems.length === 0) {
    res.status(400).json({ error: 'items[] required' });
    return;
  }
  const bulkMax = configStore.get('bulk_max_items');
  if (rawItems.length > bulkMax) {
    res.status(400).json({ error: `Максимум ${bulkMax} работ за один запрос.` });
    return;
  }

  // Verify all studentIds belong to this teacher in one query
  const uniqueStudentIds = [...new Set(rawItems.map((it: any) => it?.studentId).filter(Boolean))] as string[];
  if (uniqueStudentIds.length > 0) {
    const owned = await db.query(
      `SELECT student_id FROM teacher_students
       WHERE teacher_id = $1 AND student_id = ANY($2::uuid[])`,
      [req.teacherId!, uniqueStudentIds],
    );
    const ownedSet = new Set(owned.rows.map((r: any) => r.student_id));
    const unauthorized = uniqueStudentIds.filter(id => !ownedSet.has(id));
    if (unauthorized.length > 0) {
      res.status(403).json({ error: 'Один или несколько учеников не принадлежат вашему аккаунту.' });
      return;
    }
  }

  const validItems: EnqueueParams[] = rawItems
    .filter((it: any) => it?.studentId && it?.materialId)
    .map((it: any) => ({
      teacherId: req.teacherId!,
      studentId: it.studentId,
      editorUrl: it.materialId,
      platformMaterialId: it.materialId,
      trainerToken: it.trainerToken,
      source: 'prefetch' as const,
      dedupe: true,
    }));

  try {
    const { jobIds, skipped } = await enqueueCheckBatch(validItems);
    res.status(202).json({ enqueued: jobIds.length, skipped, jobIds });
  } catch (err: any) {
    logger.error({ err }, '[bulk] enqueueCheckBatch failed');
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/checks/jobs/active — returns queued/processing jobs grouped by student.
// Only returns jobs updated within the last 30 minutes to avoid stale ghost banners.
router.get('/jobs/active', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT student_id, array_agg(id ORDER BY created_at) AS job_ids, count(*)::int AS total
       FROM check_jobs
       WHERE teacher_id = $1
         AND status IN ('queued', 'processing')
         AND updated_at > NOW() - INTERVAL '30 minutes'
       GROUP BY student_id`,
      [req.teacherId],
    );
    res.json(result.rows.map((r: any) => ({
      studentId: r.student_id,
      jobIds: r.job_ids,
      total: r.total,
    })));
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/checks/jobs/cancel — marks all queued/processing jobs for a student as cancelled
// AND removes waiting jobs from the BullMQ Redis queue so workers stop picking them up.
router.post('/jobs/cancel', requireAuth, async (req: AuthRequest, res: Response) => {
  const { studentId } = req.body;
  if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
  try {
    const result = await db.query(
      `UPDATE check_jobs
       SET status = 'failed', error = 'Отменено пользователем', updated_at = NOW()
       WHERE teacher_id = $1 AND student_id = $2 AND status IN ('queued', 'processing')
       RETURNING id`,
      [req.teacherId, studentId],
    );

    // Remove waiting/prioritized jobs from BullMQ so workers don't pick them up.
    // Active jobs (currently processing) can't be removed mid-flight — the worker
    // cancellation check in worker.ts handles those on the next DB status read.
    if (result.rows.length > 0) {
      try {
        const { getCheckQueue, isRedisQueueCapable } = await import('../queue');
        if (await isRedisQueueCapable()) {
          const { Job } = await import('bullmq');
          const queue = getCheckQueue();
          await Promise.allSettled(
            result.rows.map(async (row: any) => {
              const job = await Job.fromId(queue, row.id);
              if (job) await job.remove();
            }),
          );
        }
      } catch { /* BullMQ removal is best-effort; DB status is the source of truth */ }
    }

    res.json({ ok: true, cancelled: result.rows.length });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/checks/jobs/status — batch status for 1000+ job IDs in one DB query.
// Body: { ids: string[] }  (max 1000)
router.post('/jobs/status', requireAuth, async (req: AuthRequest, res: Response) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 1000) : [];
  if (ids.length === 0) { res.json([]); return; }
  try {
    const result = await db.query(
      `SELECT id, status, error FROM check_jobs
       WHERE id = ANY($1::uuid[]) AND teacher_id = $2`,
      [ids, req.teacherId],
    );
    res.json(result.rows);
  } catch (err: any) {
    logger.error({ err }, 'Batch job status error');
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/checks/jobs/:jobId
router.get('/jobs/:jobId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, status, session_id, report_id, error, updated_at
       FROM check_jobs WHERE id = $1 AND teacher_id = $2`,
      [req.params.jobId, req.teacherId],
    );
    if (!result.rows[0]) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = result.rows[0];
    res.json({
      jobId:     job.id,
      status:    job.status,
      sessionId: job.session_id,
      reportId:  job.report_id,
      error:     job.error,
    });
  } catch (err: any) {
    logger.error({ err }, 'Get job error');
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/checks/:sessionId/report
router.get('/:sessionId/report', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(`
      SELECT r.id, r.session_id, r.total_score, r.max_score, r.percentage,
             r.grade as report_grade, r.status, r.ai_summary_for_student, r.ai_summary_for_teacher,
             r.generated_at, ss.fetched_at,
             s.id as student_id, s.full_name as student_name,
             cs.title, cs.topic, cs.grade, cs.subject_code
      FROM reports r
      JOIN student_sessions ss ON ss.id = r.session_id
      JOIN students s ON s.id = ss.student_id
      JOIN control_sheets cs ON cs.id = ss.control_sheet_id
      WHERE (r.session_id = $1 OR r.id = $1) AND ss.teacher_id = $2
    `, [req.params.sessionId, req.teacherId]);

    if (!result.rows[0]) { res.status(404).json({ error: 'Report not found' }); return; }

    const report = result.rows[0];
    const answersResult = await db.query(`
      SELECT a.*, t.question_text, t.task_type, t.max_score as task_max_score,
             t.slide_num, t.reference_answer as task_reference_answer
      FROM answers a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.session_id = $1
      ORDER BY t.task_index
    `, [report.session_id]);

    res.json({ ...report, answers: answersResult.rows });
  } catch (err: any) {
    logger.error({ err }, 'Get check report error');
    res.status(500).json({ error: safeError(err) });
  }
});

export default router;
