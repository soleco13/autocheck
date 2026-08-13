#!/usr/bin/env bash
# Emergency rollback to the images running before the last deploy.sh run.
# Usage: /opt/autocheck/scripts/rollback.sh
set -euo pipefail
cd /opt/autocheck

for svc in autocheck-backend autocheck-frontend; do
  if ! docker image inspect "${svc}:previous" >/dev/null 2>&1; then
    echo "No :previous tag for ${svc} — nothing to roll back to." >&2
    exit 1
  fi
done

echo "[$(date -Iseconds)] Retagging :previous -> :latest"
docker tag autocheck-backend:previous autocheck-backend:latest
docker tag autocheck-frontend:previous autocheck-frontend:latest

echo "[$(date -Iseconds)] Recreating containers from rolled-back images"
docker compose up -d --force-recreate backend-api backend-worker frontend

echo "[$(date -Iseconds)] Rollback done"
docker compose ps
