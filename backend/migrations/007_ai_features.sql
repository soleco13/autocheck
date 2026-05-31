-- AI prompts customization per teacher
CREATE TABLE IF NOT EXISTS ai_prompts (
  teacher_id UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  prompt_key VARCHAR(100) NOT NULL,
  prompt_text TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (teacher_id, prompt_key)
);

-- Add teacher_id to ai_call_log for per-teacher tracking
ALTER TABLE ai_call_log ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES teachers(id);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_teacher ON ai_call_log(teacher_id);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_created ON ai_call_log(created_at);
