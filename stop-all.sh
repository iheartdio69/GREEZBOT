#!/usr/bin/env bash
# stop-all.sh — robust stopper for all background tasks
set -euo pipefail
cd "$(dirname "$0")"

stop_pidfile () {
  local f="$1"
  if [[ -f "$f" ]]; then
    local pid
    pid=$(cat "$f" || true)
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.2
      kill -9 "$pid" 2>/dev/null || true
      echo "Stopped $f (pid $pid)"
    fi
    rm -f "$f"
  fi
}

stop_pidfile ".bot.pid"
stop_pidfile ".refresh.pid"
stop_pidfile ".betd.pid"

# Kill any stray listeners on 8787
if lsof -i :8787 -sTCP:LISTEN -t >/dev/null 2>&1; then
  lsof -i :8787 -sTCP:LISTEN -t | xargs -I{} kill -9 {} || true
fi

# Extra safety: kill background Node processes from this folder (and only this folder)
ROOT="$(pwd)"
pgrep -f "node .*${ROOT}/betd\.js" 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
pgrep -f "node .*${ROOT}/markets-refresher\.js" 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
pgrep -f "node .*${ROOT}/telegram-bet-bot\.js" 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true

echo "All stopped."
