import { db } from '../db';
import { getDecryptedToken, getDecryptedEdikToken } from './auth';
import { getMyStudents, getMaterialSessionJwt, getMaterialTitleMap, getMyClazzes } from '../ddp/gena-client';
import { getMaterialBySession, getMaterialSessionState, getMaterialSessionJwtFromEdik } from '../ddp/edik-client';
import { parseMaterialTitle } from '../lib/title-parser';

const EDITOR_URL_PREFIX = 'https://editor.good-teach.itgen.io/s/';

/**
 * Extracts a JWT from:
 * - Full editor URL: https://editor.good-teach.itgen.io/s/<JWT>
 * - Bare JWT string (3 base64 segments separated by dots)
 * Returns null if the input looks like a plain material/session ID.
 */
export function extractJwtFromEditorInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith(EDITOR_URL_PREFIX)) {
    const jwt = trimmed.slice(EDITOR_URL_PREFIX.length).split('?')[0];
    return jwt.split('.').length === 3 ? jwt : null;
  }
  if (trimmed.split('.').length === 3 && trimmed.length > 40) {
    return trimmed;
  }
  return null;
}

export async function syncStudentsForTeacher(teacherId: string): Promise<void> {
  const loginToken = await getDecryptedToken(teacherId);
  if (!loginToken) throw new Error('Platform token expired, please re-login');

  const teacherResult = await db.query('SELECT platform_user_id FROM teachers WHERE id = $1', [teacherId]);
  if (!teacherResult.rows[0]) throw new Error('Teacher not found');
  const platformUserId = teacherResult.rows[0].platform_user_id;

  const children = await getMyStudents(loginToken, platformUserId);
  if (!children.length) {
    console.warn('[sync] No students found via any method');
    return;
  }

  console.log(`[sync] Syncing ${children.length} students for teacher ${teacherId}`);

  for (const child of children) {
    const platformStudentId = child._id || child.userId || child.social__id || child.id;
    if (!platformStudentId) continue;

    const firstName = child.firstName || child.profile?.firstName || '';
    const lastName  = child.lastName  || child.profile?.lastName  || '';
    const constructedName = [firstName, lastName].filter(Boolean).join(' ');
    const fullName = child.profile?.name || child.social__name || child.name || constructedName || 'Unknown';
    const nickname = child.social__nickname || child.profile?.nickname || null;
    const grade = child.grade || child.classNumber || child.profile?.grade || null;

    await db.query(`
      INSERT INTO students (platform_student_id, full_name, nickname, grade, cached_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (platform_student_id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        nickname = EXCLUDED.nickname,
        -- preserve existing grade if platform doesn't send one
        grade = COALESCE(EXCLUDED.grade, students.grade),
        cached_at = NOW()
    `, [platformStudentId, fullName, nickname, grade]);

    const studentResult = await db.query(
      'SELECT id FROM students WHERE platform_student_id = $1',
      [platformStudentId]
    );
    if (!studentResult.rows[0]) continue;

    await db.query(`
      INSERT INTO teacher_students (teacher_id, student_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [teacherId, studentResult.rows[0].id]);
  }

  // Backfill grade for students that still have NULL grade,
  // using the most recent control_sheet grade from their sessions.
  await db.query(`
    UPDATE students s
    SET grade = sub.cs_grade
    FROM (
      SELECT DISTINCT ON (ss.student_id)
        ss.student_id,
        cs.grade AS cs_grade
      FROM student_sessions ss
      JOIN control_sheets cs ON cs.id = ss.control_sheet_id
      JOIN teacher_students ts ON ts.student_id = ss.student_id
      WHERE ts.teacher_id = $1
        AND cs.grade > 0
      ORDER BY ss.student_id, ss.fetched_at DESC
    ) sub
    WHERE s.id = sub.student_id
      AND (s.grade IS NULL OR s.grade = 0)
  `, [teacherId]);
}

/**
 * Syncs classrooms (class groups) for a teacher from the platform.
 * Stores classroom names and student membership in DB.
 */
export async function syncClassroomsForTeacher(teacherId: string): Promise<{ synced: number; error?: string }> {
  const loginToken = await getDecryptedToken(teacherId);
  if (!loginToken) return { synced: 0, error: 'Token not found' };

  let clazzes: any[];
  try {
    clazzes = await getMyClazzes(loginToken);
  } catch (err: any) {
    return { synced: 0, error: err.message };
  }

  if (!clazzes.length) return { synced: 0, error: 'No classrooms returned from platform' };

  // Get student platform_id → internal id mapping
  const studentsResult = await db.query(`
    SELECT s.id, s.platform_student_id
    FROM students s
    JOIN teacher_students ts ON ts.student_id = s.id
    WHERE ts.teacher_id = $1
  `, [teacherId]);
  const pidToId = new Map<string, string>(
    studentsResult.rows.map((r: any) => [r.platform_student_id, r.id])
  );

  let synced = 0;
  for (const clazz of clazzes) {
    const platformId: string = clazz._id || clazz.id;
    const name: string = clazz.name || clazz.title || clazz.className || platformId;
    if (!platformId || !name) continue;

    // Upsert classroom
    const crResult = await db.query(`
      INSERT INTO classrooms (teacher_id, platform_classroom_id, name, cached_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (teacher_id, platform_classroom_id) DO UPDATE
        SET name = EXCLUDED.name, cached_at = NOW()
      RETURNING id
    `, [teacherId, platformId, name]);
    const classroomId: string = crResult.rows[0].id;

    // Get student list from classroom.
    // Platform returns childs: [{ id: platformStudentId, fullName }]
    const studentPids: string[] = (
      clazz.childs || clazz.children || clazz.students || clazz.childIds || clazz.studentIds || []
    ).map((s: any) => (typeof s === 'string' ? s : s.id || s._id || s.userId)).filter(Boolean);

    // Remove old memberships and re-insert
    await db.query('DELETE FROM classroom_students WHERE classroom_id = $1', [classroomId]);
    for (const pid of studentPids) {
      const studentId = pidToId.get(pid);
      if (!studentId) continue;
      await db.query(`
        INSERT INTO classroom_students (classroom_id, student_id)
        VALUES ($1, $2) ON CONFLICT DO NOTHING
      `, [classroomId, studentId]);
    }
    synced++;
  }
  return { synced };
}

/**
 * Fetches session state using a known JWT (from editor URL).
 * The JWT is the access token embedded in https://editor.good-teach.itgen.io/s/<JWT>.
 */
/**
 * Fetches session state using a materialId from the new getChildsMaterials response.
 * The trainerToken is embedded in interactiveData.trainerToken — no separate JWT lookup needed.
 */
export async function fetchSessionStateByMaterialData(
  teacherId: string,
  platformStudentId: string,
  materialId: string,
  trainerToken: string
): Promise<{ sessionId: string; rawState: any }> {
  return fetchSessionStateByJwt(teacherId, platformStudentId, trainerToken, materialId);
}

export async function fetchSessionStateByJwt(
  teacherId: string,
  platformStudentId: string,
  jwt: string,
  knownMaterialId?: string
): Promise<{ sessionId: string; rawState: any }> {
  const studentResult = await db.query(
    'SELECT id FROM students WHERE platform_student_id = $1',
    [platformStudentId]
  );
  if (!studentResult.rows[0]) throw new Error('Student not found in local DB');
  const studentId = studentResult.rows[0].id;

  // getMaterialSessionState works WITHOUT Edik user auth — JWT is the access token.
  const rawState = await getMaterialSessionState(jwt);
  if (!rawState) throw new Error('Edik: getMaterialSessionState returned null — JWT may be invalid or expired');

  // Extract materialId: prefer caller-provided value (from getChildsMaterials), then baseState uid
  const materialId: string = knownMaterialId || rawState.baseState?.__meta?.uid || 'unknown';

  // Try to get title via getMaterialBySession (requires Edik auth, may return null)
  // Fallback: use title map from Gena's getAllBranchesWithMaterialsBySkills
  let title = 'Unknown';
  try {
    const edikToken = await getDecryptedEdikToken(teacherId);
    const material = await getMaterialBySession(jwt, edikToken || undefined);
    if (material?.title) title = material.title;
  } catch { /* title is optional */ }

  if (title === 'Unknown' || !title) {
    try {
      const loginToken = await getDecryptedToken(teacherId);
      if (loginToken) {
        const titleMap = await getMaterialTitleMap(loginToken);
        const mapped = titleMap.get(materialId);
        if (mapped) title = mapped;
      }
    } catch { /* ignore */ }
  }

  const parsed = parseMaterialTitle(title);

  await db.query(`
    INSERT INTO control_sheets (platform_material_id, title, grade, subject_code, number, topic, cached_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (platform_material_id) DO UPDATE SET
      title = EXCLUDED.title,
      grade = EXCLUDED.grade,
      subject_code = EXCLUDED.subject_code,
      number = EXCLUDED.number,
      topic = EXCLUDED.topic,
      cached_at = NOW()
  `, [materialId, title, parsed?.grade || 0, parsed?.subjectCode || 'XX', parsed?.number || 0, parsed?.topic || title]);

  const csResult = await db.query('SELECT id FROM control_sheets WHERE platform_material_id = $1', [materialId]);
  const controlSheetId = csResult.rows[0].id;

  // Extract msid from JWT payload
  let msid: string | null = null;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    msid = payload.msid || null;
  } catch {}

  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 10);

  // Upsert: update existing session if same msid exists, otherwise insert
  let sessionId: string;
  if (msid) {
    const existing = await db.query(
      'SELECT id FROM student_sessions WHERE platform_session_id = $1',
      [msid]
    );
    if (existing.rows[0]) {
      await db.query(
        'UPDATE student_sessions SET raw_state = $1, fetched_at = NOW() WHERE id = $2',
        [JSON.stringify(rawState), existing.rows[0].id]
      );
      sessionId = existing.rows[0].id;
    } else {
      const ins = await db.query(`
        INSERT INTO student_sessions (platform_session_id, jwt_token, jwt_expires_at, control_sheet_id, student_id, teacher_id, raw_state, fetched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id
      `, [msid, jwt, expires, controlSheetId, studentId, teacherId, JSON.stringify(rawState)]);
      sessionId = ins.rows[0].id;
    }
  } else {
    const ins = await db.query(`
      INSERT INTO student_sessions (platform_session_id, jwt_token, jwt_expires_at, control_sheet_id, student_id, teacher_id, raw_state, fetched_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id
    `, [null, jwt, expires, controlSheetId, studentId, teacherId, JSON.stringify(rawState)]);
    sessionId = ins.rows[0].id;
  }

  return { sessionId, rawState };
}

export async function fetchSessionState(
  teacherId: string,
  platformStudentId: string,
  platformMaterialId: string
): Promise<{ sessionId: string; rawState: any }> {
  const loginToken = await getDecryptedToken(teacherId);
  if (!loginToken) throw new Error('Platform token expired, please re-login');

  // Get or create student record
  const studentResult = await db.query(
    'SELECT id FROM students WHERE platform_student_id = $1',
    [platformStudentId]
  );
  if (!studentResult.rows[0]) throw new Error('Student not found in local DB');
  const studentId = studentResult.rows[0].id;

  // 1. Try Gena methods for JWT
  let jwtToken: string | null = null;
  try {
    jwtToken = await getMaterialSessionJwt(loginToken, platformMaterialId, platformStudentId);
  } catch (err: any) {
    console.warn('[fetchSessionState] getMaterialSessionJwt (Gena) threw:', err.message);
  }
  if (jwtToken) {
    console.log('[fetchSessionState] Got real JWT from Gena ✓');
  }

  // 2. Try Edik methods for JWT (api.materials-sessions.* live on Edik, not Gena)
  if (!jwtToken) {
    console.log('[fetchSessionState] Trying JWT via Edik methods...');
    try {
      jwtToken = await getMaterialSessionJwtFromEdik(platformMaterialId, platformStudentId);
    } catch (err: any) {
      console.warn('[fetchSessionState] getMaterialSessionJwtFromEdik threw:', err.message);
    }
    if (jwtToken) {
      console.log('[fetchSessionState] Got real JWT from Edik ✓');
    }
  }

  if (!jwtToken) {
    throw new Error(
      'Не удалось получить JWT для сессии материала. ' +
      'Используйте ссылку из редактора: откройте работу ученика, скопируйте URL страницы и вставьте его в поле.'
    );
  }

  // Get material metadata from Edik
  const material = await getMaterialBySession(jwtToken);
  const title = material?.title || 'Unknown';
  const parsed = parseMaterialTitle(title);

  // Ensure control_sheet exists
  await db.query(`
    INSERT INTO control_sheets (platform_material_id, title, grade, subject_code, number, topic, cached_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (platform_material_id) DO UPDATE SET
      title = EXCLUDED.title,
      grade = EXCLUDED.grade,
      subject_code = EXCLUDED.subject_code,
      number = EXCLUDED.number,
      topic = EXCLUDED.topic,
      cached_at = NOW()
  `, [
    platformMaterialId,
    title,
    parsed?.grade || 0,
    parsed?.subjectCode || 'XX',
    parsed?.number || 0,
    parsed?.topic || title,
  ]);

  const csResult = await db.query(
    'SELECT id FROM control_sheets WHERE platform_material_id = $1',
    [platformMaterialId]
  );
  const controlSheetId = csResult.rows[0].id;

  // Get session state with student answers
  const rawState = await getMaterialSessionState(jwtToken);

  // Decode JWT to get msid
  const tokenParts = jwtToken.split('.');
  let msid: string | null = null;
  if (tokenParts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());
      msid = payload.msid || null;
    } catch {}
  }

  // Save session
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1); // 1 year as safe default

  const sessionResult = await db.query(`
    INSERT INTO student_sessions (platform_session_id, jwt_token, jwt_expires_at, control_sheet_id, student_id, teacher_id, raw_state, fetched_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    RETURNING id
  `, [msid, jwtToken, expires, controlSheetId, studentId, teacherId, JSON.stringify(rawState)]);

  return {
    sessionId: sessionResult.rows[0].id,
    rawState,
  };
}
