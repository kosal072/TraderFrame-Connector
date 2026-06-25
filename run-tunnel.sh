#!/usr/bin/env bash
# Start the connector + a Cloudflare quick tunnel, and print the public URL.
# Requires: cloudflared (brew install cloudflared) and the .venv set up.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

# 1) start the connector (gunicorn) if not already on the port
if ! lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "Starting connector on :$PORT ..."
  .venv/bin/gunicorn -c gunicorn.conf.py wsgi:app > connector.out.log 2>&1 &
  sleep 3
fi
curl -s "localhost:$PORT/health" >/dev/null && echo "Connector healthy on :$PORT"

# 2) start the tunnel and surface the public URL
echo "Opening Cloudflare tunnel ..."
cloudflared tunnel --url "http://localhost:$PORT" > cloudflared.log 2>&1 &
TUNNEL_PID=$!

# wait for the URL to appear
for _ in $(seq 1 20); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' cloudflared.log | head -1 || true)
  [ -n "${URL:-}" ] && break
  sleep 1
done

echo
echo "==================================================================="
echo "  Public webhook URL for your Routine:"
echo "    ${URL:-<not ready - check cloudflared.log>}/forward"
echo "==================================================================="
echo "  This URL changes each run. Leave this terminal open to stay up."
echo "  Stop with Ctrl-C."
wait "$TUNNEL_PID"
