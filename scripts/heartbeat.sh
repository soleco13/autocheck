#!/usr/bin/env bash
# Once-a-day "still alive" summary to Telegram, so silence can be trusted as
# "all good" rather than "monitoring is broken".
# Cron: 0 6 * * * /opt/autocheck/scripts/heartbeat.sh >> /var/log/autocheck-monitor.log 2>&1
set -uo pipefail
cd /opt/autocheck
NOW=$(date +%s)

HJSON=$(curl -fsS -m 8 https://homework-shkola.ru/api/health 2>/dev/null)
jq -e . >/dev/null 2>&1 <<<"$HJSON" || HJSON='{}'
STATUS=$(jq -r '.status // "нет ответа"' <<<"$HJSON")
QW=$(jq -r '.checks.queue_waiting // "?"' <<<"$HJSON")
QF=$(jq -r '.checks.queue_failed // "?"' <<<"$HJSON")

DPCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
MAVAIL=$(free -m | awk '/^Mem:/{print $7}')
CONT_TOTAL=$(docker compose ps --format '{{.Name}}' 2>/dev/null | wc -l)
CONT_OK=$(docker compose ps --format '{{.Name}} {{.State}} {{.Health}}' 2>/dev/null \
  | awk '$2=="running" && ($3==""||$3=="healthy")' | wc -l)

JOBS=$(docker compose exec -T postgres sh -c \
  "psql -tAqU \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"select count(*) from check_jobs where created_at > now() - interval '24 hours'\"" \
  2>/dev/null | tr -dc '0-9')

END=$(echo | openssl s_client -servername homework-shkola.ru -connect 127.0.0.1:443 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
TLS_DAYS=$((($(date -d "${END:-now}" +%s 2>/dev/null || echo "$NOW") - NOW) / 86400))

LATEST=$(ls -t /opt/autocheck/backups/autocheck_*.sql.gz 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  BK="$(((NOW - $(stat -c %Y "$LATEST")) / 3600))ч назад, $(du -h "$LATEST" | cut -f1)"
else
  BK="НЕТ"
fi

printf '%s' "☀️ Ежедневная сводка
health: ${STATUS} · очередь: ${QW} ждут / ${QF} упавших
контейнеры: ${CONT_OK}/${CONT_TOTAL} в норме
проверок за сутки: ${JOBS:-?}
диск /: ${DPCT}% · память своб.: ${MAVAIL} МБ
TLS: ${TLS_DAYS} дн. · бэкап БД: ${BK}" | /opt/autocheck/scripts/notify.sh
