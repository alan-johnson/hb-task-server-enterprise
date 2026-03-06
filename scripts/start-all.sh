#!/usr/bin/env bash
# Start the task API server and web server.
# PostgreSQL and Redis must already be running before calling this script.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PG_READY="$(command -v pg_isready 2>/dev/null || echo /opt/homebrew/opt/postgresql@18/bin/pg_isready)"
REDIS_CLI="$(command -v redis-cli 2>/dev/null || echo /opt/homebrew/opt/redis/bin/redis-cli)"

# ── Preflight: verify database services ────────────────────────────────────

echo "Checking PostgreSQL..."
if ! "$PG_READY" -q 2>/dev/null; then
  echo "ERROR: PostgreSQL is not running. Start it first (e.g. scripts/startdb.sh) then retry."
  exit 1
fi
echo "  PostgreSQL is ready."

echo "Checking Redis..."
if ! "$REDIS_CLI" ping 2>/dev/null | grep -q PONG; then
  echo "ERROR: Redis is not running. Start it first (e.g. scripts/startdb.sh) then retry."
  exit 1
fi
echo "  Redis is ready."

# ── Start servers ───────────────────────────────────────────────────────────

cd "$PROJECT_DIR"

echo ""
echo "Starting task API server..."
node src/task-server.js &
API_PID=$!

echo "Starting web server..."
node src/web-server.js &
WEB_PID=$!

echo ""
echo "Both servers running in the background."
echo "  Task API server PID: $API_PID"
echo "  Web server PID:      $WEB_PID"
echo "Run scripts/stop-all.sh to stop them."
