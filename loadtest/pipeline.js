/**
 * Pipeline performance deep-dive:
 * Tests DB query patterns from check pipeline without actual AI calls
 */
const { Pool } = require('pg');
const { performance } = require('perf_hooks');

const pool = new Pool({
  connectionString: 'postgresql://postgres:13042004@localhost:5432/autocheck',
  max: 20,
});

const TEACHER_ID = '070b7577-f8d9-405d-9586-83196bfeffb1';
// NOTE: STUDENT_ID must be a real UUID from the students table. Run:
//   SELECT id FROM students LIMIT 1;
// and paste the result here before running bulk INSERT tests.
const STUDENT_ID_FOR_INSERT_TEST = '0b621c0e-0f15-4a5c-b8b6-1e4223cd7e71';

async function time(name, fn, iterations = 100) {
  const latencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    latencies.push(performance.now() - t0);
  }
  const s = latencies.sort((a, b) => a - b);
  const p = (pct) => s[Math.floor(s.length * pct / 100)] || 0;
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`[${name}]`);
  console.log(`  avg=${avg.toFixed(2)}ms  p50=${p(50).toFixed(2)}ms  p75=${p(75).toFixed(2)}ms  p90=${p(90).toFixed(2)}ms  p99=${p(99).toFixed(2)}ms  max=${p(100).toFixed(2)}ms`);
  return { name, avg, p50: p(50), p90: p(90), p99: p(99) };
}

async function concurrentTime(name, fn, concurrency, total) {
  const latencies = [];
  let cursor = 0;
  const start = performance.now();

  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      const t0 = performance.now();
      await fn(i);
      latencies.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = performance.now() - start;
  const s = latencies.sort((a, b) => a - b);
  const p = (pct) => s[Math.floor(s.length * pct / 100)] || 0;
  console.log(`[${name}] concurrency=${concurrency}`);
  console.log(`  total=${total} elapsed=${(elapsed/1000).toFixed(2)}s RPS=${(total/(elapsed/1000)).toFixed(1)}`);
  console.log(`  p50=${p(50).toFixed(1)}ms  p90=${p(90).toFixed(1)}ms  p99=${p(99).toFixed(1)}ms  max=${p(100).toFixed(1)}ms`);
}

async function main() {
  console.log('=== AutoCheck DB Pipeline Benchmark ===');
  console.log(new Date().toISOString() + '\n');

  // ── 1. Bulk dedup query (key operation in enqueueCheckBatch) ──────────
  console.log('--- BULK DEDUP QUERIES ---');
  const matIds = Array.from({length: 50}, (_, i) => `mat_${i}`);
  const studIds = [STUDENT_ID_FOR_INSERT_TEST];

  await time('Batch dedup: reports query (50 materials)', async () => {
    await pool.query(
      `SELECT ss.student_id, cs.platform_material_id
       FROM reports r
       JOIN student_sessions ss ON ss.id = r.session_id
       JOIN control_sheets cs ON cs.id = ss.control_sheet_id
       WHERE ss.teacher_id = ANY($1::uuid[])
         AND ss.student_id = ANY($2::uuid[])
         AND cs.platform_material_id = ANY($3::text[])`,
      [[TEACHER_ID], studIds, matIds]
    );
  });

  await time('Batch dedup: check_jobs query (50 materials)', async () => {
    await pool.query(
      `SELECT student_id, platform_material_id
       FROM check_jobs
       WHERE teacher_id = ANY($1::uuid[])
         AND student_id = ANY($2::uuid[])
         AND platform_material_id = ANY($3::text[])
         AND status IN ('queued', 'processing')`,
      [[TEACHER_ID], studIds, matIds]
    );
  });

  console.log('');

  // ── 2. Answer fetch (in checkAnswer) ──────────────────────────────────
  console.log('--- ANSWER PIPELINE QUERIES ---');
  await time('checkAnswer: SELECT answer + task + session', async () => {
    await pool.query(`
      SELECT a.*, t.task_type, t.question_text, t.reference_answer,
             cs.grade, cs.subject_code, cs.topic, ss.teacher_id
      FROM answers a
      JOIN tasks t ON t.id = a.task_id
      JOIN control_sheets cs ON cs.id = t.control_sheet_id
      JOIN student_sessions ss ON ss.id = a.session_id
      WHERE a.id = (SELECT id FROM answers ORDER BY RANDOM() LIMIT 1)
    `);
  }, 50);

  await time('checkAnswer: UPDATE answer status', async () => {
    await pool.query(
      `UPDATE answers SET status = status
       WHERE id = (SELECT id FROM answers LIMIT 1)`,
    );
  }, 50);

  await time('answers by session_id (FULL SCAN — missing index!)', async () => {
    await pool.query(
      `SELECT id FROM answers WHERE session_id = (SELECT id FROM student_sessions LIMIT 1)`
    );
  }, 50);

  console.log('');

  // ── 3. Report generation queries ──────────────────────────────────────
  console.log('--- REPORT GENERATION QUERIES ---');
  await time('generateReport: SELECT answers for session', async () => {
    await pool.query(`
      SELECT a.score, a.status, a.ai_feedback, a.student_answer,
             t.question_text, t.max_score, t.task_type
      FROM answers a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.session_id = (SELECT id FROM student_sessions LIMIT 1)
    `);
  }, 50);

  await time('generateReport: SELECT session details', async () => {
    await pool.query(`
      SELECT ss.*, cs.title, cs.grade, cs.subject_code, cs.topic,
             s.full_name as student_name, tb.subject_name
      FROM student_sessions ss
      JOIN control_sheets cs ON cs.id = ss.control_sheet_id
      JOIN students s ON s.id = ss.student_id
      LEFT JOIN textbooks tb ON tb.id = cs.textbook_id
      WHERE ss.id = (SELECT id FROM student_sessions LIMIT 1)
    `);
  }, 50);

  console.log('');

  // ── 4. Concurrent check pipeline (simulating N workers) ───────────────
  console.log('--- CONCURRENT PIPELINE SIMULATION ---');
  // Simulate 5 workers each processing 1 job (10 answer checks per job)
  await concurrentTime('5 concurrent jobs × 10 answer queries', async (i) => {
    const client = await pool.connect();
    try {
      // Simulate full checkAnswer DB cycle per answer
      for (let j = 0; j < 10; j++) {
        await client.query(`SELECT a.id, t.task_type FROM answers a JOIN tasks t ON t.id = a.task_id WHERE a.id = (SELECT id FROM answers ORDER BY RANDOM() LIMIT 1)`);
        await client.query(`UPDATE answers SET status = status WHERE id = (SELECT id FROM answers LIMIT 1)`);
      }
    } finally {
      client.release();
    }
  }, 5, 25);

  // ── 5. DB pool saturation test ────────────────────────────────────────
  console.log('\n--- DB CONNECTION POOL SATURATION ---');
  await concurrentTime('25 concurrent DB operations (pool=20)', async (i) => {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_sleep(0.05)'); // 50ms simulated work
    } finally {
      client.release();
    }
  }, 25, 100);

  // ── 6. raw_state read performance (TOAST) ─────────────────────────────
  console.log('\n--- raw_state JSONB READ PERFORMANCE ---');
  await time('SELECT raw_state (TOAST read, avg 226KB)', async () => {
    await pool.query(`SELECT id, length(raw_state::text) FROM student_sessions WHERE raw_state IS NOT NULL LIMIT 1`);
  }, 30);

  await time('SELECT session WITHOUT raw_state', async () => {
    await pool.query(`SELECT id, student_id, teacher_id, fetched_at FROM student_sessions LIMIT 1`);
  }, 30);

  // ── 7. check_jobs bulk insert (enqueueCheckBatch core) ────────────────
  console.log('\n--- BULK INSERT PERFORMANCE ---');
  const batchSizes = [10, 50, 100, 500];
  for (const size of batchSizes) {
    await time(`Bulk INSERT check_jobs (${size} rows) — ROLLBACK`, async () => {
      const vals = [];
      const placeholders = Array.from({length: size}, (_, i) => {
        const b = i * 4;
        vals.push(TEACHER_ID, STUDENT_ID_FOR_INSERT_TEST, `mat_bulk_${i}`, 'prefetch');
        return `($${b+1}, $${b+2}, $${b+3}, 'queued', $${b+4})`;
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO check_jobs (teacher_id, student_id, platform_material_id, status, source) VALUES ${placeholders.join(',')} RETURNING id`,
          vals
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }, 10);
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(console.error);
