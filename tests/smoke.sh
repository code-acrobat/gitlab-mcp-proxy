#!/bin/sh
# smoke.sh - offline request-side policy smoke test (no network, no live GitLab).
#
# Covers the fail-closed request handling that must never reach upstream:
# browser guard, unparseable body, batched tools/call, deny_tools, deny_calls.
# It does NOT exercise the forward path (that needs a live endpoint); the one
# empty-GET check only asserts the proxy did not refuse it (it 502s on token
# lookup for a dummy host, proving it tried to forward rather than deny).
#
# The proxy reads rules from next to the .mjs (import.meta.dirname), so this
# copies the .mjs into a temp dir with a rules file that carries deny entries -
# the shipped rules are empty, and this exercises the real load path.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/gl-smoke-$$
mkdir -p "$TMP"
cleanup() { [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
fail() { echo "FAIL: $*" >&2; echo "--- proxy output ---"; cat "$TMP/out" >&2; exit 1; }
pass() { echo "ok: $*"; }

# temp copy of the proxy beside a rules file carrying deny entries
cp "$DIR/gitlab-mcp-proxy.mjs" "$TMP/gitlab-mcp-proxy.mjs"
cat > "$TMP/gitlab-mcp-proxy.rules.json" <<'EOF'
{
  "schema": "gitlab/gitlab@smoke",
  "deny_tools": ["danger_tool"],
  "deny_calls": [
    { "tool": "merge_request_merge", "if": { "sha": "deadbeef" }, "reason": "smoke deny_calls" }
  ]
}
EOF

B='content-type: application/json'
A='accept: application/json, text/event-stream'
P='http://127.0.0.1:1731/mcp'

# dummy host: token lookup for it fails, so the forward path 502s without a
# network call - keeps the one forward-path assertion offline.
PORT=1731 GITLAB_MCP_URL=https://127.0.0.1:9/mcp \
  nohup node "$TMP/gitlab-mcp-proxy.mjs" >"$TMP/out" 2>&1 &
PROXY_PID=$!
# readiness: browser-guard 403 is answered locally, no forward, no token lookup
i=0; while [ $i -lt 50 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 -X POST "$P" \
    -H "$B" -H "$A" -H 'origin: https://x' -d '{}' 2>/dev/null || echo 000)
  [ "$code" = 403 ] && break
  i=$((i+1)); sleep 0.1
done
[ $i -lt 50 ] || fail "proxy did not start: $(cat "$TMP/out")"

# 1. browser guard
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$P" -H "$B" -H "$A" \
  -H 'origin: https://evil.example' -d '{}')
[ "$code" = 403 ] || fail "browser origin not rejected (got $code)"
pass "browser request rejected 403"

# 2. unparseable non-empty body -> -32000
curl -sS -o "$TMP/o" -X POST "$P" -H "$B" -H "$A" -d 'this is not json'
jq -e '.error.code == -32000' "$TMP/o" >/dev/null || fail "unparseable body not refused"
jq -r '.error.message' "$TMP/o" | grep -q 'unparseable' || fail "unparseable: wrong reason"
pass "unparseable body refused"

# 3. batch hiding a tools/call -> whole batch refused
curl -sS -o "$TMP/o" -X POST "$P" -H "$B" -H "$A" \
  -d '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"danger_tool","arguments":{}}}]'
jq -e '.error.code == -32000' "$TMP/o" >/dev/null || fail "batched tools/call not refused"
jq -r '.error.message' "$TMP/o" | grep -q 'batch' || fail "batch: wrong reason"
pass "batch with tools/call refused"

# 4. deny_tools -> -32000
curl -sS -o "$TMP/o" -X POST "$P" -H "$B" -H "$A" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"danger_tool","arguments":{}}}'
jq -e '.error.code == -32000' "$TMP/o" >/dev/null || fail "deny_tools not enforced"
jq -r '.error.message' "$TMP/o" | grep -q 'danger_tool' || fail "deny_tools: wrong reason"
pass "deny_tools enforced"

# 5. deny_calls if-pair -> -32000
curl -sS -o "$TMP/o" -X POST "$P" -H "$B" -H "$A" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"merge_request_merge","arguments":{"sha":"deadbeef"}}}'
jq -e '.error.code == -32000' "$TMP/o" >/dev/null || fail "deny_calls not enforced"
jq -r '.error.message' "$TMP/o" | grep -q 'smoke deny_calls' || fail "deny_calls: reason not propagated"
pass "deny_calls enforced"

# 6. empty-body GET is NOT refused (forwards; times out on dummy-host https forward)
rm -f "$TMP/get6"
curl -sS -o "$TMP/get6" -w '%{http_code}' --max-time 3 -X GET "$P" -H "$A" 2>/dev/null >"$TMP/code6" || echo 000 >"$TMP/code6"
# a policy refusal is a JSON-RPC -32000; a forward (even a timed-out one) is not
if [ -s "$TMP/get6" ] && jq -e '.error.code == -32000' "$TMP/get6" >/dev/null 2>&1; then
  fail "empty GET was refused: $(cat "$TMP/get6")"
fi
pass "empty GET forwarded (not refused, HTTP $(cat "$TMP/code6"))"

echo "ALL PASSED"
