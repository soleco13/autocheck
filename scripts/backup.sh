#!/usr/bin/env bash
# AutoCheck PostgreSQL backup script
# Add to crontab: 0 2 * * * /path/to/autocheck/scripts/backup.sh >> /var/log/autocheck-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backup/autocheck}"
DB_NAME="${DB_NAME:-autocheck}"
DB_USER="${DB_USER:-postgres}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/autocheck_${STAMP}.sql.gz"

echo "[$(date -Iseconds)] Starting backup → $FILE"
pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip > "$FILE"
echo "[$(date -Iseconds)] Backup complete: $(du -sh "$FILE" | cut -f1)"

# Remove backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "autocheck_*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
echo "[$(date -Iseconds)] Cleanup done. Backups kept: $(ls "$BACKUP_DIR" | wc -l)"

# Optional: copy to S3 (uncomment and configure)
# aws s3 cp "$FILE" "s3://your-bucket/autocheck-backups/$(basename $FILE)"
