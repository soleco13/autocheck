const { Pool } = require('pg');
require('dotenv').config({ path: 'E:/TestAutoCheck/backend/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const http = require('http');

// Get teacher with most students
pool.query(`
  SELECT t.id, t.email, COUNT(ts.student_id) as cnt
  FROM teachers t JOIN teacher_students ts ON ts.teacher_id = t.id
  GROUP BY t.id, t.email ORDER BY cnt DESC LIMIT 1
`).then(async r => {
  const teacher = r.rows[0];
  if (!teacher) { console.log('No teacher'); await pool.end(); return; }
  console.log('Teacher:', teacher.email, '| students:', teacher.cnt);

  // Find sessions with open_answer tasks that have NO report
  const q = await pool.query(`
    SELECT s.full_name, s.id as student_id, s.platform_student_id,
           cs.topic, cs.platform_material_id,
           ss.id as session_id, ss.jwt_token,
           COUNT(CASE WHEN t.task_type = 'open_answer' THEN 1 END) as open_count,
           COUNT(t.id) as total
    FROM student_sessions ss
    JOIN students s ON s.id = ss.student_id
    JOIN control_sheets cs ON cs.id = ss.control_sheet_id
    JOIN tasks t ON t.control_sheet_id = cs.id
    LEFT JOIN reports r ON r.session_id = ss.id
    WHERE ss.teacher_id = $1
      AND r.id IS NULL
    GROUP BY s.full_name, s.id, s.platform_student_id, cs.topic, cs.platform_material_id, ss.id, ss.jwt_token
    HAVING COUNT(CASE WHEN t.task_type = 'open_answer' THEN 1 END) > 0
    ORDER BY open_count DESC
    LIMIT 5
  `, [teacher.id]);

  console.log('\nSessions with open_answer tasks (no report yet):');
  q.rows.forEach(row => {
    console.log(`  ${row.full_name} | open=${row.open_count}/${row.total} | ${row.topic.slice(0,50)}`);
    console.log(`    student_id=${row.student_id} materialId=${row.platform_material_id}`);
  });

  await pool.end();
}).catch(async e => { console.log('err:', e.message); await pool.end(); });
