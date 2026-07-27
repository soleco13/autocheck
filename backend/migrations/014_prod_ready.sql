-- Production-readiness migration (2026-06-02)

-- ── 1. Covering index for batch job status polling ─────────────────────────────
-- GET /checks/jobs/status sends up to 1000 UUIDs + teacher_id filter.
-- Covering index eliminates heap fetches for (status, error).
CREATE INDEX IF NOT EXISTS idx_check_jobs_id_teacher_covering
  ON check_jobs(id, teacher_id) INCLUDE (status, error);

-- ── 2. Audit log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID        NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  action      TEXT        NOT NULL,  -- check_started | score_override | prompt_changed | bulk_check | login
  entity_type TEXT,                  -- 'job' | 'answer' | 'prompt' | 'session'
  entity_id   TEXT,
  metadata    JSONB       DEFAULT '{}',
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_teacher_time ON audit_log(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);

-- ── 3. applied_migrations tracker ───────────────────────────────────────────────
-- Tracks which migration files have been applied (prevents re-runs on restart).
CREATE TABLE IF NOT EXISTS applied_migrations (
  filename   TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. Cleanup for check_jobs (completed/failed older than 30 days) ────────────
-- Called by the cron job in cleanup.ts; index makes it fast.
CREATE INDEX IF NOT EXISTS idx_check_jobs_updated_status
  ON check_jobs(updated_at, status)
  WHERE status IN ('completed', 'failed');

-- ── 5. ai_call_log — plain index for cleanup queries ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_ai_call_log_created_cleanup
  ON ai_call_log(created_at);

-- ── 6. Platform token expiry index (for auto-refresh queries) ──────────────────
CREATE INDEX IF NOT EXISTS idx_teachers_token_expiry
  ON teachers(token_expires_at)
  WHERE token_expires_at IS NOT NULL;

-- ── 7. student_sessions: composite index for session dedup ────────────────────
CREATE INDEX IF NOT EXISTS idx_sessions_student_sheet
  ON student_sessions(student_id, control_sheet_id, teacher_id);
