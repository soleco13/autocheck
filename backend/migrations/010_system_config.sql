CREATE TABLE IF NOT EXISTS system_config (
  key         VARCHAR(80) PRIMARY KEY,
  value       TEXT        NOT NULL,
  updated_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);
