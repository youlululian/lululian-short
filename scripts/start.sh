#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
uv sync
npm --prefix frontend ci
npm --prefix frontend run build
exec uv run uvicorn lululian.main:app --app-dir backend --host 127.0.0.1 --port 8000 --workers 1
