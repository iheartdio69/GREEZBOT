#!/usr/bin/env bash
# start-all.sh — self-healing launcher for daemon + refresher + bot
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p logs

# Stop first (idempotent) to avoid dupes
if [[ -x "./stop-all.sh" ]]; then ./stop-all.sh || true; fi

# Kill any listener still on 8787, just in case
if lsof -i :8787 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Killing stale 8787 listeners…"
  lsof -i :8787 -sTCP:LISTEN -t | xargs -I{} kill -9 {} || true
fi

echo "Starting bet daemon (betd.js)…"
nohup node betd.js > logs/betd.log 2>&1 & echo $! > .betd.pid
sleep 0.3

echo "Starting markets refresher (watch)…"
nohup node markets-refresher.js --watch > logs/refresh.log 2>&1 & echo $! > .refresh.pid
sleep 0.2

echo "Starting Telegram bot…"
nohup node telegram-bet-bot.js > logs/bot.log 2>&1 & echo $! > .bot.pid
sleep 0.2

# Health check
echo "Health check /status…"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS http://localhost:8787/status >/dev/null; then
    echo "✅ betd is healthy"
  else
    echo "⚠️ betd not responding yet; check logs/betd.log"
  fi
else
  echo "⚠️ curl not found; skipping health check"
fi

echo "All started."
echo "Logs:"
echo "  • $(pwd)/logs/betd.log"
echo "  • $(pwd)/logs/refresh.log"
echo "  • $(pwd)/logs/bot.log"
