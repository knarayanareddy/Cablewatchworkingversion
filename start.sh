#!/bin/bash
set -e

PORT=${PORT:-3000}

DB="work/aisdk-2026-09-07_bornholm_sample.sqlite"
if [ ! -f "$DB" ]; then
  DB="work/baltic_sample.sqlite"
fi

echo "Starting Local AIS Python backend with $DB on port 8765..."
python3 python/local_ais.py serve "$DB" --port 8765 &
PYTHON_PID=$!

echo "Starting Next.js on port $PORT..."
node_modules/.bin/next start --hostname 0.0.0.0 --port $PORT &
NODE_PID=$!

trap "kill -TERM $PYTHON_PID $NODE_PID 2>/dev/null || true" SIGINT SIGTERM

wait -n
