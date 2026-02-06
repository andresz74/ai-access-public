#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
RUN_PROVIDERS="${RUN_PROVIDERS:-0}"

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required." >&2
  exit 1
fi

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

check_status() {
  local method="$1"
  local path="$2"
  local expected="$3"
  local body="${4:-}"

  local code
  if [[ -n "$body" ]]; then
    code=$(curl -s -o /tmp/ai_access_smoke_body.txt -w "%{http_code}" \
      -X "$method" "${BASE_URL}${path}" \
      -H "Content-Type: application/json" \
      -d "$body")
  else
    code=$(curl -s -o /tmp/ai_access_smoke_body.txt -w "%{http_code}" \
      -X "$method" "${BASE_URL}${path}")
  fi

  if [[ "$code" == "$expected" ]]; then
    pass "$method $path -> $code"
  else
    echo "Response body:" >&2
    cat /tmp/ai_access_smoke_body.txt >&2 || true
    fail "$method $path expected $expected got $code"
  fi
}

echo "Running smoke checks against: ${BASE_URL}"

# Core availability
check_status GET /health 200
check_status GET /debug 200

# Branch/path checks that should be stable locally
check_status POST /api/openai-chat 400 '{"modelMessages":"invalid"}'
check_status POST /api/openai-chat-youtube-transcript 400 '{}'

if [[ "$RUN_PROVIDERS" == "1" ]]; then
  echo "Running provider-backed checks (RUN_PROVIDERS=1)"
  check_status POST /api/openai-chat 200 '{"modelMessages":[{"role":"user","content":"Reply with just: OK"}]}'
  check_status POST /api/deepseek-chat-axios 200 '{"modelMessages":[{"role":"user","content":"Reply with just: OK"}]}'
  check_status POST /api/anthropic-chat 200 '{"modelMessages":[{"role":"user","content":"Reply with just: OK"}]}'
else
  echo "Skipping provider-backed checks (set RUN_PROVIDERS=1 to enable)."
fi

pass "Smoke checks completed"
