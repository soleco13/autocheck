import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { db } from '../db';
import { syncStudentsForTeacher, syncClassroomsForTeacher } from '../services/session-fetcher';
import { getDecryptedToken } from '../services/auth';
import { getChildsMaterials, getMaterialTitleMap } from '../ddp/gena-client';
import { cacheGet, cacheSet, cacheDel } from '../lib/redis-cache';
import { configStore } from '../lib/config-store';

const router = Router();

function getWorksTtlSeconds() {
  try { return configStore.get('works_cache_ttl_min') * 60; } catch { return 300; }
}

function worksCacheKey(teacherId: string, studentId: string): string {
  return `works:${teacherId}:${studentId}`;
}

// GET /api/students?sync=true&search=...&page=1&pageSize=50
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.query.sync === 'true') {
    try {
      await syncStudentsForTeacher(req.teacherId!);
    } catch (err: any) {
      console.warn('Sync warning (returning cached data):', err.message);
    }
  }

  try {
    const search  = (req.query.search  as string || '').trim();
    const page     = Math.max(1, parseInt(req.query.page     as string || '1',  10));
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize as string || '200', 10)));
    const offset   = (page - 1) * pageSize;

    const conditions: string[] = ['ts.teacher_id = $1'];
    const params: any[] = [req.teacherId];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(s.full_name ILIKE $${params.length} OR s.nickname ILIKE $${params.length})`);
    }

    const where = conditions.join(' AND ');
    params.push(pageSize, offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const [dataResult, countResult] = await Promise.all([
      db.query(`
        WITH grade_cte AS (
          SELECT DISTINCT ON (ss.student_id) ss.student_id, cs.grade
          FROM student_sessions ss
          JOIN control_sheets cs ON cs.id = ss.control_sheet_id
          WHERE ss.teacher_id = $1 AND cs.grade > 0
          ORDER BY ss.student_id, ss.fetched_at DESC
        ),
        classroom_cte AS (
          SELECT crs.student_id, ARRAY_AGG(cr.name ORDER BY cr.name) AS classrooms
          FROM classroom_students crs
          JOIN classrooms cr ON cr.id = crs.classroom_id
          WHERE cr.teacher_id = $1
          GROUP BY crs.student_id
        ),
        subject_cte AS (
          SELECT ss.student_id, ARRAY_AGG(DISTINCT cs.subject_code ORDER BY cs.subject_code) AS subjects
          FROM student_sessions ss
          JOIN control_sheets cs ON cs.id = ss.control_sheet_id
          WHERE ss.teacher_id = $1 AND cs.subject_code IS NOT NULL
          GROUP BY ss.student_id
        )
        SELECT
          s.id, s.platform_student_id, s.full_name, s.nickname, s.cached_at,
          COALESCE(NULLIF(s.grade, 0), gc.grade) AS grade,
          COALESCE(cc.classrooms, ARRAY[]::text[]) AS classrooms,
          COALESCE(sc.subjects, ARRAY[]::text[]) AS subjects
        FROM students s
        JOIN teacher_students ts ON ts.student_id = s.id
        LEFT JOIN grade_cte gc ON gc.student_id = s.id
        LEFT JOIN classroom_cte cc ON cc.student_id = s.id
        LEFT JOIN subject_cte sc ON sc.student_id = s.id
        WHERE ${where}
        ORDER BY s.full_name
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params),
      db.query(`
        SELECT COUNT(*) FROM students s
        JOIN teacher_students ts ON ts.student_id = s.id
        WHERE ${where}
      `, params.slice(0, params.length - 2)),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    res.json({
      students: dataResult.rows,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
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

    // Redis cache for platform data — survives restarts and shared across processes
    const cacheKey = worksCacheKey(req.teacherId!, req.params.id);
    if (!forceRefresh) {
      const hit = await cacheGet<{ extras: any[]; error: string | null }>(cacheKey);
      if (hit) { platformExtras = hit.extras; platformError = hit.error; }
    }
    if (forceRefresh || (platformExtras.length === 0 && !platformError))
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

    // Store in Redis cache (even errors, to avoid hammering the platform)
    await cacheSet(cacheKey, { extras: platformExtras, error: platformError }, getWorksTtlSeconds());

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
