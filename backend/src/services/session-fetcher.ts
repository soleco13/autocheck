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

  // Parse all student records first
  const parsed = children.map(child => {
    const platformStudentId: string = child._id || child.userId || child.social__id || child.id || '';
    const firstName = child.firstName || child.profile?.firstName || '';
    const lastName  = child.lastName  || child.profile?.lastName  || '';
    const constructedName = [firstName, lastName].filter(Boolean).join(' ');
    const fullName: string = child.profile?.name || child.social__name || child.name || constructedName || 'Unknown';
    const nickname: string | null = child.social__nickname || child.profile?.nickname || null;
    const grade: number | null = child.grade || child.classNumber || child.profile?.grade || null;
    return { platformStudentId, fullName, nickname, grade };
  }).filter(c => c.platformStudentId);

  if (parsed.length === 0) return;

  // Bulk upsert all students in one query — replaces N×3 queries with 2 total
  const vals: any[] = [];
  const placeholders = parsed.map((c, i) => {
    const b = i * 4;
    vals.push(c.platformStudentId, c.fullName, c.nickname, c.grade);
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, NOW())`;
  });

  const inserted = await db.query(`
    INSERT INTO students (platform_student_id, full_name, nickname, grade, cached_at)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (platform_student_id) DO UPDATE SET
      full_name  = EXCLUDED.full_name,
      nickname   = EXCLUDED.nickname,
      grade      = COALESCE(EXCLUDED.grade, students.grade),
      cached_at  = NOW()
    RETURNING id, platform_student_id
  `, vals);

  // Bulk upsert teacher_students in one query
  if (inserted.rows.length > 0) {
    const tsVals: any[] = [teacherId];
    const tsPlaceholders = inserted.rows.map((r: any, i: number) => {
      tsVals.push(r.id);
      return `($1, $${i + 2})`;
    });
    await db.query(`
      INSERT INTO teacher_students (teacher_id, student_id)
      VALUES ${tsPlaceholders.join(',')}
      ON CONFLICT DO NOTHING
    `, tsVals);
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

  // Title resolution — cheapest source first to minimise Edik calls under bulk load.
  // 1. DB cache: if this material was checked before, reuse the stored title (7-day TTL).
  //    This alone eliminates >90% of Edik title calls for re-checks.
  // 2. Edik getMaterialBySession (requires auth — only called on cache miss).
  // 3. Gena title map fallback.
  let title = 'Unknown';
  if (materialId && materialId !== 'unknown') {
    try {
      const cached = await db.query(
        `SELECT title FROM control_sheets
         WHERE platform_material_id = $1 AND cached_at > NOW() - INTERVAL '7 days'`,
        [materialId],
      );
      if (cached.rows[0]?.title && cached.rows[0].title !== 'Unknown') {
        title = cached.rows[0].title;
      }
    } catch { /* non-fatal */ }
  }

  if (title === 'Unknown') {
    try {
      const edikToken = await getDecryptedEdikToken(teacherId);
      const material = await getMaterialBySession(jwt, edikToken || undefined);
      if (material?.title) title = material.title;
    } catch { /* title is optional */ }
  }

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

  const csResult = await db.query(`
    INSERT INTO control_sheets (platform_material_id, title, grade, subject_code, number, topic, cached_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (platform_material_id) DO UPDATE SET
      title        = EXCLUDED.title,
      grade        = EXCLUDED.grade,
      subject_code = EXCLUDED.subject_code,
      number       = EXCLUDED.number,
      topic        = EXCLUDED.topic,
      cached_at    = NOW()
    RETURNING id
  `, [materialId, title, parsed?.grade || 0, parsed?.subjectCode || 'XX', parsed?.number || 0, parsed?.topic || title]);
  const controlSheetId = csResult.rows[0].id;

  // Extract msid from JWT payload
  let msid: string | null = null;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    msid = payload.msid || null;
  } catch {}

  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 10);

  // Reuse existing session for this student+material to ensure re-checks update the same report.
  // Priority: (1) same platform_session_id (msid), (2) same student+control_sheet, (3) insert new.
  let sessionId: string;

  // Try by msid first
  const byMsid = msid
    ? await db.query('SELECT id FROM student_sessions WHERE platform_session_id = $1 LIMIT 1', [msid])
    : { rows: [] };

  if (byMsid.rows[0]) {
    await db.query(
      'UPDATE student_sessions SET raw_state = $1, jwt_token = $2, fetched_at = NOW() WHERE id = $3',
      [JSON.stringify(rawState), jwt, byMsid.rows[0].id]
    );
    sessionId = byMsid.rows[0].id;
  } else {
    // Fallback: reuse the most recent session for same student+material
    const byPair = await db.query(
      `SELECT id FROM student_sessions
       WHERE student_id = $1 AND control_sheet_id = $2
       ORDER BY fetched_at DESC LIMIT 1`,
      [studentId, controlSheetId]
    );
    if (byPair.rows[0]) {
      await db.query(
        'UPDATE student_sessions SET platform_session_id = $1, jwt_token = $2, raw_state = $3, fetched_at = NOW() WHERE id = $4',
        [msid, jwt, JSON.stringify(rawState), byPair.rows[0].id]
      );
      sessionId = byPair.rows[0].id;
    } else {
      const ins = await db.query(`
        INSERT INTO student_sessions (platform_session_id, jwt_token, jwt_expires_at, control_sheet_id, student_id, teacher_id, raw_state, fetched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id
      `, [msid, jwt, expires, controlSheetId, studentId, teacherId, JSON.stringify(rawState)]);
      sessionId = ins.rows[0].id;
    }
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

  // Upsert control_sheet, get id in one round-trip
  const csResult = await db.query(`
    INSERT INTO control_sheets (platform_material_id, title, grade, subject_code, number, topic, cached_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (platform_material_id) DO UPDATE SET
      title        = EXCLUDED.title,
      grade        = EXCLUDED.grade,
      subject_code = EXCLUDED.subject_code,
      number       = EXCLUDED.number,
      topic        = EXCLUDED.topic,
      cached_at    = NOW()
    RETURNING id
  `, [
    platformMaterialId,
    title,
    parsed?.grade || 0,
    parsed?.subjectCode || 'XX',
    parsed?.number || 0,
    parsed?.topic || title,
  ]);
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

  // Reuse existing session for same student+material (re-check updates the same report).
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);

  const byMsid = msid
    ? await db.query('SELECT id FROM student_sessions WHERE platform_session_id = $1 LIMIT 1', [msid])
    : { rows: [] };

  let sessionId: string;
  if (byMsid.rows[0]) {
    await db.query(
      'UPDATE student_sessions SET raw_state = $1, jwt_token = $2, fetched_at = NOW() WHERE id = $3',
      [JSON.stringify(rawState), jwtToken, byMsid.rows[0].id]
    );
    sessionId = byMsid.rows[0].id;
  } else {
    const byPair = await db.query(
      `SELECT id FROM student_sessions
       WHERE student_id = $1 AND control_sheet_id = $2
       ORDER BY fetched_at DESC LIMIT 1`,
      [studentId, controlSheetId]
    );
    if (byPair.rows[0]) {
      await db.query(
        'UPDATE student_sessions SET platform_session_id = $1, jwt_token = $2, raw_state = $3, fetched_at = NOW() WHERE id = $4',
        [msid, jwtToken, JSON.stringify(rawState), byPair.rows[0].id]
      );
      sessionId = byPair.rows[0].id;
    } else {
      const ins = await db.query(`
        INSERT INTO student_sessions (platform_session_id, jwt_token, jwt_expires_at, control_sheet_id, student_id, teacher_id, raw_state, fetched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id
      `, [msid, jwtToken, expires, controlSheetId, studentId, teacherId, JSON.stringify(rawState)]);
      sessionId = ins.rows[0].id;
    }
  }

  return { sessionId, rawState };
}
