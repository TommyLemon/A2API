#!/usr/bin/env bash
# Start (or reuse) admin + chat-demo, then run watchable Playwright UI tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export HEADED="${HEADED:-1}"
export SLOW_MO="${SLOW_MO:-500}"
export ADMIN_DRY_APPROVE=1

wait_http() {
  local url="$1"
  local n="${2:-60}"
  for _ in $(seq 1 "$n"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if curl -sf "http://127.0.0.1:5174/" >/dev/null 2>&1 && curl -sf "http://127.0.0.1:3001/api/health" >/dev/null 2>&1; then
  echo "Reusing admin on :5174 / :3001"
else
  echo "Starting admin (ADMIN_DRY_APPROVE=1)…"
  for port in 3001 5174; do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -n "${pids}" ]] && kill $pids 2>/dev/null || true
  done
  sleep 1
  # Always prefer Apple Silicon binary on arm Macs (avoids Rosetta x64 rollup miss).
  START_ADMIN=(env ADMIN_DRY_APPROVE=1 ADMIN_PORT=3001 npm run dev -w @a2api/admin)
  if command -v arch >/dev/null 2>&1 && [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
    START_ADMIN=(arch -arm64 env ADMIN_DRY_APPROVE=1 ADMIN_PORT=3001 npm run dev -w @a2api/admin)
  fi
  "${START_ADMIN[@]}" >/tmp/a2api-admin-ui-e2e.log 2>&1 &
  wait_http "http://127.0.0.1:5174/" 90 || {
    echo "Admin failed to start. Log:"
    tail -40 /tmp/a2api-admin-ui-e2e.log || true
    exit 1
  }
fi

if curl -sf "http://127.0.0.1:5173/" >/dev/null 2>&1 && curl -sf "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
  echo "Reusing chat-demo on :5173 / :3000"
else
  echo "Starting chat-demo…"
  for port in 3000 5173; do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -n "${pids}" ]] && kill $pids 2>/dev/null || true
  done
  sleep 1
  START_CHAT=(env PORT=3000 npm run dev -w @a2api/chat-demo)
  if command -v arch >/dev/null 2>&1 && [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
    START_CHAT=(arch -arm64 env PORT=3000 npm run dev -w @a2api/chat-demo)
  fi
  "${START_CHAT[@]}" >/tmp/a2api-chat-ui-e2e.log 2>&1 &
  wait_http "http://127.0.0.1:5173/" 90 || {
    echo "chat-demo failed to start. Log:"
    tail -40 /tmp/a2api-chat-ui-e2e.log || true
    exit 1
  }
fi

# Admin must be dry-approve for reliable UI approve without APIJSON ACL writes
if ! curl -sf "http://127.0.0.1:3001/api/health" | grep -q '"ok":true'; then
  echo "Admin health check failed"
  exit 1
fi

echo "Running Playwright (HEADED=$HEADED SLOW_MO=$SLOW_MO) — watch the Chrome windows…"
exec npx playwright test -c e2e/playwright.config.ts "$@"
