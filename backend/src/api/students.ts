import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { db } from '../db';
import { syncStudentsForTeacher, syncClassroomsForTeacher } from '../services/session-fetcher';
import { getDecryptedToken } from '../services/auth';
import { getChildsMaterials, getMaterialTitleMap } from '../ddp/gena-client';

const router = Router();

// In-memory LRU cache for platform works data per (teacher, student)
// TTL: 5 minutes, max 500 entries — prevents unbounded memory growth
const worksCache = new Map<string, { data: any; at: number }>();
const WORKS_TTL = 5 * 60_000;
const WORKS_CACHE_MAX = 500;

function worksCacheSet(key: string, value: { data: any; at: number }) {
  if (worksCache.size >= WORKS_CACHE_MAX && !worksCache.has(key)) {
    worksCache.delete(worksCache.keys().next().value!);  // evict oldest (Map is insertion-ordered)
  }
  worksCache.set(key, value);
  // Periodic TTL cleanup every 50 writes
  if (worksCache.size % 50 === 0) {
    const now = Date.now();
    for (const [k, v] of worksCache) if (now - v.at > WORKS_TTL) worksCache.delete(k);
  }
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  let syncError: string | null = null;

  if (req.query.sync === 'true') {
    try {
      await syncStudentsForTeacher(req.teacherId!);
    } catch (err: any) {
      syncError = err.message;
      console.warn('Sync warning (returning cached data):', err.message);
    }
  }

  try {
    // Use CTEs instead of correlated subqueries — avoids N×2 per-row lookups for 200+ students.
    const result = await db.query(`
      WITH grade_cte AS (
        SELECT DISTINCT ON (ss.student_id)
          ss.student_id,
          cs.grade
        FROM student_sessions ss
        JOIN control_sheets cs ON cs.id = ss.control_sheet_id
        WHERE ss.teacher_id = $1 AND cs.grade > 0
        ORDER BY ss.student_id, ss.fetched_at DESC
      ),
      classroom_cte AS (
        SELECT crs.student_id,
               ARRAY_AGG(cr.name ORDER BY cr.name) AS classrooms
        FROM classroom_students crs
        JOIN classrooms cr ON cr.id = crs.classroom_id
        WHERE cr.teacher_id = $1
        GROUP BY crs.student_id
      )
      SELECT
        s.id, s.platform_student_id, s.full_name, s.nickname, s.cached_at,
        COALESCE(NULLIF(s.grade, 0), gc.grade) AS grade,
        COALESCE(cc.classrooms, ARRAY[]::text[]) AS classrooms
      FROM students s
      JOIN teacher_students ts ON ts.student_id = s.id
      LEFT JOIN grade_cte gc ON gc.student_id = s.id
      LEFT JOIN classroom_cte cc ON cc.student_id = s.id
      WHERE ts.teacher_id = $1
      ORDER BY s.full_name
    `, [req.teacherId]);

    res.json(result.rows);
  } catch (err: any) {
    console.error('Get students DB error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const result = await db.query(`
    SELECT s.* FROM students s
    JOIN teacher_students ts ON ts.student_id = s.id
    WHERE s.id = $1 AND ts.teacher_id = $2
  `, [req.params.id, req.teacherId]);

  if (!result.rows[0]) {
    res.status(404).json({ error: 'Student not found' });
    return;
  }
  res.json(result.rows[0]);
});

router.get('/:id/works', requireAuth, async (req: AuthRequest, res: Response) => {
  const forceRefresh = req.query.refresh === 'true';
  try {
    // Already-checked sessions from DB (include jwt_token for Edik viewer link)
    const sessionsResult = await db.query(`
      SELECT ss.id, ss.fetched_at, ss.jwt_token as trainer_token,
             cs.title, cs.topic, cs.grade, cs.subject_code,
             cs.platform_material_id,
             r.status as check_status, r.grade as report_grade, r.percentage
      FROM student_sessions ss
      JOIN control_sheets cs ON cs.id = ss.control_sheet_id
      LEFT JOIN reports r ON r.session_id = ss.id
      WHERE ss.student_id = $1 AND ss.teacher_id = $2
      ORDER BY ss.fetched_at DESC
    `, [req.params.id, req.teacherId]);

    const sessions = sessionsResult.rows;
    const checkedIds = new Set(sessions.map((s: any) => s.platform_material_id));

    let platformExtras: any[] = [];
    let platformError: string | null = null;

    // Check server-side cache for platform data (avoids repeated DDP calls)
    const cacheKey = `${req.teacherId}:${req.params.id}`;
    const cached = worksCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.at < WORKS_TTL) {
      platformExtras = cached.data.extras;
      platformError = cached.data.error;
    } else
    try {
      const [studentRow, teacherRow] = await Promise.all([
        db.query('SELECT platform_student_id FROM students WHERE id = $1', [req.params.id]),
        db.query('SELECT platform_user_id FROM teachers WHERE id = $1', [req.teacherId]),
      ]);

      if (studentRow.rows[0] && teacherRow.rows[0]) {
        const childPlatformId: string = studentRow.rows[0].platform_student_id;
        const teacherPlatformId: string = teacherRow.rows[0].platform_user_id;
        const loginToken = await getDecryptedToken(req.teacherId!);

        if (!loginToken) {
          platformError = 'Login token expired — please re-login';
        } else {
          const [materials, titleMap] = await Promise.all([
            getChildsMaterials(loginToken, childPlatformId, teacherPlatformId),
            getMaterialTitleMap(loginToken),
          ]);

          if (materials.length === 0) {
            platformError = 'Не удалось загрузить материалы с платформы (сервер временно недоступен)';
          }

          // New format: [{materialId, activity, interactiveData}]
          // Filter to 'done' materials not yet checked
          const doneMaterials = materials.filter((m: any) => {
            const mid = m.materialId || m._id;
            if (!mid || checkedIds.has(mid)) return false;
            const lastStatus = m.activity?.filter((a: any) => a.t === 'changeStatus')?.slice(-1)[0];
            return lastStatus?.d?.to === 'done';
          });

          platformExtras = doneMaterials.map((m: any) => {
            const mid = m.materialId || m._id;
            const trainerToken = m.interactiveData?.trainerToken || null;
            const title = titleMap.get(mid) || null;
            return {
              id: null,
              platform_material_id: mid,
              title: title || mid,
              topic: null,
              grade: null,
              subject_code: null,
              check_status: null,
              report_grade: null,
              percentage: null,
              trainer_token: trainerToken,
            };
          });
        }
      }
    } catch (err: any) {
      platformError = err.message;
      console.warn('[works] Platform fetch error:', err.message);
    }

    // Store platform result in cache (even errors, to avoid hammering the platform)
    worksCacheSet(cacheKey, { data: { extras: platformExtras, error: platformError }, at: Date.now() });

    res.json({ works: [...sessions, ...platformExtras], platformError });
  } catch (err: any) {
    console.error('Get works error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

router.post('/:id/sync', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await syncStudentsForTeacher(req.teacherId!);
    res.json({ message: 'Students synced' });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/students/sync-classrooms — sync class groups from platform
router.post('/sync-classrooms', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await syncClassroomsForTeacher(req.teacherId!);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

export default router;
