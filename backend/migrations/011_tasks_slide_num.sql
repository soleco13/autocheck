-- Missing from initial deploy: code (answer-parser.ts, checks.ts, reports.ts)
-- reads/writes tasks.slide_num but no prior migration created it.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS slide_num INT;
