import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { getDecryptedToken } from '../services/auth';
import { callGena, getChildsMaterials, getNewMaterialsMap } from '../ddp/gena-client';
import { db } from '../db';

const router = Router();

function extractGradeFromBranchName(name: string): string | null {
  const m = name.match(/^(\d{1,2})\s*класс/i);
  if (m) return m[1];
  return null;
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const loginToken = await getDecryptedToken(req.teacherId!);
    if (!loginToken) {
      res.status(401).json({ error: 'Login token expired — please re-login' });
      return;
    }

    const [branchesResult, skillsResult] = await Promise.all([
      callGena(loginToken, 'api.materials.getAllBranchesWithMaterialsBySkills', {}),
      callGena(loginToken, 'api.skills.getSkills', {}),
    ]);

    const skillMap: Record<string, string> = {};
    if (skillsResult && typeof skillsResult === 'object') {
      for (const [skillId, skillData] of Object.entries(skillsResult as Record<string, any>)) {
        const ru = (skillData as any)?.ru;
        if (ru?.title) {
          skillMap[skillId] = ru.title;
        }
      }
    }

    const page = parseInt(String(req.query.page || '1'), 10);
    const pageSize = parseInt(String(req.query.pageSize || '20'), 10);
    const filterGrade = req.query.grade ? String(req.query.grade) : null;
    const filterSkill = req.query.skillId ? String(req.query.skillId) : null;
    const filterType = req.query.type ? String(req.query.type) : null;
    const filterSearch = req.query.search ? String(req.query.search).trim().toLowerCase() : null;

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
            skillId,
            skillName,
            branchId,
            branchName,
            grade,
            type: mat.type || 'interactive',
            materialLink: mat.materialLink || null,
            lang: mat.lang || 'ru',
            tags: mat.tags || [],
          });
        }
      }
    }

    let filtered = allMaterials;
    if (filterGrade) {
      filtered = filtered.filter(m => m.grade === filterGrade);
    }
    if (filterSkill) {
      filtered = filtered.filter(m => m.skillId === filterSkill);
    }
    if (filterType) {
      filtered = filtered.filter(m => m.type === filterType);
    }
    if (filterSearch) {
      filtered = filtered.filter(m => m.title.toLowerCase().includes(filterSearch));
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginated = filtered.slice(offset, offset + pageSize);

    const uniqueSkills = Array.from(
      new Map(allMaterials.map(m => [m.skillId, { skillId: m.skillId, skillName: m.skillName }])).values()
    );
    const uniqueGrades = Array.from(new Set(allMaterials.map(m => m.grade).filter(Boolean))).sort(
      (a, b) => parseInt(a!) - parseInt(b!)
    );
    const uniqueTypes = Array.from(new Set(allMaterials.map(m => m.type).filter(Boolean)));

    res.json({
      materials: paginated,
      pagination: { page, pageSize, total, totalPages },
      filters: { skills: uniqueSkills, grades: uniqueGrades, types: uniqueTypes },
    });
  } catch (err: any) {
    console.error('[materials] GET / error:', err.message);
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

// GET /:materialId/students?dbOnly=true  → instant DB-only response
// GET /:materialId/students              → full response incl. slow platform fetch
router.get('/:materialId/students', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { materialId } = req.params;
    const dbOnly = req.query.dbOnly === 'true';

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

    // Return immediately if dbOnly requested
    if (dbOnly) {
      return res.json({
        students: checkedList,
        platformStudents: null,
        platformLoading: true,
        counts: { pending: 0, checked: checkedList.length, total: checkedList.length },
      });
    }

    // ── Phase 2: Platform fetch (slow DDP) ─────────────────────────────
    const loginToken = await getDecryptedToken(req.teacherId!);
    if (!loginToken) {
      return res.json({
        students: checkedList,
        platformStudents: [],
        platformLoading: false,
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
    const platformResults: any[] = [];

    const BATCH = 30;
    const uncheckedStudents = allStudents.filter((s: any) => !checkedStudentIds.has(s.platform_student_id));
    const TOTAL_TIMEOUT = 45000;
    const startTime = Date.now();

    for (let i = 0; i < uncheckedStudents.length; i += BATCH) {
      if (Date.now() - startTime > TOTAL_TIMEOUT) break;
      const batch = uncheckedStudents.slice(i, i + BATCH);
      const childsIds = batch.map((s: any) => s.platform_student_id);
      try {
        const result = await callGena(loginToken, 'api.materials.getChildsMaterials', { childsIds });
        if (!Array.isArray(result)) continue;
        for (const studentData of result) {
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
      } catch { /* skip failed batch */ }
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
