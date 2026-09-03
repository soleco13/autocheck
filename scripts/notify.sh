#!/usr/bin/env bash
# Sends a message to Telegram. Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from
# /opt/autocheck/.env. If those are not set it is a silent no-op, so the box
# works fine before the bot is configured.
#   notify.sh "text"      or      echo "text" | notify.sh
set -uo pipefail

ENV_FILE="/opt/autocheck/.env"
[ -f "$ENV_FILE" ] || exit 0

TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -n "$TOKEN" ] && [ -n "$CHAT" ] || exit 0

MSG="${1:-$(cat)}"
[ -n "${MSG//[[:space:]]/}" ] || exit 0

HOST=$(hostname -s)
TEXT="🖥 ${HOST} · AutoCheck"$'\n'"${MSG:0:3800}"

code=""
for attempt in 1 2 3; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
    --data-urlencode "chat_id=${CHAT}" \
    --data-urlencode "text=${TEXT}" \
    --data-urlencode "disable_web_page_preview=true" \
    "https://api.telegram.org/bot${TOKEN}/sendMessage" 2>/dev/null)
  [ "$code" = "200" ] && exit 0
  sleep $((attempt * 3))
done

echo "[$(date -Iseconds)] [notify] telegram send failed (last http ${code:-none})" >&2
exit 1
