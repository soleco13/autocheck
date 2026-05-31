-- Background check jobs: tracks async checking requests so the frontend can poll status.

CREATE TABLE IF NOT EXISTS check_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID REFERENCES teachers(id) ON DELETE CASCADE,
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  platform_material_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | processing | completed | failed
  session_id UUID,
  report_id UUID,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | prefetch
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_check_jobs_teacher ON check_jobs(teacher_id);
CREATE INDEX IF NOT EXISTS idx_check_jobs_status ON check_jobs(status);
-- Used by the prefetch producer to avoid enqueuing the same work twice while pending.
CREATE INDEX IF NOT EXISTS idx_check_jobs_dedupe
  ON check_jobs(student_id, platform_material_id, status);
