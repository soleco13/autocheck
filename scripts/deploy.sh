#!/usr/bin/env bash
# Redeploy AutoCheck after upstream changes: pull, rebuild, migrate, restart, prune.
# Usage: /opt/autocheck/scripts/deploy.sh
set -euo pipefail
cd /opt/autocheck

echo "[$(date -Iseconds)] Tagging current images as :previous (rollback safety net)"
for svc in autocheck-backend autocheck-frontend; do
  if docker image inspect "${svc}:latest" >/dev/null 2>&1; then
    docker tag "${svc}:latest" "${svc}:previous"
  fi
done

echo "[$(date -Iseconds)] git pull"
git pull --ff-only

echo "[$(date -Iseconds)] docker compose build"
docker compose build

echo "[$(date -Iseconds)] docker compose up -d (migrations run automatically on backend-api start)"
docker compose up -d

echo "[$(date -Iseconds)] pruning dangling images/build cache"
docker image prune -f >/dev/null
docker builder prune -f --filter "until=168h" >/dev/null

echo "[$(date -Iseconds)] deploy done"
docker compose ps
