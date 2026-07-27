/**
 * Full E2E test with shkolastudent16@yandex.ru
 * 1. Login
 * 2. Get student list
 * 3. Get student works
 * 4. Trigger a check on an unchecked work
 * 5. Poll until complete
 * 6. Print report with timing
 */
const http = require('http');
require('dotenv').config({ path: 'E:/TestAutoCheck/backend/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3001, path, method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.setTimeout(90000, () => { r.destroy(); reject(new Error('TIMEOUT')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const TOTAL_START = Date.now();
  console.log('=== AutoCheck E2E Test ===');
  console.log(new Date().toISOString(), '\n');

  // 1. Login
  console.log('[1] Logging in...');
  const loginResp = await req('POST', '/api/auth/login', {
    email: 'shkolastudent16@yandex.ru', password: '123456'
  });
  if (loginResp.status !== 200) {
    console.error('Login failed:', loginResp.status, loginResp.body);
    return;
  }
  const sessionCookie = (loginResp.headers['set-cookie'] || []).join('; ');
  const teacher = loginResp.body.teacher;
  console.log(`   Logged in: ${teacher.email}\n`);
  const auth = { 'Cookie': sessionCookie };

  // 2. Get students (paginated)
  console.log('[2] Getting students...');
  const t2 = Date.now();
  const studentsResp = await req('GET', '/api/students?pageSize=5', null, auth);
  console.log(`   ${studentsResp.body.pagination?.total || 0} students | ${Date.now()-t2}ms`);
  const students = studentsResp.body.students || [];
  if (!students.length) { console.error('No students'); return; }
  const student = students[0];
  console.log(`   Testing with: ${student.full_name}\n`);

  // 3. Get works
  console.log('[3] Fetching works...');
  const t3 = Date.now();
  const worksResp = await req('GET', `/api/students/${student.id}/works`, null, auth);
  const worksData = worksResp.body;
  const works = worksData.works || [];
  console.log(`   ${works.length} total works | ${Date.now()-t3}ms`);
  if (worksData.platformError) console.log(`   Platform error: ${worksData.platformError}`);

  // 4. Find an unchecked work
  const unchecked = works.filter(w => !w.check_status && w.trainer_token);
  console.log(`   ${unchecked.length} unchecked works`);

  if (!unchecked.length) {
    console.log('\n   All works already checked! Testing report fetch instead...');
    const checked = works.filter(w => w.report_id || w.id);
    if (checked.length) {
      const t = Date.now();
      const rr = await req('GET', `/api/reports/${checked[0].id || checked[0].report_id}`, null, auth);
      console.log(`   Report fetch: ${Date.now()-t}ms | grade=${rr.body.report_grade} pct=${parseFloat(rr.body.percentage||0).toFixed(0)}%`);
      console.log(`   AI summary: ${(rr.body.ai_summary_for_student||'(no AI summary)').slice(0,100)}`);
    }
    await pool.end();
    return;
  }

  const work = unchecked[0];
  console.log(`\n[4] Triggering check...`);
  console.log(`   Material: ${work.title || work.platform_material_id}`);

  const t4 = Date.now();
  const checkResp = await req('POST', '/api/checks', {
    studentId: student.id,
    platformMaterialId: work.platform_material_id,
    trainerToken: work.trainer_token,
  }, auth);

  if (checkResp.status !== 202) {
    console.error('   Check enqueue failed:', checkResp.status, checkResp.body);
    await pool.end(); return;
  }
  const jobId = checkResp.body.jobId;
  console.log(`   jobId: ${jobId} | ${Date.now()-t4}ms\n`);

  // 5. Poll until complete
  console.log('[5] Waiting for check to complete...');
  const deadline = Date.now() + 5 * 60_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(2000);
    const statusResp = await req('GET', `/api/checks/jobs/${jobId}`, null, auth);
    const j = statusResp.body;
    if (j.status !== lastStatus) {
      console.log(`   [${Math.round((Date.now()-t4)/1000)}s] ${j.status}${j.reportId ? ' → report:'+j.reportId : ''}${j.error ? ' ERR:'+j.error.slice(0,60) : ''}`);
      lastStatus = j.status;
    }
    if (j.status === 'completed' || j.status === 'failed') {
      const totalTime = Date.now() - t4;
      console.log(`\n   Check completed in ${(totalTime/1000).toFixed(1)}s`);

      if (j.reportId) {
        // 6. Fetch report
        console.log('\n[6] Fetching report...');
        const reportResp = await req('GET', `/api/reports/${j.reportId}`, null, auth);
        const report = reportResp.body;

        console.log('\n' + '═'.repeat(60));
        console.log('REPORT');
        console.log('═'.repeat(60));
        console.log(`Student:  ${report.student_name}`);
        console.log(`Topic:    ${report.topic}`);
        console.log(`Grade:    ${report.report_grade} (${parseFloat(report.percentage||0).toFixed(0)}%)`);
        console.log(`Score:    ${report.total_score}/${report.max_score}`);
        console.log(`Status:   ${report.status}`);
        console.log(`\nAI Summary (student):\n${report.ai_summary_for_student || '(no AI — proxy unavailable)'}`);
        console.log(`\nAI Summary (teacher):\n${report.ai_summary_for_teacher || '(no AI — proxy unavailable)'}`);

        const answers = report.answers || [];
        console.log(`\nAnswers (${answers.length}):`);
        answers.slice(0, 6).forEach((a, i) => {
          const q = (a.question_text || '').slice(0, 55);
          console.log(`  [${i+1}] ${a.task_type.padEnd(12)} | ${(a.status||'?').padEnd(15)} | score=${a.score}/${a.task_max_score}`);
          if (q) console.log(`       Q: ${q}`);
          if (a.ai_feedback) console.log(`       AI: ${(a.ai_feedback||'').slice(0,70)}`);
        });
        if (answers.length > 6) console.log(`  ... and ${answers.length-6} more`);

        // Stats
        const correct = answers.filter(a => a.status === 'correct').length;
        const incorrect = answers.filter(a => a.status === 'incorrect').length;
        const partial = answers.filter(a => a.status === 'partial').length;
        const manual = answers.filter(a => a.status === 'manual_required').length;
        console.log(`\nStats: correct=${correct} incorrect=${incorrect} partial=${partial} manual_required=${manual}`);
      }
      break;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Total E2E time: ${((Date.now()-TOTAL_START)/1000).toFixed(1)}s`);
  await pool.end();
}

main().catch(async e => { console.error('FATAL:', e.message); await pool.end(); });
