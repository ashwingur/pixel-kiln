#!/usr/bin/env bash
# Start both Pixel Kiln services. Backend on :8100, frontend on :3100.
set -e
cd "$(dirname "$0")"

# uv installs to ~/.local/bin, which may not be on PATH in this shell yet.
export PATH="$HOME/.local/bin:$PATH"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found — installing via https://astral.sh/uv ..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

trap 'kill 0' EXIT

# `uv run` syncs the venv from uv.lock automatically before starting.
(cd backend && uv run uvicorn app.main:app --port 8100) &
(cd frontend && npm run dev) &

wait
