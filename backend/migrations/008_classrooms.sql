-- Classrooms (class groups) from platform
CREATE TABLE IF NOT EXISTS classrooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  platform_classroom_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(teacher_id, platform_classroom_id)
);

CREATE INDEX IF NOT EXISTS idx_classrooms_teacher ON classrooms(teacher_id);

-- Many-to-many: classroom ↔ student
CREATE TABLE IF NOT EXISTS classroom_students (
  classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (classroom_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_classroom_students_student ON classroom_students(student_id);
