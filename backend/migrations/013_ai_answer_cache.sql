-- AI answer check cache — avoids redundant API calls when multiple students
-- give identical answers to the same question.
-- Key: SHA256 of (question_text || '|' || sorted_acceptable_answers || '|' || student_answer)
-- This covers ~40-60% of answers in practice (common correct answers + common mistakes).

CREATE TABLE IF NOT EXISTS ai_check_cache (
  cache_key     TEXT PRIMARY KEY,          -- SHA256 hex
  status        TEXT NOT NULL,             -- correct | partial | incorrect
  score         SMALLINT NOT NULL,
  feedback_student TEXT NOT NULL DEFAULT '',
  feedback_teacher TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count     INT NOT NULL DEFAULT 0,
  last_hit_at   TIMESTAMPTZ
);

-- TTL index: cache entries older than 30 days are stale (curriculum changes)
CREATE INDEX IF NOT EXISTS idx_ai_check_cache_created ON ai_check_cache(created_at);
