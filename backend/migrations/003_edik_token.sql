-- Store teacher's Edik resume token separately (different Meteor app)
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS edik_encrypted_token TEXT;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS edik_token_expires_at TIMESTAMPTZ;
