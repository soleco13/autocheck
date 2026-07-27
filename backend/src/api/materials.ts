import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { getDecryptedToken } from '../services/auth';
import { callGena, getChildsMaterials, getNewMaterialsMap } from '../ddp/gena-client';
import { db } from '../db';
import { cacheGet, cacheSet } from '../lib/redis-cache';

const router = Router();

function extractGradeFromBranchName(name: string): string | null {
  const m = name.match(/^(\d{1,2})\s*класс/i);
  if (m) return m[1];
  return null;
}

// Full materials catalog cached in Redis per teacher — 10 min TTL.
// Pagination/filtering applied on cached data IN-PROCESS: zero DDP calls on page 2, 3, …
// Catalog rarely changes (new lesson added = max once a day), so 10 min TTL is safe.
const CATALOG_TTL_S = 10 * 60;

interface CachedCatalog {
  allMaterials: any[];
  filters: { skills: any[]; grades: (string | null)[]; types: string[] };
}

async function fetchMaterialsCatalog(loginToken: string, teacherId: string): Promise<CachedCatalog | null> {
  const redisKey = `materials-catalog:${teacherId}`;

  // Cache hit — serve instantly (covers all subsequent paginated requests)
  const hit = await cacheGet<CachedCatalog>(redisKey);
  if (hit) return hit;

  // Cache miss — call Gena once, build full catalog, store in Redis
  const [branchesResult, skillsResult] = await Promise.all([
    callGena(loginToken, 'api.materials.getAllBranchesWithMaterialsBySkills', {}),
    callGena(loginToken, 'api.skills.getSkills', {}),
  ]);

  const skillMap: Record<string, string> = {};
  if (skillsResult && typeof skillsResult === 'object') {
    for (const [skillId, skillData] of Object.entries(skillsResult as Record<string, any>)) {
      const ru = (skillData as any)?.ru;
      if (ru?.title) skillMap[skillId] = ru.title;
    }
  }

  const allMaterials: any[] = [];
  if (Array.isArray(branchesResult)) {
    for (const branch of branchesResult) {
      const branchId = branch.id;
      const branchName: string = branch.name || '';
      const skillId: string = branch.skillId || '';
      const skillName = skillMap[skillId] || skillId;
      const grade = extractGradeFromBranchName(branchName);
      if (!Array.isArray(branch.materials)) continue;
      for (const mat of branch.materials) {
        allMaterials.push({
          _id: mat._id,
          title: mat.title || '',
          skillId, skillName, branchId, branchName, grade,
          type: mat.type || 'interactive',
          materialLink: mat.materialLink || null,
          lang: mat.lang || 'ru',
          tags: mat.tags || [],
        });
      }
    }
  }

  if (allMaterials.length === 0) return null; // don't cache empty result

  const filters = {
    skills: Array.from(
      new Map(allMaterials.map(m => [m.skillId, { skillId: m.skillId, skillName: m.skillName }])).values(),
    ),
    grades: Array.from(new Set(allMaterials.map(m => m.grade).filter(Boolean))).sort(
      (a, b) => parseInt(a!) - parseInt(b!),
    ),
    types: Array.from(new Set(allMaterials.map(m => m.type).filter(Boolean))),
  };

  const catalog: CachedCatalog = { allMaterials, filters };
  await cacheSet(redisKey, catalog, CATALOG_TTL_S);
  return catalog;
}

// GET /api/materials — full catalog with server-side pagination/filtering.
// Gena is called AT MOST ONCE per teacher per 10 minutes, regardless of page count.
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const loginToken = await getDecryptedToken(req.teacherId!);
    if (!loginToken) {
      res.status(401).json({ error: 'Login token expired — please re-login' });
      return;
    }

    const forceRefresh = req.query.refresh === 'true';
    if (forceRefresh) {
      // Invalidate cache so next call fetches fresh data
      const { cacheDel } = await import('../lib/redis-cache');
      await cacheDel(`materials-catalog:${req.teacherId}`);
    }

    const catalog = await fetchMaterialsCatalog(loginToken, req.teacherId!);

    if (!catalog) {
      // Gena returned empty — could be circuit open or no data
      res.json({ materials: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 }, filters: { skills: [], grades: [], types: [] } });
      return;
    }

    const { allMaterials, filters } = catalog;

    const page       = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize   = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '20'), 10)));
    const filterGrade  = req.query.grade   ? String(req.query.grade)  : null;
    const filterSkill  = req.query.skillId ? String(req.query.skillId) : null;
    const filterType   = req.query.type    ? String(req.query.type)    : null;
    const filterSearch = req.query.search  ? String(req.query.search).trim().toLowerCase() : null;

    let filtered = allMaterials;
    if (filterGrade)  filtered = filtered.filter(m => m.grade === filterGrade);
    if (filterSkill)  filtered = filtered.filter(m => m.skillId === filterSkill);
    if (filterType)   filtered = filtered.filter(m => m.type === filterType);
    if (filterSearch) filtered = filtered.filter(m => m.title.toLowerCase().includes(filterSearch));

    const total      = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset     = (page - 1) * pageSize;

    res.json({
      materials: filtered.slice(offset, offset + pageSize),
      pagination: { page, pageSize, total, totalPages },
      filters,
    });
  } catch (err: any) {
    console.error('[materials] GET / error:', err.message);
    // Any platform error (circuit open, auth failed, timeout) → 503 with empty list.
    // This prevents cascading 500 errors when Gena is unavailable.
    const isPlatformErr = err.message?.includes('CIRCUIT_OPEN')
      || err.message?.includes('недоступна')
      || err.message?.includes('DDP auth')
      || err.message?.includes('Auth failed')
      || err.message?.includes('PLATFORM_TIMEOUT')
      || err.message?.includes('платформ');
    if (isPlatformErr) {
      res.status(503).json({
        error: 'Платформа временно недоступна. Материалы загрузятся автоматически.',
        materials: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
        filters: { skills: [], grades: [], types: [] },
      });
      return;
    }
    res.status(500).json({ error: safeError(err) });
  }
});

// Helper: build checkedList from DB rows
function buildCheckedList(rows: any[]): any[] {
  return rows.map((r: any) => ({
    studentId: r.id,
    platformStudentId: r.platform_student_id,
    fullName: r.full_name,
    grade: r.grade,
    status: r.check_status || 'checked',
    reportGrade: r.report_grade,
    reportId: r.report_id || null,
    sessionId: r.session_id || null,
    percentage: r.percentage ? Math.round(Number(r.percentage)) : null,
    lastActivity: r.fetched_at,
    trainerToken: null,
    source: 'db',
  }));
}

// Redis cache key for teacher's student assignments (all materials at once)
const ASSIGNMENTS_TTL_S = 120; // 2 minutes

// Fetch assignments for all students in PARALLEL batches of 30.
// Old: 10 batches × 4s SEQUENTIAL = 40s
// New: 10 batches × 4s PARALLEL   = ~4s (bounded by genaGuard maxConcurrent=8)
// The batch size of 30 is preserved because the platform rejects larger arrays.
async function fetchAllStudentAssignments(
  loginToken: string,
  allPlatformIds: string[],
): Promise<any[]> {
  if (allPlatformIds.length === 0) return [];

  const BATCH = 30;
  const batches: string[][] = [];
  for (let i = 0; i < allPlatformIds.length; i += BATCH) {
    batches.push(allPlatformIds.slice(i, i + BATCH));
  }

  const results = await Promise.allSettled(
    batches.map(chunk =>
      callGena(loginToken, 'api.materials.getChildsMaterials', { childsIds: chunk }),
    ),
  );

  const combined: any[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      combined.push(...r.value);
    }
  }
  return combined;
}

// GET /:materialId/students?dbOnly=true  → instant DB-only response
// GET /:materialId/students              → full response incl. platform fetch (cached 2 min)
router.get('/:materialId/students', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { materialId } = req.params;
    const dbOnly = req.query.dbOnly === 'true';
    const forceRefresh = req.query.refresh === 'true';

    // ── Phase 1: DB-checked sessions (always instant) ──────────────────
    const checkedResult = await db.query(`
      SELECT s.id, s.platform_student_id, s.full_name, s.grade,
             ss.id as session_id, ss.fetched_at,
             r.id as report_id, r.status as check_status,
             r.grade as report_grade, r.percentage
      FROM student_sessions ss
      JOIN control_sheets cs ON cs.id = ss.control_sheet_id
      JOIN students s ON s.id = ss.student_id
      LEFT JOIN reports r ON r.session_id = ss.id
      WHERE cs.platform_material_id = $1 AND ss.teacher_id = $2
      ORDER BY ss.fetched_at DESC
    `, [materialId, req.teacherId]);

    const checkedList = buildCheckedList(checkedResult.rows);
    const checkedStudentIds = new Set(checkedResult.rows.map((r: any) => r.platform_student_id));

    if (dbOnly) {
      return res.json({
        students: checkedList,
        platformStudents: null,
        platformLoading: true,
        counts: { pending: 0, checked: checkedList.length, total: checkedList.length },
      });
    }

    // ── Phase 2: Platform fetch (cached) ───────────────────────────────
    const loginToken = await getDecryptedToken(req.teacherId!);
    if (!loginToken) {
      return res.json({
        students: checkedList, platformStudents: [], platformLoading: false,
        platformError: 'Login token expired',
        counts: { pending: 0, checked: checkedList.length, total: checkedList.length },
      });
    }

    const allStudentsResult = await db.query(`
      SELECT s.id, s.platform_student_id, s.full_name, s.grade
      FROM students s
      JOIN teacher_students ts ON ts.student_id = s.id
      WHERE ts.teacher_id = $1
    `, [req.teacherId]);

    const allStudents = allStudentsResult.rows;
    const studentByPid = new Map(allStudents.map((s: any) => [s.platform_student_id, s]));
    const uncheckedStudents = allStudents.filter((s: any) => !checkedStudentIds.has(s.platform_student_id));

    // Redis cache — shared across all processes, survives restarts
    const redisKey = `assignments:${req.teacherId}`;
    let rawAssignments: any[] = [];

    if (!forceRefresh) {
      rawAssignments = (await cacheGet<any[]>(redisKey)) ?? [];
    }

    if (rawAssignments.length === 0) {
      const allPlatformIds = uncheckedStudents.map((s: any) => s.platform_student_id);
      rawAssignments = await fetchAllStudentAssignments(loginToken, allPlatformIds);
      if (rawAssignments.length > 0) {
        await cacheSet(redisKey, rawAssignments, ASSIGNMENTS_TTL_S);
      }
    }

    // Filter for this specific materialId
    const platformResults: any[] = [];
    for (const studentData of rawAssignments) {
      const assignment = (studentData.materials || []).find((m: any) => m.materialId === materialId);
      if (!assignment) continue;
      const s = studentByPid.get(studentData._id);
      if (!s || checkedStudentIds.has(studentData._id)) continue;
      const activityEvents: any[] = assignment.activity || [];
      const lastActivity = activityEvents[activityEvents.length - 1]?.ts || null;
      platformResults.push({
        studentId: s.id,
        platformStudentId: studentData._id,
        fullName: s.full_name,
        grade: s.grade,
        status: assignment.status || 'done',
        lastActivity,
        trainerToken: assignment.interactiveData?.trainerToken || null,
        reportId: null,
        sessionId: null,
        source: 'platform',
      });
    }

    platformResults.sort((a, b) => {
      const order: Record<string, number> = { done: 0, inProgress: 1, notStarted: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    });

    const allResults = [...platformResults, ...checkedList];
    res.json({
      students: allResults,
      platformStudents: platformResults,
      platformLoading: false,
      counts: {
        pending: platformResults.filter((s: any) => s.status === 'done').length,
        inProgress: platformResults.filter((s: any) => s.status === 'inProgress').length,
        checked: checkedList.length,
        total: allResults.length,
      },
    });
  } catch (err: any) {
    console.error('[materials/:id/students] error:', err.message);
    res.status(500).json({ error: safeError(err) });
  }
});

export default router;
