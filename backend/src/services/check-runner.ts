import { db } from '../db';
import {
  fetchSessionState,
  fetchSessionStateByJwt,
  fetchSessionStateByMaterialData,
  extractJwtFromEditorInput,
} from './session-fetcher';
import { saveAnswers } from './answer-parser';
import { checkAnswer } from './ai-checker';
import { generateReport } from './report-generator';
import { getCheckQueue, PRIORITY, CheckJobData, isRedisQueueCapable } from '../queue';
import { getDecryptedToken } from './auth';
import { getChildsMaterials } from '../ddp/gena-client';

export interface CheckInput {
  teacherId: string;
  studentId: string;          // local DB id
  editorUrl?: string;         // editor URL, bare JWT, or legacy material id
  platformMaterialId?: string;
  trainerToken?: string;
}

// How many answers to grade with the AI in parallel. Kept modest to respect the
// upstream Anthropic proxy's rate limits while still cutting wall-clock time.
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY || '5', 10);

// Runs `fn` over `items` with at most `limit` promises in flight at once.
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(runners);
}

// Resolves the platform session (fetches state from Edik/Gena) for a check request.
// Mirrors the branching previously inlined in the POST /checks handler.
export async function resolveSession(
  input: CheckInput,
): Promise<{ sessionId: string; rawState: any }> {
  const studentResult = await db.query(
    'SELECT platform_student_id FROM students WHERE id = $1',
    [input.studentId],
  );
  if (!studentResult.rows[0]) throw new Error('Student not found');
  const platformStudentId = studentResult.rows[0].platform_student_id;

  const rawInput = input.editorUrl || input.platformMaterialId || '';

  if (input.trainerToken && input.platformMaterialId) {
    return fetchSessionStateByMaterialData(
      input.teacherId,
      platformStudentId,
      input.platformMaterialId,
      input.trainerToken,
    );
  }

  const jwt = extractJwtFromEditorInput(rawInput);

  let storedJwt: string | null = null;
  if (!jwt && rawInput.split('.').length < 3) {
    const storedSession = await db.query(
      `SELECT ss.jwt_token FROM student_sessions ss
       JOIN control_sheets cs ON cs.id = ss.control_sheet_id
       JOIN students s ON s.id = ss.student_id
       WHERE cs.platform_material_id = $1 AND s.platform_student_id = $2
       ORDER BY ss.fetched_at DESC LIMIT 1`,
      [rawInput, platformStudentId],
    );
    storedJwt = storedSession.rows[0]?.jwt_token || null;
  }

  const effectiveJwt = jwt || storedJwt;
  if (effectiveJwt) {
    return fetchSessionStateByJwt(input.teacherId, platformStudentId, effectiveJwt);
  }

  // No trainerToken and no JWT — e.g. re-checking an already-checked work, whose
  // DB row carries no token. The legacy api.materials-sessions.* methods are gone
  // from the platform (404/500), so recover the trainerToken from getChildsMaterials
  // (the same source the works list uses) and take the reliable path.
  const materialId = input.platformMaterialId || rawInput;
  if (materialId) {
    try {
      const loginToken = await getDecryptedToken(input.teacherId);
      if (loginToken) {
        const materials = await getChildsMaterials(loginToken, platformStudentId);
        const match = (materials || []).find((m: any) => m.materialId === materialId);
        const recoveredToken: string | undefined = match?.interactiveData?.trainerToken;
        if (recoveredToken) {
          return fetchSessionStateByMaterialData(
            input.teacherId,
            platformStudentId,
            materialId,
            recoveredToken,
          );
        }
        console.warn(`[resolveSession] no trainerToken in getChildsMaterials for material ${materialId}`);
      }
    } catch (err: any) {
      console.warn('[resolveSession] trainerToken recovery failed:', err?.message || err);
    }
  }

  return fetchSessionState(input.teacherId, platformStudentId, rawInput);
}

// Full check pipeline: fetch session → parse answers → grade (in parallel) → report.
// Used by both the synchronous route and the background worker.
export async function runCheckPipeline(
  input: CheckInput,
): Promise<{ sessionId: string; reportId: string }> {
  const { sessionId, rawState } = await resolveSession(input);

  await saveAnswers(sessionId, rawState);

  const answersResult = await db.query('SELECT id FROM answers WHERE session_id = $1', [sessionId]);
  await mapWithConcurrency(answersResult.rows, AI_CONCURRENCY, async (answer) => {
    try {
      await checkAnswer(answer.id);
    } catch (err) {
      console.error('[check-runner] Error checking answer', answer.id, err);
    }
  });

  const reportId = await generateReport(sessionId);
  return { sessionId, reportId };
}

export interface EnqueueParams {
  teacherId: string;
  studentId: string;
  editorUrl?: string;
  platformMaterialId?: string;
  trainerToken?: string;
  source?: 'manual' | 'prefetch';
  dedupe?: boolean;   // skip if a report already exists or a job is already pending
}

// Runs the pipeline inline (no queue) and records the outcome on the check_jobs row.
// Used as the fallback when Redis can't back a BullMQ queue (e.g. Redis < 5.0.0).
async function runInline(checkJobId: string, input: CheckInput): Promise<void> {
  try {
    await db.query(`UPDATE check_jobs SET status='processing', updated_at=NOW() WHERE id=$1`, [checkJobId]);
    const { sessionId, reportId } = await runCheckPipeline(input);
    await db.query(
      `UPDATE check_jobs SET status='completed', session_id=$1, report_id=$2, error=NULL, updated_at=NOW() WHERE id=$3`,
      [sessionId, reportId, checkJobId],
    );
  } catch (err: any) {
    await db.query(
      `UPDATE check_jobs SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
      [err?.message?.slice(0, 500) || 'unknown error', checkJobId],
    ).catch(() => { /* best-effort */ });
    throw err;
  }
}

// Creates a check_jobs row, then either pushes a job onto the BullMQ queue (when
// Redis >= 5 is available) or processes it inline. With `dedupe` (bulk/prefetch) it
// skips work already reported or already queued/processing, so re-clicking "check
// all" or a background producer never double-charges the AI.
export async function enqueueCheckJob(
  p: EnqueueParams,
): Promise<{ jobId: string | null; skipped: boolean; status: 'queued' | 'completed' | 'failed' }> {
  if (p.dedupe && p.platformMaterialId) {
    // Both queries now include teacher_id to prevent cross-teacher dedup collisions
    const reported = await db.query(
      `SELECT 1 FROM reports r
       JOIN student_sessions ss ON ss.id = r.session_id
       JOIN control_sheets cs ON cs.id = ss.control_sheet_id
       WHERE ss.student_id = $1 AND cs.platform_material_id = $2
         AND ss.teacher_id = $3 LIMIT 1`,
      [p.studentId, p.platformMaterialId, p.teacherId],
    );
    if (reported.rows[0]) return { jobId: null, skipped: true, status: 'completed' };

    const active = await db.query(
      `SELECT 1 FROM check_jobs
       WHERE student_id = $1 AND platform_material_id = $2
         AND teacher_id = $3 AND status IN ('queued','processing') LIMIT 1`,
      [p.studentId, p.platformMaterialId, p.teacherId],
    );
    if (active.rows[0]) return { jobId: null, skipped: true, status: 'queued' };
  }

  const source = p.source || 'manual';
  const row = await db.query(
    `INSERT INTO check_jobs (teacher_id, student_id, platform_material_id, status, source)
     VALUES ($1, $2, $3, 'queued', $4) RETURNING id`,
    [p.teacherId, p.studentId, p.platformMaterialId || null, source],
  );
  const checkJobId: string = row.rows[0].id;

  const input: CheckInput = {
    teacherId: p.teacherId,
    studentId: p.studentId,
    editorUrl: p.editorUrl,
    platformMaterialId: p.platformMaterialId,
    trainerToken: p.trainerToken,
  };

  if (await isRedisQueueCapable()) {
    try {
      const data: CheckJobData = { checkJobId, ...input, source };
      await getCheckQueue().add('check', data, {
        jobId: checkJobId,
        priority: source === 'prefetch' ? PRIORITY.prefetch : PRIORITY.manual,
      });
      return { jobId: checkJobId, skipped: false, status: 'queued' };
    } catch (err: any) {
      console.warn('[check-runner] queue.add failed, processing inline:', err?.message || err);
      // fall through to inline
    }
  }

  // Inline fallback. Prefetch is best-effort (don't block the bulk caller); manual
  // checks are awaited so the result is ready by the time the client polls.
  if (source === 'prefetch') {
    runInline(checkJobId, input).catch(() => { /* logged in runInline */ });
    return { jobId: checkJobId, skipped: false, status: 'queued' };
  }
  try {
    await runInline(checkJobId, input);
    return { jobId: checkJobId, skipped: false, status: 'completed' };
  } catch {
    return { jobId: checkJobId, skipped: false, status: 'failed' };
  }
}
