#!/usr/bin/env bash
# Start both Pixel Kiln services. Backend on :8100, frontend on :3100.
set -e
cd "$(dirname "$0")"

trap 'kill 0' EXIT

(cd backend && uv run uvicorn app.main:app --port 8100) &
(cd frontend && npm run dev) &

wait
