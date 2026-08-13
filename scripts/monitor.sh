#!/usr/bin/env bash
# Basic health check — logs unhealthy/stopped containers and a failing public
# health endpoint. Recovery itself is handled by `restart: always` + the autoheal
# container (restarts anything Docker marks unhealthy); this script is for visibility.
# Cron: */5 * * * * /opt/autocheck/scripts/monitor.sh >> /var/log/autocheck-monitor.log 2>&1
set -uo pipefail
cd /opt/autocheck

TS="[$(date -Iseconds)]"

BAD=$(docker compose ps --format '{{.Name}} {{.State}} {{.Health}}' | awk '$2!="running" || ($3!="" && $3!="healthy") {print}')
if [ -n "$BAD" ]; then
  echo "$TS unhealthy containers:"
  echo "$BAD"
else
  echo "$TS all containers healthy"
fi

if ! curl -fsS -m 5 https://homework-shkola.ru/api/health > /dev/null; then
  echo "$TS WARNING: public /api/health check failed"
fi
