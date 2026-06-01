-- Performance indexes missing from initial migration

-- reports: ORDER BY generated_at DESC is used in every history query
CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at DESC);
-- reports: JOIN on session_id in every report query
CREATE INDEX IF NOT EXISTS idx_reports_session_id ON reports(session_id);
-- reports: teacher filter goes through student_sessions.teacher_id — already indexed,
--          but a direct composite helps the COUNT(*) query
CREATE INDEX IF NOT EXISTS idx_sessions_teacher_student ON student_sessions(teacher_id, student_id);

-- teacher_students: JOIN on teacher_id in GET /students
CREATE INDEX IF NOT EXISTS idx_teacher_students_teacher ON teacher_students(teacher_id);

-- classroom_students: JOIN on classroom_id when looking up classrooms per student
CREATE INDEX IF NOT EXISTS idx_classroom_students_classroom ON classroom_students(classroom_id);

-- student_sessions: used in correlated grade subquery
CREATE INDEX IF NOT EXISTS idx_sessions_student_teacher_fetched
  ON student_sessions(student_id, teacher_id, fetched_at DESC);
