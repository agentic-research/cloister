#!/usr/bin/env bash
# e2e-smoke.sh — exercise the full agent-attested LSP gateway chain
#                in dev mode (no notme-proxy, no bridge cert).
#
# Chain:
#   curl ──MCP──▶ cloister :8787 ──HTTP──▶ leyline :8384
#
# In production the path is:
#   curl ──▶ cloister ──UDS via notme-proxy with mTLS bridge cert──▶ leyline
#
# Dev mode skips notme-proxy because (a) it requires a real bridge cert pair
# and (b) workerd's HTTP client doesn't speak UDS without that proxy. The
# behavior under attestation is identical from cloister's perspective — the
# transport just changes; this script verifies the dispatch layer end-to-end.
#
# Exit codes:
#   0  all assertions passed
#   1  any assertion failed; logs left at /tmp/cloister-e2e/*.log

set -euo pipefail

LLO_PORT="${LLO_PORT:-18384}"
CLST_PORT="${CLST_PORT:-18787}"
MACHE_PORT="${MACHE_PORT:-17532}"
WORK="${WORK:-/tmp/cloister-e2e}"
LEYLINE="${LEYLINE:-${HOME}/remotes/art/ley-line-open/rs/target/debug/leyline}"
MACHE="${MACHE:-$(command -v mache 2>/dev/null || echo "${HOME}/.local/bin/mache")}"
CLOISTER_DIR="${CLOISTER_DIR:-${HOME}/remotes/art/cloister}"

# ── Setup ─────────────────────────────────────────────────────────────────

# Kill any stragglers from a previous failed run. Wrangler dev spawns a
# separate workerd subprocess that can outlive its parent, holding the port.
pkill -f "wrangler dev --port $CLST_PORT" 2>/dev/null || true
pkill -f "workerd serve.*$CLST_PORT" 2>/dev/null || true
pkill -f "mache serve --http localhost:$MACHE_PORT" 2>/dev/null || true
sleep 1

rm -rf "$WORK"
mkdir -p "$WORK"

if [[ ! -x "$LEYLINE" ]]; then
  echo "FAIL: leyline binary not found at $LEYLINE" >&2
  echo "  build with: cd ~/remotes/art/ley-line-open && task build" >&2
  exit 1
fi

if [[ ! -x "$MACHE" ]]; then
  echo "FAIL: mache binary not found at $MACHE" >&2
  echo "  install with: cd ~/remotes/art/mache && go install ./cmd" >&2
  exit 1
fi

if [[ ! -d "$CLOISTER_DIR" ]]; then
  echo "FAIL: cloister repo not found at $CLOISTER_DIR" >&2
  exit 1
fi

# ── Start backends ────────────────────────────────────────────────────────

echo "→ starting leyline daemon on :$LLO_PORT"
"$LEYLINE" daemon \
  --arena   "$WORK/test.arena" \
  --control "$WORK/test.ctrl" \
  --mcp-port "$LLO_PORT" \
  --timeout 120s \
  > "$WORK/llo.log" 2>&1 &
LLO_PID=$!

# Tiny synthetic project for mache to ingest. Source files give the graph
# something to find and the test something concrete to assert against.
echo "→ preparing mache test corpus at $WORK/mache-src"
mkdir -p "$WORK/mache-src"
cat > "$WORK/mache-src/main.go" <<'GO'
package main

func main() { greet() }
func greet() { print("hi") }
GO

echo "→ starting mache MCP server on localhost:$MACHE_PORT"
"$MACHE" serve --http "localhost:$MACHE_PORT" "$WORK/mache-src" \
  > "$WORK/mache.log" 2>&1 &
MACHE_PID=$!

echo "→ starting cloister wrangler dev on :$CLST_PORT"
(
  cd "$CLOISTER_DIR"
  # `--var key:value` overrides [vars] from wrangler.toml. Plain env vars are
  # silently ignored by wrangler dev.
  pnpm exec wrangler dev \
    --port "$CLST_PORT" \
    --local \
    --var "LLO_MCP_URL:http://127.0.0.1:$LLO_PORT/mcp" \
    --var "MACHE_MCP_URL:http://127.0.0.1:$MACHE_PORT/mcp" \
    > "$WORK/clst.log" 2>&1
) &
CLST_PID=$!

cleanup() {
  kill "$CLST_PID" "$LLO_PID" "$MACHE_PID" 2>/dev/null || true
  # workerd subprocess can outlive `pnpm exec wrangler dev` if SIGTERM races.
  pkill -f "workerd serve.*$CLST_PORT" 2>/dev/null || true
  pkill -f "wrangler dev --port $CLST_PORT" 2>/dev/null || true
  pkill -f "mache serve --http localhost:$MACHE_PORT" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait up to 30s for all three endpoints. mache uses Streamable HTTP and
# requires an MCP `initialize` to mint a session-id before any other method
# (including `ping`) is accepted; checking that any HTTP response comes back
# is enough as the readiness signal.
echo -n "→ waiting for backends "
for i in $(seq 1 30); do
  if curl -sS --max-time 1 "http://127.0.0.1:$CLST_PORT/health" >/dev/null 2>&1 \
     && curl -sS --max-time 1 -X POST "http://127.0.0.1:$LLO_PORT/mcp" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":0,"method":"ping"}' >/dev/null 2>&1 \
     && curl -sS --max-time 1 -o /dev/null -w '%{http_code}' \
        -X POST "http://127.0.0.1:$MACHE_PORT/mcp" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":0,"method":"ping"}' 2>/dev/null \
        | grep -qE '^[0-9]'; then
    echo " ready ($i s)"
    break
  fi
  echo -n "."
  sleep 1
  if [[ $i -eq 30 ]]; then
    echo
    echo "FAIL: backends did not become ready in 30s" >&2
    tail -30 "$WORK/llo.log" "$WORK/clst.log" "$WORK/mache.log" >&2 || true
    exit 1
  fi
done

# ── Assertions ────────────────────────────────────────────────────────────

PASS=0
FAIL=0
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }

post_mcp() {
  local port="$1" body="$2" timeout="${3:-5}"
  curl -sS --max-time "$timeout" -X POST "http://127.0.0.1:$port/mcp" \
    -H 'Content-Type: application/json' \
    -d "$body"
}

echo
echo "── tools/list aggregates bead_* + lsp_* + lifecycle + mache_* ───────"
LIST=$(post_mcp "$CLST_PORT" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
COUNT=$(echo "$LIST" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['result']['tools']))")
NAMES=$(echo "$LIST" | python3 -c "import json,sys; print(' '.join(t['name'] for t in json.load(sys.stdin)['result']['tools']))")

# 14 prior (bead+lsp+lifecycle) + ~17 mache_* tools through dynamic discovery.
[[ "$COUNT" -ge 25 ]] && pass "tools/list returned $COUNT tools" \
                      || fail "tools/list returned $COUNT (want >= 25)"

for required in bead_create lsp_hover lsp_diagnostics reparse status mache_get_overview mache_find_callers mache_search; do
  if echo " $NAMES " | grep -q " $required "; then
    pass "tools/list includes $required"
  else
    fail "tools/list missing $required"
  fi
done

echo
echo "── tools/call status (success path) ────────────────────────────────"
STATUS=$(post_mcp "$CLST_PORT" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status","arguments":{}}}')
# MCP wraps the inner op response in {result: {content: [{type, text}]}}.
# `text` is itself stringified JSON for our ops; double-parse to read fields.
PHASE=$(echo "$STATUS" | python3 -c "
import json, sys
r = json.load(sys.stdin)
if 'result' not in r:
    print('MISSING'); sys.exit(0)
text = r['result'].get('content', [{}])[0].get('text', '{}')
try:
    inner = json.loads(text)
    print(inner.get('phase', 'MISSING'))
except Exception:
    print('PARSE_ERROR')
")
[[ "$PHASE" == "ready" ]] && pass "status reports phase: ready" \
                          || fail "status phase = '$PHASE' (raw: $STATUS)"

echo
echo "── tools/call lsp_diagnostics on empty db (error mapping) ──────────"
LSP=$(post_mcp "$CLST_PORT" \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lsp_diagnostics","arguments":{"file":"/tmp/no.rs"}}}')
ERR_CODE=$(echo "$LSP" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('error',{}).get('code',''))")
[[ "$ERR_CODE" == "-32000" ]] && pass "lsp_diagnostics → JSON-RPC -32000 (LLO inner error)" \
                              || fail "lsp_diagnostics did not propagate isError (got: $LSP)"

echo
echo "── PostToolUse-shaped reparse on a single file ──────────────────────"
SRC="$WORK/src"
mkdir -p "$SRC"
cat > "$SRC/a.go" <<'GO'
package m

func A() {}
GO

# First reparse (cold) populates _file_index for the source dir.
COLD=$(post_mcp "$CLST_PORT" \
  "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"reparse\",\"arguments\":{\"source\":\"$SRC\"}}}")
COLD_OK=$(echo "$COLD" | python3 -c "
import json, sys
r = json.load(sys.stdin)
text = r.get('result', {}).get('content', [{}])[0].get('text', '{}')
try:
    inner = json.loads(text)
    print('yes' if inner.get('ok') else 'no')
except Exception:
    print('parse_error')
")
[[ "$COLD_OK" == "yes" ]] && pass "cold reparse populated _file_index" \
                          || fail "cold reparse failed (raw: $COLD)"

# Edit, then reparse with single-file source (the hook shape).
sleep 0.1  # mtime bump
cat > "$SRC/a.go" <<'GO'
package m

func A() { /* edited */ }
GO

REPARSE=$(post_mcp "$CLST_PORT" \
  "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"reparse\",\"arguments\":{\"source\":\"$SRC/a.go\"}}}")
PARSED=$(echo "$REPARSE" | python3 -c "
import json, sys
r = json.load(sys.stdin)
if 'result' not in r:
    print('NO_RESULT'); sys.exit(0)
text = r['result'].get('content', [{}])[0].get('text', '{}')
try:
    inner = json.loads(text)
    print(inner.get('parsed', 'MISSING'))
except Exception:
    print('PARSE_ERROR')
")
[[ "$PARSED" == "1" ]] && pass "reparse {source: <file>} auto-rewrites and parses 1 file" \
                       || fail "single-file reparse parsed=$PARSED (raw: $REPARSE)"

echo
echo "── tools/call mache_list_directory through dynamic backend ──────────"
# Drives the full chain ADR-0006 commits to: cloister sees mache_list_directory
# (Derived from upstream tools/list), strips the "mache_" prefix, and forwards
# list_directory with the captured Mcp-Session-Id. mache attempts a server→
# client `roots/list` callback on first contact; cloister doesn't implement
# the back-channel, so mache waits ~5s before falling back to default path.
# Subsequent calls are fast (cache warm). Bump curl timeout to 30s for this
# one-time cost.
MACHE_OUT=$(post_mcp "$CLST_PORT" \
  '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"mache_list_directory","arguments":{"path":"/"}}}' \
  30)
MACHE_OK=$(echo "$MACHE_OUT" | python3 -c "
import json, sys
r = json.load(sys.stdin)
if 'error' in r:
    print('ERROR:' + json.dumps(r['error']))
elif 'result' in r and r['result'].get('content'):
    text = r['result']['content'][0].get('text', '')
    print('OK' if text else 'EMPTY')
else:
    print('NO_RESULT')
")
[[ "$MACHE_OK" == "OK" ]] && pass "mache_list_directory round-trips through cloister with stripPrefix + session-id" \
                          || fail "mache_list_directory failed: $MACHE_OK (raw: $MACHE_OUT)"

echo
echo "── unknown tool returns -32601 ──────────────────────────────────────"
UNK=$(post_mcp "$CLST_PORT" \
  '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"does_not_exist","arguments":{}}}')
UNK_CODE=$(echo "$UNK" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('error',{}).get('code',''))")
[[ "$UNK_CODE" == "-32601" ]] && pass "unknown tool → -32601" \
                              || fail "unknown tool got: $UNK"

# ── Summary ───────────────────────────────────────────────────────────────

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "  $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────────────────────────────"

if [[ "$FAIL" -gt 0 ]]; then
  echo
  echo "Last 20 lines of LLO log:"
  tail -20 "$WORK/llo.log" 2>/dev/null || true
  echo
  echo "Last 20 lines of mache log:"
  tail -20 "$WORK/mache.log" 2>/dev/null || true
  echo
  echo "Last 20 lines of cloister log:"
  tail -20 "$WORK/clst.log" 2>/dev/null || true
  exit 1
fi

exit 0
