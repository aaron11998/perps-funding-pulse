#!/usr/bin/env bash
# Local smoke per plan §8 (deploy-gate rehearsal, no deploy):
#   1. wrangler dev boots the worker locally
#   2. GET /health                 -> 200
#   3. GET /.well-known/x402.json  -> 200 manifest
#   4. POST /funding unpaid        -> 402 with x402 paymentRequirements
# Exit 0 only if all four hold. Transcript goes to stdout.
set -u
PORT="${SMOKE_PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"
cd "$(dirname "$0")/.."

cleanup() { [ -n "${WRANGLER_PID:-}" ] && kill "$WRANGLER_PID" 2>/dev/null; }
trap cleanup EXIT

echo "== smoke: perps-funding-pulse @ $(date -u +%FT%TZ) =="
npx wrangler dev --port "$PORT" --local >.wrangler/smoke-dev.log 2>&1 &
WRANGLER_PID=$!

# Wait for the dev server (max ~30s)
up=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE/health"; then up=1; break; fi
  sleep 0.5
done
if [ "$up" -ne 1 ]; then
  echo "FAIL: wrangler dev did not come up on $PORT"; tail -20 .wrangler/smoke-dev.log; exit 1
fi
echo "wrangler dev up on $PORT"

fail=0

echo "--- GET /health"
health=$(curl -sS -w "\nHTTP_%{http_code}" "$BASE/health")
echo "$health"
echo "$health" | tail -1 | grep -q "HTTP_200" && echo "PASS /health 200" || { echo "FAIL /health"; fail=1; }

echo "--- GET /.well-known/x402.json"
manifest=$(curl -sS -w "\nHTTP_%{http_code}" "$BASE/.well-known/x402.json")
echo "$manifest"
echo "$manifest" | tail -1 | grep -q "HTTP_200" && echo "PASS manifest 200" || { echo "FAIL manifest"; fail=1; }
echo "$manifest" | grep -q '"x402Version"' && echo "PASS manifest has x402Version" || { echo "FAIL manifest x402Version"; fail=1; }

echo "--- POST /funding (unpaid -> expect 402 challenge)"
funding=$(curl -sS -X POST -H 'Content-Type: application/json' -d '{"markets":["BTC"]}' -w "\nHTTP_%{http_code}" "$BASE/funding")
echo "$funding"
echo "$funding" | tail -1 | grep -q "HTTP_402" && echo "PASS /funding unpaid 402" || { echo "FAIL /funding expected 402"; fail=1; }
echo "$funding" | grep -q 'accepts' && echo "PASS 402 carries accepts/paymentRequirements" || { echo "FAIL 402 missing accepts"; fail=1; }

if [ "$fail" -eq 0 ]; then echo "== SMOKE PASS =="; else echo "== SMOKE FAIL =="; fi
exit $fail
