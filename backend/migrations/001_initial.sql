-- Initial schema migration

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Попытка создать расширение vector (pgvector), если установлено
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available, skipping vector columns';
END $$;

-- Учителя сервиса
CREATE TABLE IF NOT EXISTS teachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  encrypted_login_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ученики (кэш из платформы)
CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_student_id TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  nickname TEXT,
  grade INT,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

-- Связь учитель <-> ученик
CREATE TABLE IF NOT EXISTS teacher_students (
  teacher_id UUID REFERENCES teachers(id) ON DELETE CASCADE,
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, student_id)
);

-- Учебники
CREATE TABLE IF NOT EXISTS textbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grade INT NOT NULL,
  subject_code TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  publisher TEXT,
  year INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_textbooks_grade_subject ON textbooks(grade, subject_code);

-- Разделы учебника
CREATE TABLE IF NOT EXISTS textbook_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  textbook_id UUID REFERENCES textbooks(id) ON DELETE CASCADE,
  parent_section_id UUID REFERENCES textbook_sections(id),
  title TEXT NOT NULL,
  page_from INT,
  page_to INT,
  content TEXT,
  position INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Векторизованные чанки учебника для RAG
CREATE TABLE IF NOT EXISTS textbook_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  textbook_id UUID REFERENCES textbooks(id) ON DELETE CASCADE,
  section_id UUID REFERENCES textbook_sections(id) ON DELETE CASCADE,
  chunk_text TEXT NOT NULL,
  chunk_index INT NOT NULL,
  embedding TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_textbook_chunks_textbook ON textbook_chunks(textbook_id);

-- Контрольные листы (КЛ)
CREATE TABLE IF NOT EXISTS control_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_material_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  grade INT NOT NULL,
  subject_code TEXT NOT NULL,
  number INT,
  topic TEXT,
  textbook_id UUID REFERENCES textbooks(id),
  raw_structure JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Задания внутри КЛ
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_sheet_id UUID REFERENCES control_sheets(id) ON DELETE CASCADE,
  task_index INT NOT NULL,
  task_type TEXT NOT NULL,
  platform_component_id TEXT NOT NULL,
  question_text TEXT,
  options JSONB,
  reference_answer TEXT,
  reference_source TEXT,
  max_score INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_control_sheet ON tasks(control_sheet_id);

-- Сессии ответов учеников
CREATE TABLE IF NOT EXISTS student_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_session_id TEXT,
  jwt_token TEXT NOT NULL,
  jwt_expires_at TIMESTAMPTZ NOT NULL,
  control_sheet_id UUID REFERENCES control_sheets(id),
  student_id UUID REFERENCES students(id),
  teacher_id UUID REFERENCES teachers(id),
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  raw_state JSONB
);

CREATE INDEX IF NOT EXISTS idx_sessions_student ON student_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_teacher ON student_sessions(teacher_id);

-- Ответы ученика и результаты проверки
CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id),
  student_answer TEXT,
  student_answer_structured JSONB,
  score INT,
  status TEXT,
  ai_feedback TEXT,
  ai_teacher_note TEXT,
  textbook_citation TEXT,
  textbook_chunk_id UUID REFERENCES textbook_chunks(id),
  teacher_override_score INT,
  teacher_override_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Итоговые отчёты
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID UNIQUE REFERENCES student_sessions(id) ON DELETE CASCADE,
  total_score INT NOT NULL DEFAULT 0,
  max_score INT NOT NULL DEFAULT 0,
  percentage NUMERIC(5,2),
  grade TEXT,
  ai_summary_for_student TEXT,
  ai_summary_for_teacher TEXT,
  lesson_summary TEXT,
  status TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Лог поиска по учебнику
CREATE TABLE IF NOT EXISTS textbook_search_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_id UUID REFERENCES answers(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  textbook_id UUID,
  matched_chunks JSONB,
  selected_chunk_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Лог вызовов Claude API
CREATE TABLE IF NOT EXISTS ai_call_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_id UUID REFERENCES answers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_tokens INT,
  completion_tokens INT,
  cost_usd NUMERIC(10,6),
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
