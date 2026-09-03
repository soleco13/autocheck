#!/usr/bin/env bash
# AutoCheck PostgreSQL backup — runs pg_dump inside the postgres container.
# Cron: 0 2 * * * /opt/autocheck/scripts/backup.sh >> /var/log/autocheck-backup.log 2>&1
set -euo pipefail
trap 'rc=$?; [ $rc -ne 0 ] && /opt/autocheck/scripts/notify.sh "🔴 backup.sh упал (код $rc, строка $LINENO) — бэкап БД не создан" 2>/dev/null || true' EXIT

COMPOSE_DIR="/opt/autocheck"
BACKUP_DIR="${BACKUP_DIR:-/opt/autocheck/backups}"
DB_NAME="${DB_NAME:-autocheck}"
DB_USER="${DB_USER:-autocheck}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
cd "$COMPOSE_DIR"

STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/autocheck_${STAMP}.sql.gz"

echo "[$(date -Iseconds)] Starting backup -> $FILE"
docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip > "$FILE"
echo "[$(date -Iseconds)] Backup complete: $(du -sh "$FILE" | cut -f1)"

find "$BACKUP_DIR" -name "autocheck_*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
echo "[$(date -Iseconds)] Cleanup done. Backups kept: $(ls "$BACKUP_DIR" | wc -l)"
