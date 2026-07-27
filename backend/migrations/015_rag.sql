-- RAG: полнотекстовый поиск по учебникам (PostgreSQL FTS, без внешних API)
-- Использует отдельные таблицы rag_documents / rag_chunks чтобы не конфликтовать
-- со старыми таблицами textbooks / textbook_chunks из 001_initial.sql

CREATE TABLE IF NOT EXISTS rag_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id      UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  title           TEXT NOT NULL,
  author          TEXT,
  subject_code    TEXT,
  grade           TEXT,
  lang            TEXT NOT NULL DEFAULT 'ru',  -- 'ru' | 'en' | 'mixed'
  file_size_bytes BIGINT DEFAULT 0,
  chunk_count     INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | ready | error
  progress_step   TEXT,   -- 'parsing' | 'chunking' | 'saving' | 'done'
  progress_pct    INT NOT NULL DEFAULT 0,
  error_msg       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_teacher
  ON rag_documents (teacher_id);

CREATE INDEX IF NOT EXISTS idx_rag_documents_subject_grade
  ON rag_documents (teacher_id, subject_code, grade)
  WHERE status = 'ready';

CREATE TABLE IF NOT EXISTS rag_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  -- Хранит оба языка: to_tsvector('russian',...) || to_tsvector('english',...)
  search_vector tsvector,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GIN индекс для быстрого FTS поиска
CREATE INDEX IF NOT EXISTS idx_rag_chunks_fts
  ON rag_chunks USING gin (search_vector);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_document
  ON rag_chunks (document_id);
