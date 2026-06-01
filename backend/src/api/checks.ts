import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { db } from '../db';
import { enqueueCheckJob } from '../services/check-runner';
import { safeError } from '../lib/safe-error';
import { logger } from '../lib/logger';
import rateLimit from 'express-rate-limit';

const router = Router();

// Per-user rate limit on check endpoints: 30 checks/min per teacher
// Keyed by teacherId extracted from the JWT (set by requireAuth before this runs)
const checkLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req: any) => req.teacherId || req.ip,
  message: { error: 'Слишком много запросов на проверку. Подождите минуту.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limit for bulk: 5 bulk requests/min per teacher
const bulkLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
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
const BULK_MAX_ITEMS = 100;

router.post('/bulk', requireAuth, bulkLimiter, async (req: AuthRequest, res: Response) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rawItems.length === 0) {
    res.status(400).json({ error: 'items[] required' });
    return;
  }
  if (rawItems.length > BULK_MAX_ITEMS) {
    res.status(400).json({ error: `Максимум ${BULK_MAX_ITEMS} работ за один запрос.` });
    return;
  }

  // Verify all studentIds belong to this teacher in one query
  const uniqueStudentIds = [...new Set(rawItems.map((it: any) => it?.studentId).filter(Boolean))];
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

  const jobIds: string[] = [];
  let skipped = 0;
  for (const it of rawItems) {
    if (!it?.studentId || !it?.materialId) continue;
    try {
      const { jobId, skipped: wasSkipped } = await enqueueCheckJob({
        teacherId: req.teacherId!,
        studentId: it.studentId,
        editorUrl: it.materialId,
        platformMaterialId: it.materialId,
        trainerToken: it.trainerToken,
        source: 'prefetch',
        dedupe: true,
      });
      if (wasSkipped) skipped++;
      else if (jobId) jobIds.push(jobId);
    } catch (err: any) {
      logger.warn({ studentId: it.studentId, err: safeError(err) }, '[bulk] enqueue failed');
    }
  }

  res.status(202).json({ enqueued: jobIds.length, skipped, jobIds });
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
