#!/usr/bin/env bash
# Weekly cleanup of unused Docker artifacts. Named volumes (pgdata, redisdata, covers,
# certbot-etc) are never touched by these commands — only dangling/unused
# images, stopped containers and build cache.
set -euo pipefail
echo "[$(date -Iseconds)] docker system prune"
docker container prune -f
docker image prune -af --filter "until=168h"
docker builder prune -af --filter "until=168h"
echo "[$(date -Iseconds)] disk usage after prune:"
docker system df
