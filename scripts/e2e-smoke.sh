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
# --mcp-no-auth: the daemon defaults to an ADR-0022 shared-secret gate, reading
# a 32-byte token from the platform data dir and rejecting anything without
# `x-leyline-token`. Cloister has no way to send it — workerd has no filesystem,
# so it cannot read that token file, and per ADR-0010 a credential would have to
# arrive as a vault slice rather than a var. In production cloister does not need
# the token at all: it reaches the daemon through notme-proxy, which presents the
# bridge cert (see this script's header).
#
# So in this dev-mode harness the gate is relaxed on the DAEMON side rather than
# a credential being smuggled into a Worker — which is the flag's documented
# purpose ("pre-provisioned containers / CI smokes where no token file is
# mounted"). The daemon logs a warning at startup. Without it every upstream call
# here returns HTTP 401 and all lsp_*/lifecycle discovery silently yields zero
# tools.
"$LEYLINE" daemon \
  --arena   "$WORK/test.arena" \
  --control "$WORK/test.ctrl" \
  --mcp-port "$LLO_PORT" \
  --mcp-no-auth \
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
  # Establish the dev-mode gate posture this script's header claims, rather
  # than inheriting whatever the developer's .env.local happens to hold.
  #
  # resolveLeaseGate (src/routes/lease-gate.ts, ADR-0053) has exactly ONE
  # "off" state: CLOISTER_MODE=dev AND no authority. Every other combination
  # enforces — including "no authority at all", which enforces and then fails
  # closed at resolveCABundle with -32005 "CA bundle unavailable".
  #
  # So clearing INTERLACE_ROOT_PUBKEY alone is NOT enough, and omitting both
  # is worst of all. Without both vars set here, this script dies at the first
  # tools/list on any machine whose .env.local sets a pubkey — which is every
  # machine that has run `task dev:setup`. The gate is behaving correctly;
  # the script was simply not declaring which posture it wanted.
  pnpm exec wrangler dev \
    --port "$CLST_PORT" \
    --local \
    --var "CLOISTER_MODE:dev" \
    --var "INTERLACE_ROOT_PUBKEY:" \
    --var "DEV_CA_MASTER:" \
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

# ── Known failures ────────────────────────────────────────────────────────
#
# Assertions that are EXPECTED to fail today because of a tracked defect, so
# this script can gate CI before every defect it finds is fixed.
#
# Each entry is a substring matched against the assertion label, and each must
# name its bead. The exit logic enforces two rules that keep this list honest:
#
#   1. An unexpected failure (not matching any entry) fails the run. Otherwise
#      the list would mask regressions.
#   2. An entry that PASSES fails the run. Otherwise a fixed defect leaves a
#      stale entry behind and the list only ever grows — which is how an
#      allowlist becomes permanent. Shrinking it is mandatory, not optional.
#
# Delete an entry the moment its bead closes; rule 2 will remind you.
KNOWN_FAILING=(
  "mache_"                 # cloister-af794d — Streamable HTTP session lifecycle
  "tools/list has 0 mache" # cloister-af794d — consequence of the above
)

UNEXPECTED=0
STALE_KNOWN=()

is_known_failing() {
  local label="$1" entry
  for entry in "${KNOWN_FAILING[@]}"; do
    [[ "$label" == *"$entry"* ]] && return 0
  done
  return 1
}

fail() {
  if is_known_failing "$1"; then
    echo "  ⊘ $1  [known: see KNOWN_FAILING]"
  else
    echo "  ✗ $1"
    UNEXPECTED=$((UNEXPECTED+1))
  fi
  FAIL=$((FAIL+1))
}

pass() {
  echo "  ✓ $1"
  PASS=$((PASS+1))
  if is_known_failing "$1"; then
    STALE_KNOWN+=("$1")
  fi
}

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

# Per-family counts, not a bare total. A `>= 25` threshold is satisfied by the
# statically-declared bead_* tools alone, so it passed green on 2026-07-28 while
# EVERY dynamically-discovered tool (lsp_*, mache_*, and the lifecycle trio) was
# absent because both upstreams were failing. A threshold that cannot tell
# "discovered" from "did not discover" reports success for the one condition
# this script exists to catch.
assert_family() {
  local label="$1" pattern="$2" want="$3" got
  got=$(echo " $NAMES " | tr ' ' '\n' | grep -cE "$pattern" || true)
  [[ "$got" -ge "$want" ]] && pass "tools/list has $got $label tool(s)" \
                           || fail "tools/list has $got $label tool(s), want >= $want — upstream discovery likely failed"
}

pass "tools/list returned $COUNT tools total"
assert_family "bead_*"    '^bead_'                     6   # static, DO-backed
assert_family "lsp_*"     '^lsp_'                      5   # discovered from ley-line-open
assert_family "lifecycle" '^(reparse|enrich|status)$'  3   # discovered from ley-line-open
assert_family "mache_*"   '^mache_'                    3   # discovered from mache

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
echo "── tools/call lsp_hover on empty db (error mapping) ──────────"
LSP=$(post_mcp "$CLST_PORT" \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lsp_hover","arguments":{"file":"/tmp/no.rs","line":1,"col":1}}}')
ERR_CODE=$(echo "$LSP" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('error',{}).get('code',''))")
[[ "$ERR_CODE" == "-32000" ]] && pass "lsp_hover → JSON-RPC -32000 (LLO inner error)" \
                              || fail "lsp_hover did not propagate isError (got: $LSP)"

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

KNOWN=$(( FAIL - UNEXPECTED ))
[[ "$KNOWN" -gt 0 ]] && echo "  ($KNOWN known failure(s) tolerated — see KNOWN_FAILING)"

dump_logs() {
  echo
  echo "Last 20 lines of LLO log:";      tail -20 "$WORK/llo.log"   2>/dev/null || true
  echo
  echo "Last 20 lines of mache log:";    tail -20 "$WORK/mache.log" 2>/dev/null || true
  echo
  echo "Last 20 lines of cloister log:"; tail -20 "$WORK/clst.log"  2>/dev/null || true
}

# Rule 2 before rule 1: a fixed defect must not leave a stale entry behind.
if [[ "${#STALE_KNOWN[@]}" -gt 0 ]]; then
  echo
  echo "FAIL: ${#STALE_KNOWN[@]} assertion(s) are listed in KNOWN_FAILING but PASSED:"
  printf '  - %s\n' "${STALE_KNOWN[@]}"
  echo
  echo "The defect is fixed. Remove the matching KNOWN_FAILING entry (and close"
  echo "its bead) so the list keeps shrinking instead of masking future breaks."
  exit 1
fi

if [[ "$UNEXPECTED" -gt 0 ]]; then
  echo
  echo "FAIL: $UNEXPECTED unexpected failure(s) — not covered by KNOWN_FAILING."
  dump_logs
  exit 1
fi

# Known failures still dump logs: green exit, but the evidence stays visible so
# a tolerated defect does not become an invisible one.
[[ "$FAIL" -gt 0 ]] && dump_logs

exit 0
