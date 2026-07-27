const { Pool } = require('pg');
const http = require('http');
const fs = require('fs');
require('dotenv').config({ path: 'E:/TestAutoCheck/backend/.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TOKEN = fs.readFileSync('E:/TestAutoCheck/token.txt', 'utf8').trim();

function req(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: 3001, path, method: 'GET',
      headers: { 'Authorization': `Bearer ${TOKEN}` } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    r.setTimeout(30000, () => { r.destroy(); reject(new Error('TIMEOUT')); });
    r.end();
  });
}

async function main() {
  const matIds = ['gFavuJaSqMPryMfdm', 'Nw5qBqXN6QXraZF2R', 'zb4Cuou658fbfYEn5'];

  // 1. Check sessions in DB
  const r = await pool.query(
    `SELECT cs.platform_material_id, COUNT(ss.id) as sessions
     FROM student_sessions ss
     JOIN control_sheets cs ON cs.id = ss.control_sheet_id
     WHERE cs.platform_material_id = ANY($1)
     GROUP BY cs.platform_material_id`,
    [matIds]
  );
  console.log('DB sessions for these materials:', r.rows);

  // 2. Total students
  const s = await pool.query(`SELECT COUNT(*) FROM students s
    JOIN teacher_students ts ON ts.student_id = s.id
    WHERE ts.teacher_id = '070b7577-f8d9-405d-9586-83196bfeffb1'`);
  console.log('Total students:', s.rows[0].count);

  // 3. Test endpoint (force refresh)
  console.log('\nTesting endpoint with refresh=true...');
  const start = Date.now();
  const resp = await req('/api/materials/gFavuJaSqMPryMfdm/students?refresh=true');
  console.log(`Time: ${Date.now()-start}ms, counts:`, resp.body.counts);
  if (resp.body.platformError) console.log('platformError:', resp.body.platformError);

  // 4. Check if gena DDP is actually working by hitting health
  const health = await req('/api/health');
  console.log('\nHealth:', health.body.checks);

  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); });
