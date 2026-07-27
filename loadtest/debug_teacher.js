const { Pool } = require('pg');
require('dotenv').config({ path: 'E:/TestAutoCheck/backend/.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tid = '070b7577-f8d9-405d-9586-83196bfeffb1';

async function main() {
  const [ts, ss, t, students] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM teacher_students WHERE teacher_id = $1', [tid]),
    pool.query('SELECT COUNT(*) FROM student_sessions WHERE teacher_id = $1', [tid]),
    pool.query('SELECT id, email, full_name FROM teachers WHERE id = $1', [tid]),
    pool.query(`SELECT s.id, s.full_name, s.platform_student_id
                FROM students s JOIN teacher_students ts ON ts.student_id = s.id
                WHERE ts.teacher_id = $1 LIMIT 5`, [tid]),
  ]);
  console.log('teacher_students count:', ts.rows[0].count);
  console.log('student_sessions count:', ss.rows[0].count);
  console.log('teacher:', t.rows[0]);
  console.log('sample students:', students.rows);

  // Check all teachers
  const allTeachers = await pool.query('SELECT id, email FROM teachers');
  console.log('All teachers:', allTeachers.rows);

  await pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); });
