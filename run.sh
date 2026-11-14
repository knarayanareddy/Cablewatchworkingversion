#!/usr/bin/env bash
set -e

# CableWatch Single-Command Launcher
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# 1. Locate or build dataset
DB="${1:-work/aisdk-2026-09-07_bornholm.sqlite}"
if [ ! -f "$DB" ]; then
  CSV_GZ="${DB%.sqlite}.csv.gz"
  if [ -f "$CSV_GZ" ]; then
    echo "⚡ First-run initialization: Indexing $DB from $CSV_GZ..."
    python3 python/local_ais.py build-db "$CSV_GZ" --output "$DB"
  elif [ -f "work/aisdk-2026-01-13_fehmarn.sqlite" ]; then
    DB="work/aisdk-2026-01-13_fehmarn.sqlite"
  elif [ -f "work/aisdk-2026-01-13_fehmarn.csv.gz" ]; then
    echo "⚡ First-run initialization: Indexing Fehmarn database from compressed source (takes ~9s)..."
    python3 python/local_ais.py build-db work/aisdk-2026-01-13_fehmarn.csv.gz --output "work/aisdk-2026-01-13_fehmarn.sqlite"
    DB="work/aisdk-2026-01-13_fehmarn.sqlite"
  else
    # Look for any sqlite database in work/
    DB=$(ls -t work/*.sqlite 2>/dev/null | head -n 1)
    if [ -z "$DB" ]; then
      echo "❌ Error: No AIS database found in work/. Run python/preprocess_ais.py and local_ais.py build-db first."
      exit 1
    fi
  fi
fi

echo "⚓ Starting CableWatch AIS Pipeline..."
echo "📂 Database: $DB"

# 2. Cleanup function for graceful exit
cleanup() {
  echo ""
  echo "🛑 Shutting down CableWatch services..."
  if [ -n "$PY_PID" ] && kill -0 "$PY_PID" 2>/dev/null; then
    kill "$PY_PID" 2>/dev/null || true
  fi
  if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "✓ Services stopped cleanly."
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 3. Start Python AIS backend
python3 python/local_ais.py serve "$DB" --port 8765 &
PY_PID=$!

# Wait for Python service to be ready
for i in {1..10}; do
  if curl -s http://127.0.0.1:8765/health | grep -q '"ok":true'; then
    echo "✓ Python AIS Service running on http://127.0.0.1:8765 (PID $PY_PID)"
    break
  fi
  sleep 0.5
done

# 4. Start Next.js frontend
echo "🚀 Starting Next.js Web UI on http://127.0.0.1:3100..."
if [ -d ".next" ]; then
  npx next start --hostname 127.0.0.1 --port 3100 &
  NODE_PID=$!
else
  npx next dev --hostname 127.0.0.1 --port 3100 &
  NODE_PID=$!
fi

echo ""
echo "=========================================================="
echo "🎯 CableWatch is LIVE at: http://127.0.0.1:3100/real"
echo "Press Ctrl-C at any time to cleanly stop both services."
echo "=========================================================="
echo ""

wait $NODE_PID $PY_PID
