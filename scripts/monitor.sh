#!/usr/bin/env bash
# Health monitoring — every 5 min via cron. Detects unhealthy/stopped containers,
# a failing public health endpoint, degraded dependencies (postgres/redis/DDP/
# circuits/platform), a stuck job queue, low disk, low memory, near TLS expiry
# and a stale/missing DB backup.
#
# Recovery itself is handled by `restart: always` + autoheal; this script is for
# VISIBILITY. It keeps a state file so Telegram gets a message only when a check
# CHANGES state (ok -> bad, bad -> ok), plus a reminder every REMIND_SEC while a
# problem is still active. Without a Telegram token configured it just logs.
#
# Cron: */5 * * * * /opt/autocheck/scripts/monitor.sh >> /var/log/autocheck-monitor.log 2>&1
set -uo pipefail
cd /opt/autocheck

STATE_DIR="/var/lib/autocheck-monitor"
STATE_FILE="$STATE_DIR/state"
NOTIFY="/opt/autocheck/scripts/notify.sh"
mkdir -p "$STATE_DIR"

# ---- thresholds ----
DISK_PCT_MAX=85
MEM_AVAIL_MIN_MB=400
TLS_DAYS_MIN=10
BACKUP_MAX_AGE_H=26
QUEUE_WAITING_MAX=25          # backlog size that counts as "stuck" ...
QUEUE_WAITING_STUCK_SEC=900   # ... only if it stays above that this long
AI_BALANCE_MIN_USD=5          # OpenRouter credits below this → alert
REMIND_SEC=21600             # re-notify a still-failing check every 6h

TS="[$(date -Iseconds)]"
NOW=$(date +%s)

exec 9>"$STATE_DIR/lock"
flock -n 9 || { echo "$TS monitor already running, skip"; exit 0; }

declare -A CUR   # key -> human-readable detail for everything currently wrong

# ---------- container health ----------
BAD=$(docker compose ps --format '{{.Name}} {{.State}} {{.Health}}' 2>/dev/null \
  | awk '$2!="running" || ($3!="" && $3!="healthy"){print $1"("$2($3==""?"":"/"$3)")"}' \
  | paste -sd', ' -)
[ -n "$BAD" ] && CUR[containers]="контейнеры не в норме: $BAD"

# ---------- public health endpoint + dependency checks ----------
HJSON=$(curl -fsS -m 8 https://homework-shkola.ru/api/health 2>/dev/null)
if [ -z "$HJSON" ] || ! jq -e . >/dev/null 2>&1 <<<"$HJSON"; then
  CUR[public_health]="публичный /api/health не отвечает — сайт недоступен (nginx/api/сеть)"
else
  get() { jq -r ".$1 // \"?\"" <<<"$HJSON"; }
  [ "$(get 'checks.postgres')"     != "ok" ] && CUR[postgres]="postgres: $(get 'checks.postgres')"
  [ "$(get 'checks.redis')"        != "ok" ] && CUR[redis]="redis: $(get 'checks.redis')"
  [ "$(get 'checks.ddp_gena')"     != "ok" ] && CUR[ddp_gena]="DDP Gena: $(get 'checks.ddp_gena')"
  [ "$(get 'checks.ddp_edik')"     != "ok" ] && CUR[ddp_edik]="DDP Edik: $(get 'checks.ddp_edik')"
  [ "$(get 'checks.gena_circuit')" != "ok" ] && CUR[gena_circuit]="circuit breaker Gena разомкнут"
  [ "$(get 'checks.edik_circuit')" != "ok" ] && CUR[edik_circuit]="circuit breaker Edik разомкнут"
  [ "$(get 'platform_status')"     != "ok" ] && CUR[platform]="platform_status=$(get 'platform_status') — проверь MONTI_RESUME_TOKEN"

  QF=$(jq -r '.checks.queue_failed  // 0' <<<"$HJSON")
  QW=$(jq -r '.checks.queue_waiting // 0' <<<"$HJSON")
  QA=$(jq -r '.checks.queue_active  // 0' <<<"$HJSON")
  { [ "${QF:-0}" -gt 0 ]; } 2>/dev/null && CUR[queue_failed]="в очереди ${QF} упавших задач"

  MARK="$STATE_DIR/queue_wait_since"
  if { [ "${QW:-0}" -gt "$QUEUE_WAITING_MAX" ]; } 2>/dev/null; then
    [ -f "$MARK" ] || echo "$NOW" > "$MARK"
    SINCE=$(cat "$MARK" 2>/dev/null || echo "$NOW")
    if [ $((NOW - SINCE)) -ge "$QUEUE_WAITING_STUCK_SEC" ]; then
      CUR[queue_backlog]="очередь не разгребается: ждут=${QW} active=${QA}, уже $(((NOW-SINCE)/60)) мин"
    fi
  else
    rm -f "$MARK"
  fi
fi

# ---------- OpenRouter balance (AI checks stop with HTTP 402 at $0) ----------
ORKEY=$(grep -m1 '^OPENROUTER_API_KEY=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'\r')
if [ -n "$ORKEY" ]; then
  CJSON=$(curl -fsS -m 10 -H "Authorization: Bearer $ORKEY" https://openrouter.ai/api/v1/credits 2>/dev/null)
  BAL=$(jq -r '(.data.total_credits - .data.total_usage) // empty' <<<"$CJSON" 2>/dev/null)
  if [ -n "$BAL" ] && awk -v b="$BAL" -v m="$AI_BALANCE_MIN_USD" 'BEGIN{exit !(b < m)}'; then
    CUR[ai_balance]="баланс OpenRouter $(printf '%.2f' "$BAL") \$ (< ${AI_BALANCE_MIN_USD} \$) — пополни https://openrouter.ai/settings/credits"
  fi
fi

# ---------- disk ----------
DPCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
{ [ "${DPCT:-0}" -ge "$DISK_PCT_MAX" ]; } 2>/dev/null && CUR[disk]="диск / заполнен на ${DPCT}%"

# ---------- memory (swap is 0 on this box) ----------
MAVAIL=$(free -m | awk '/^Mem:/{print $7}')
{ [ "${MAVAIL:-99999}" -lt "$MEM_AVAIL_MIN_MB" ]; } 2>/dev/null && CUR[memory]="мало памяти: доступно ${MAVAIL} МБ (swap=0)"

# ---------- TLS expiry ----------
END=$(echo | openssl s_client -servername homework-shkola.ru -connect 127.0.0.1:443 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$END" ]; then
  EEPOCH=$(date -d "$END" +%s 2>/dev/null || echo 0)
  if [ "$EEPOCH" -gt 0 ]; then
    DAYS=$(((EEPOCH - NOW) / 86400))
    [ "$DAYS" -lt "$TLS_DAYS_MIN" ] && CUR[tls]="TLS-сертификат истекает через ${DAYS} дн."
  fi
fi

# ---------- DB backup freshness ----------
LATEST=$(ls -t /opt/autocheck/backups/autocheck_*.sql.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  CUR[backup]="не найдено ни одного бэкапа БД"
else
  AGE_H=$(((NOW - $(stat -c %Y "$LATEST")) / 3600))
  SIZE=$(stat -c %s "$LATEST")
  [ "$AGE_H" -gt "$BACKUP_MAX_AGE_H" ] && CUR[backup]="последний бэкап БД старше ${AGE_H} ч"
  [ "$SIZE" -lt 1000 ]                 && CUR[backup]="последний бэкап БД подозрительно мал (${SIZE} Б)"
fi

# ================= diff against previous state =================
declare -A PREV_FIRST PREV_NOTIFIED
if [ -f "$STATE_FILE" ]; then
  while IFS='|' read -r k first notified _; do
    [ -n "$k" ] || continue
    PREV_FIRST[$k]=$first
    PREV_NOTIFIED[$k]=$notified
  done < "$STATE_FILE"
fi

# bash `set -u` errors on ${!arr[@]} / ${#arr[@]} for a declared-but-empty
# associative array; snapshot the key lists with nounset off. Keys are fixed
# identifiers (no spaces), so unquoted word-splitting below is safe.
set +u
CUR_KEYS="${!CUR[@]}"
PREV_KEYS="${!PREV_FIRST[@]}"
CUR_N=${#CUR[@]}
set -u

NEW_STATE=""; FIRING=""; REMIND=""
for k in $CUR_KEYS; do
  d="${CUR[$k]}"
  if [ -z "${PREV_FIRST[$k]:-}" ]; then
    first=$NOW; notified=$NOW
    FIRING+="🔴 ${d}"$'\n'
  else
    first="${PREV_FIRST[$k]}"; notified="${PREV_NOTIFIED[$k]}"
    if [ $((NOW - notified)) -ge "$REMIND_SEC" ]; then
      notified=$NOW
      REMIND+="🔴 (всё ещё) ${d} — с $(date -d @"$first" '+%H:%M %d.%m')"$'\n'
    fi
  fi
  NEW_STATE+="${k}|${first}|${notified}|${d}"$'\n'
done

RECOVER=""
for k in $PREV_KEYS; do
  [ -z "${CUR[$k]:-}" ] && RECOVER+="🟢 восстановлено: ${k}"$'\n'
done

printf '%s' "$NEW_STATE" > "$STATE_FILE"

# ---- log line ----
if [ "$CUR_N" -eq 0 ]; then
  echo "$TS all containers healthy"
else
  echo "$TS PROBLEMS: $CUR_KEYS"
fi

# ---- notify ----
OUT="${FIRING}${RECOVER}${REMIND}"
[ -n "${OUT//[[:space:]]/}" ] && printf '%s' "$OUT" | "$NOTIFY"

exit 0
