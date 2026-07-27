-- Critical performance indexes identified by load testing (2026-06-02)
--
-- answers.session_id: every checkAnswer() and generateReport() does a seq scan
-- without this index. At 50K rows this costs ~50ms per call vs ~1ms with index.
CREATE INDEX IF NOT EXISTS idx_answers_session_id ON answers(session_id);

-- answers.task_id: JOIN answers→tasks in every checkAnswer() query
CREATE INDEX IF NOT EXISTS idx_answers_task_id ON answers(task_id);

-- Purge raw_state from sessions that already have a completed report.
-- raw_state averages 226KB and is never read after saveAnswers() processes it.
-- This immediately frees ~23MB of TOAST storage on the current dataset.
UPDATE student_sessions
SET raw_state = NULL
WHERE raw_state IS NOT NULL
  AND id IN (SELECT session_id FROM reports WHERE session_id IS NOT NULL);
