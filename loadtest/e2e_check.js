/**
 * E2E full pipeline test:
 *  1. Get student works list via /api/students/:id/works
 *  2. Trigger a check (force re-check of an existing session by deleting old report)
 *  3. Poll /api/checks/jobs/:jobId until done
 *  4. Fetch the report and print results
 */
const http = require('http');
const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config({ path: 'E:/TestAutoCheck/backend/.env' });

const TOKEN = fs.readFileSync('E:/TestAutoCheck/token.txt', 'utf8').trim();
const BASE = 'http://localhost:3001';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3001, path, method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => { r.destroy(); reject(new Error('TIMEOUT')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== AutoCheck E2E Full Pipeline Test ===\n');

  // 1. Pick a student+session to recheck
  // Delete old report so dedup doesn't skip it (for manual check dedup=false anyway)
  const sessionRow = await pool.query(`
    SELECT ss.id as session_id, ss.student_id, s.full_name,
           cs.platform_material_id, cs.title, cs.topic,
           r.id as report_id
    FROM student_sessions ss
    JOIN students s ON s.id = ss.student_id
    JOIN control_sheets cs ON cs.id = ss.control_sheet_id
    JOIN reports r ON r.session_id = ss.id
    WHERE ss.teacher_id = '070b7577-f8d9-405d-9586-83196bfeffb1'
      AND r.ai_summary_for_student IS NULL OR r.ai_summary_for_student = ''
    ORDER BY r.generated_at ASC
    LIMIT 1
  `);

  if (!sessionRow.rows[0]) { console.log('No sessions found'); await pool.end(); return; }
  const s = sessionRow.rows[0];
  console.log(`Target student: ${s.full_name}`);
  console.log(`Topic: ${s.topic}`);
  console.log(`Material ID: ${s.platform_material_id}`);
  console.log(`Session: ${s.session_id}`);

  // 2. Get student works to find trainerToken
  console.log('\n[1] Fetching student works...');
  const worksRes = await req('GET', `/api/students/${s.student_id}/works`);
  if (worksRes.status !== 200) {
    console.error('Failed to get works:', worksRes.status, worksRes.body);
    await pool.end(); return;
  }
  const works = Array.isArray(worksRes.body) ? worksRes.body : [];
  console.log(`  Found ${works.length} works`);
  const work = works.find(w => w.materialId === s.platform_material_id || w.id === s.platform_material_id);
  if (!work) {
    // Fallback: just use the first available work
    const firstWork = works[0];
    if (!firstWork) { console.log('No works available'); await pool.end(); return; }
    console.log(`  Using first work: ${firstWork.materialId || firstWork.id} (${firstWork.title})`);
    s.platform_material_id = firstWork.materialId || firstWork.id;
    s.trainer_token = firstWork.trainerToken;
    s.student_id_for_check = firstWork.studentId || s.student_id;
  } else {
    s.trainer_token = work.trainerToken;
    s.student_id_for_check = s.student_id;
    console.log(`  Matched work: trainerToken=${work.trainerToken ? work.trainerToken.slice(0,20) + '...' : 'none'}`);
  }

  // 3. Delete old report + answers to allow full recheck
  console.log('\n[2] Cleaning old report for fresh recheck...');
  await pool.query('DELETE FROM reports WHERE session_id = $1', [s.session_id]);
  await pool.query('DELETE FROM answers WHERE session_id = $1', [s.session_id]);
  await pool.query('DELETE FROM check_jobs WHERE session_id = $1 OR (student_id = $2 AND platform_material_id = $3)',
    [s.session_id, s.student_id, s.platform_material_id]);
  console.log('  Old report and answers deleted');

  // 4. Trigger check
  console.log('\n[3] Triggering check...');
  const checkBody = {
    studentId: s.student_id_for_check || s.student_id,
    platformMaterialId: s.platform_material_id,
    trainerToken: s.trainer_token,
  };
  console.log(`  POST /api/checks { studentId: ${checkBody.studentId}, materialId: ${checkBody.platformMaterialId} }`);
  const checkRes = await req('POST', '/api/checks', checkBody);
  console.log(`  Response: ${checkRes.status}`, JSON.stringify(checkRes.body));
  if (checkRes.status !== 202) { console.error('Check failed'); await pool.end(); return; }
  const jobId = checkRes.body.jobId;
  console.log(`  jobId: ${jobId}`);

  // 5. Poll job status
  console.log('\n[4] Polling job status...');
  const startTime = Date.now();
  let finalStatus = null;
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const statusRes = await req('GET', `/api/checks/jobs/${jobId}`);
    const j = statusRes.body;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  [${elapsed}s] status=${j.status} reportId=${j.reportId || '-'} error=${j.error || '-'}`);
    if (j.status === 'completed' || j.status === 'failed') {
      finalStatus = j;
      break;
    }
  }

  if (!finalStatus || finalStatus.status !== 'completed') {
    console.error('\nJob did not complete in time or failed:', finalStatus);
    await pool.end(); return;
  }

  // 6. Fetch and print report
  console.log('\n[5] Fetching report...');
  const reportRes = await req('GET', `/api/reports/${finalStatus.reportId}`);
  if (reportRes.status !== 200) {
    console.error('Report fetch failed:', reportRes.status);
    await pool.end(); return;
  }

  const report = reportRes.body;
  console.log('\n' + '='.repeat(60));
  console.log('REPORT RESULT');
  console.log('='.repeat(60));
  console.log(`Student:     ${report.student_name}`);
  console.log(`Topic:       ${report.topic}`);
  console.log(`Grade:       ${report.report_grade} (${parseFloat(report.percentage).toFixed(0)}%)`);
  console.log(`Score:       ${report.total_score}/${report.max_score}`);
  console.log(`Status:      ${report.status}`);
  console.log(`\nAI summary (student):`);
  console.log(report.ai_summary_for_student || '  (empty — AI call failed)');
  console.log(`\nAI summary (teacher):`);
  console.log(report.ai_summary_for_teacher || '  (empty — AI call failed)');

  if (report.answers && report.answers.length > 0) {
    console.log(`\nAnswers (${report.answers.length} total):`);
    report.answers.slice(0, 8).forEach((a, i) => {
      const q = (a.question_text || '').slice(0, 60);
      console.log(`  [${i+1}] ${a.task_type} | ${a.status} | score=${a.score}/${a.task_max_score}`);
      console.log(`       Q: ${q}`);
      if (a.ai_feedback) console.log(`       AI: ${(a.ai_feedback || '').slice(0, 80)}`);
    });
    if (report.answers.length > 8) console.log(`  ... and ${report.answers.length - 8} more`);
  }
  console.log('='.repeat(60));

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); pool.end(); process.exit(1); });
