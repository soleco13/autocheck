const { Pool } = require('pg');
require('dotenv').config({ path: 'E:/TestAutoCheck/backend/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const r = await pool.query(`
    SELECT t.id, t.email, COUNT(ts.student_id) as students, COUNT(ss.id) as sessions
    FROM teachers t
    LEFT JOIN teacher_students ts ON ts.teacher_id = t.id
    LEFT JOIN student_sessions ss ON ss.teacher_id = t.id
    GROUP BY t.id, t.email
    ORDER BY students DESC
  `);
  console.log('Teachers with student counts:');
  r.rows.forEach(row => console.log(` ${row.email}: students=${row.students} sessions=${row.sessions} id=${row.id}`));
  await pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); });
