import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { db } from '../db';
import { z } from 'zod';
import { safeError } from '../lib/safe-error';
import { audit } from '../lib/audit';

const router = Router();

// GET /api/reports/history
router.get('/history', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize as string || '20', 10)));
    const offset = (page - 1) * pageSize;
    const studentId = (req.query.studentId as string) || null;
    const status   = (req.query.status   as string) || null;
    const search   = (req.query.search   as string) || null;

    const conditions: string[] = ['ss.teacher_id = $1'];
    const params: any[] = [req.teacherId];
    let idx = 2;

    if (studentId) { conditions.push(`s.id = $${idx++}`);                                                  params.push(studentId); }
    if (status)    { conditions.push(`r.status = $${idx++}`);                                              params.push(status); }
    if (search)    { conditions.push(`(cs.title ILIKE $${idx} OR cs.topic ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const where = conditions.join(' AND ');

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM reports r
                JOIN student_sessions ss ON ss.id = r.session_id
                JOIN students s ON s.id = ss.student_id
                JOIN control_sheets cs ON cs.id = ss.control_sheet_id
                WHERE ${where}`, params),
      db.query(`SELECT r.id, r.status, r.grade as report_grade, r.percentage, r.generated_at,
                       r.total_score, r.max_score,
                       s.id as student_id, s.full_name as student_name, s.grade,
                       cs.title, cs.topic
                FROM reports r
                JOIN student_sessions ss ON ss.id = r.session_id
                JOIN students s ON s.id = ss.student_id
                JOIN control_sheets cs ON cs.id = ss.control_sheet_id
                WHERE ${where}
                ORDER BY r.generated_at DESC
                LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, pageSize, offset]),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    res.json({
      reports: dataResult.rows,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/reports/:id — single query with JSON aggregation (2→1 round-trip)
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        r.id, r.session_id, r.total_score, r.max_score, r.percentage,
        r.grade as report_grade, r.status, r.ai_summary_for_student, r.ai_summary_for_teacher,
        r.generated_at, ss.fetched_at,
        s.id as student_id, s.full_name as student_name,
        cs.title, cs.topic, cs.grade, cs.subject_code,
        COALESCE(
          json_agg(
            json_build_object(
              'id',                     a.id,
              'session_id',             a.session_id,
              'task_id',                a.task_id,
              'student_answer',         a.student_answer,
              'student_answer_structured', a.student_answer_structured,
              'score',                  a.score,
              'status',                 a.status,
              'ai_feedback',            a.ai_feedback,
              'ai_teacher_note',        a.ai_teacher_note,
              'teacher_override_score', a.teacher_override_score,
              'teacher_override_at',    a.teacher_override_at,
              'created_at',             a.created_at,
              'question_text',          t.question_text,
              'task_type',              t.task_type,
              'task_max_score',         t.max_score,
              'slide_num',              t.slide_num,
              'task_reference_answer',  t.reference_answer,
              'task_index',             t.task_index
            ) ORDER BY t.task_index
          ) FILTER (WHERE a.id IS NOT NULL),
          '[]'::json
        ) AS answers
      FROM reports r
      JOIN student_sessions ss ON ss.id = r.session_id
      JOIN students s         ON s.id  = ss.student_id
      JOIN control_sheets cs  ON cs.id = ss.control_sheet_id
      LEFT JOIN answers a     ON a.session_id = r.session_id
      LEFT JOIN tasks t       ON t.id = a.task_id
      WHERE r.id = $1 AND ss.teacher_id = $2
      GROUP BY r.id, ss.fetched_at, s.id, cs.id
    `, [req.params.id, req.teacherId]);

    if (!result.rows[0]) { res.status(404).json({ error: 'Report not found' }); return; }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// PATCH /api/reports/answers/:answerId/override
const overrideSchema = z.object({
  score: z.number().int().min(0),
  note:  z.string().max(1000).optional(),
});

router.patch('/answers/:answerId/override', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  const { score, note } = parsed.data;

  try {
    // Scoped to this teacher's students — prevents cross-teacher score tampering
    const result = await db.query(`
      UPDATE answers SET
        teacher_override_score = $1,
        ai_teacher_note        = COALESCE($2, ai_teacher_note),
        teacher_override_at    = NOW()
      WHERE id = $3
        AND session_id IN (
          SELECT id FROM student_sessions WHERE teacher_id = $4
        )
      RETURNING *
    `, [score, note ?? null, req.params.answerId, req.teacherId]);

    if (!result.rows[0]) { res.status(404).json({ error: 'Answer not found' }); return; }
    audit({ teacherId: req.teacherId!, action: 'score_override', entityType: 'answer', entityId: req.params.answerId, metadata: { score, note } });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

export default router;
