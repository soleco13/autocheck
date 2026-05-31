-- Store teacher's Edik resume token (obtained from browser localStorage)
-- Separate from edik_encrypted_token (which was for auto-login attempt)
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS edik_resume_encrypted TEXT;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS edik_resume_set_at TIMESTAMPTZ;
