-- Add unique constraint on platform_session_id for upsert support
-- A NULL platform_session_id is allowed (old sessions without msid)
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_sessions_platform_session_id
  ON student_sessions(platform_session_id)
  WHERE platform_session_id IS NOT NULL;
