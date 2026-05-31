import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { db } from '../db';
import { enqueueCheckJob } from '../services/check-runner';

const router = Router();

// POST /api/checks - queue checking of a student's work.
// Body: { studentId, editorUrl } — editorUrl can be:
//   - Full editor URL: https://editor.good-teach.itgen.io/s/<JWT>
//   - Bare JWT string
//   - Legacy platform material ID (tries DDP methods, will fail without stored JWT)
// Returns 202 { jobId, status }. status is 'queued' when a worker will pick it up,
// or 'completed'/'failed' when processed inline (no queue available). Poll
// GET /api/checks/jobs/:jobId either way.
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { studentId, editorUrl, platformMaterialId, trainerToken } = req.body;
  const rawInput: string = editorUrl || platformMaterialId || '';
  if (!studentId || (!rawInput && !trainerToken)) {
    res.status(400).json({ error: 'studentId and editorUrl (or trainerToken + materialId) required' });
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
    console.error('Check enqueue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/checks/bulk - queue many checks at once (background prefetch / "check all").
// Body: { items: [{ studentId, materialId, trainerToken }] }
// Lower priority + dedupe (skips already-reported / already-pending work).
router.post('/bulk', requireAuth, async (req: AuthRequest, res: Response) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) {
    res.status(400).json({ error: 'items[] required' });
    return;
  }

  const jobIds: string[] = [];
  let skipped = 0;
  for (const it of items) {
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
      console.error('[bulk] enqueue failed for', it.studentId, err.message);
    }
  }

  res.status(202).json({ enqueued: jobIds.length, skipped, jobIds });
});

// GET /api/checks/jobs/:jobId — poll the status of a queued check.
router.get('/jobs/:jobId', requireAuth, async (req: AuthRequest, res: Response) => {
  const result = await db.query(
    `SELECT id, status, session_id, report_id, error, updated_at
     FROM check_jobs WHERE id = $1 AND teacher_id = $2`,
    [req.params.jobId, req.teacherId],
  );
  if (!result.rows[0]) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const job = result.rows[0];
  res.json({
    jobId: job.id,
    status: job.status,
    sessionId: job.session_id,
    reportId: job.report_id,
    error: job.error,
  });
});

// GET /api/checks/:sessionId/report — accepts either session_id or report_id
router.get('/:sessionId/report', requireAuth, async (req: AuthRequest, res: Response) => {
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

  if (!result.rows[0]) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }

  const report = result.rows[0];

  // Get answers
  const answersResult = await db.query(`
    SELECT a.*, t.question_text, t.task_type, t.max_score as task_max_score, t.slide_num, t.reference_answer as task_reference_answer
    FROM answers a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.session_id = $1
    ORDER BY t.task_index
  `, [report.session_id]);

  res.json({ ...report, answers: answersResult.rows });
});

export default router;
