#!/usr/bin/env bash
# integration-test.sh — Tier 1 integration matrix for cloister.
#
# Bead: cloister-1b1124 (staging-agent).
#
# Two phases:
#
#   A. Image-in-isolation smokes
#      For each of cloister, notme, mache, rosary, ley-line-open:
#        1. `task image` in its repo (skip remaining steps on build failure)
#        2. `docker load` if a tarball was produced
#        3. Smoke per-image:
#           - notme:           HTTP /health on :8788, expect 200
#           - mache:           `--version` exits 0 with output
#           - rosary:          `--version` exits 0 with output
#           - ley-line-open:   HTTP /mcp tools/list on :18384, expect 200/JSON
#           - cloister:        verified as part of phase B (cluster:up)
#        4. Tear down each container; clean leftover UDS sockets.
#
#   B. Cluster boot via `task cluster:up`
#      1. `task cluster:emit` produces cluster.compose.yaml
#      2. `task cluster:up` (background) brings up the four-bundle topology
#      3. Wait ≤60s for all four services to be Up
#      4. GET :8787/health         → expect 200
#      5. GET :8787/.well-known/interlace/index.json → expect valid JSON
#      6. `task cluster:down` always runs via EXIT trap
#
# Exit codes:
#   0  full success
#   1  any image build failed, any smoke failed, or cluster boot failed
#   2  pre-flight failure (docker not available, missing repo, etc.)
#
# Output: structured per-step "[STEP-XX] STATUS  detail" lines plus a final
#   matrix table. Future CI can parse `^\[STEP-` for status.
#
# Usage:
#   scripts/integration-test.sh            # full A + B
#   SKIP_BUILDS=1 scripts/integration-test.sh
#   SKIP_PHASE_A=1 scripts/integration-test.sh
#   SKIP_PHASE_B=1 scripts/integration-test.sh

set -uo pipefail

# ── Configuration ─────────────────────────────────────────────────────────

CLOISTER_DIR="${CLOISTER_DIR:-${HOME}/remotes/art/cloister}"
NOTME_DIR="${NOTME_DIR:-${HOME}/remotes/art/notme}"
MACHE_DIR="${MACHE_DIR:-${HOME}/remotes/art/mache}"
ROSARY_DIR="${ROSARY_DIR:-${HOME}/remotes/art/rosary}"
LLO_DIR="${LLO_DIR:-${HOME}/remotes/art/ley-line-open}"

# Smoke ports. Use 1xxxx range to avoid colliding with cluster:up (which
# binds the canonical 8787/8788 on the host).
NOTME_SMOKE_PORT="${NOTME_SMOKE_PORT:-18788}"
LLO_SMOKE_PORT="${LLO_SMOKE_PORT:-18384}"

# Cluster wait budget — cold start needs node startup + workerd init.
CLUSTER_WAIT_SECS="${CLUSTER_WAIT_SECS:-60}"

LOG_DIR="${LOG_DIR:-/tmp/cloister-integration}"
mkdir -p "$LOG_DIR"

# ── State ─────────────────────────────────────────────────────────────────

# Per-image rows for the final matrix. Format: "name|status|detail"
declare -a IMAGE_ROWS=()
declare -a CLUSTER_ROWS=()
declare -i TOTAL_FAIL=0

START_TIME=$(date +%s)

# ── Helpers ───────────────────────────────────────────────────────────────

log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
step() { printf '[STEP-%-2s] %-6s  %s\n' "$1" "$2" "$3"; }

fail_total() { TOTAL_FAIL=$((TOTAL_FAIL + 1)); }

human_secs() {
  local s="$1"
  if [ "$s" -lt 60 ]; then printf '%ds' "$s"
  else printf '%dm%02ds' $((s/60)) $((s%60))
  fi
}

# Portable millisecond epoch timestamp. macOS `date` lacks %N; prefer
# gdate (coreutils) if present, then GNU date, then python3 fallback.
epoch_ms() {
  if command -v gdate >/dev/null 2>&1; then
    gdate +%s%3N
  else
    # Probe GNU date by checking the format expands (BSD date emits a
    # literal "N" suffix when %N is unsupported).
    local out
    out=$(date +%s%3N 2>/dev/null)
    case "$out" in
      *N) python3 -c 'import time; print(int(time.time()*1000))' ;;
      *)  printf '%s\n' "$out" ;;
    esac
  fi
}

cleanup_smoke_containers() {
  docker rm -f cloister-smoke-notme cloister-smoke-llo 2>/dev/null || true
}

cleanup_cluster() {
  # Skip if no compose file or if no cloister-* containers remain (the
  # success path already ran `task cluster:down` and the trap would be
  # a no-op otherwise — keep it silent).
  if [ ! -f "$CLOISTER_DIR/cluster.compose.yaml" ]; then return 0; fi
  if ! docker ps -a --format '{{.Names}}' | grep -q '^cloister-' ; then return 0; fi
  log "tearing down cluster (trap)"
  (cd "$CLOISTER_DIR" && task cluster:down >>"$LOG_DIR/cluster-down.log" 2>&1) || true
}

cleanup_all() {
  cleanup_smoke_containers
  cleanup_cluster
  # UDS dirs we may have touched
  rm -rf /tmp/cloister-uds /tmp/cloister-integration-uds 2>/dev/null || true
}

trap cleanup_all EXIT INT TERM

# ── Pre-flight ────────────────────────────────────────────────────────────

log "pre-flight checks"
if ! command -v docker >/dev/null 2>&1; then
  step "00" "FAIL" "docker not on PATH (orbstack not running?)"
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  step "00" "FAIL" "docker daemon unreachable"
  exit 2
fi
if ! command -v task >/dev/null 2>&1; then
  step "00" "FAIL" "task (taskfile.dev) not on PATH"
  exit 2
fi
for d in "$CLOISTER_DIR" "$NOTME_DIR" "$MACHE_DIR" "$ROSARY_DIR" "$LLO_DIR"; do
  if [ ! -d "$d" ]; then
    step "00" "FAIL" "missing sibling repo: $d"
    exit 2
  fi
done
step "00" "OK" "docker, task, all 5 sibling repos present"

# ── Phase A: image-in-isolation smokes ────────────────────────────────────

# build_and_smoke <name> <repo_dir> <tag> <smoke_kind>
#   smoke_kind: notme | mache | rosary | llo | cloister
build_and_smoke() {
  local name="$1" repo="$2" tag="$3" smoke="$4"
  local build_start build_end build_secs
  local build_log="$LOG_DIR/build-${name}.log"

  log "── image: $name ($tag) ─────────────────────────────────────────"

  if [ "${SKIP_BUILDS:-0}" = "1" ]; then
    # Use whatever's already loaded; skip build phase.
    if docker image inspect "$tag" >/dev/null 2>&1; then
      step "A-build" "SKIP" "$name (image present, SKIP_BUILDS=1)"
      build_secs=0
    else
      step "A-build" "FAIL" "$name: SKIP_BUILDS=1 but image $tag absent"
      IMAGE_ROWS+=("$name|MISSING|image not present and SKIP_BUILDS=1")
      fail_total
      return 0
    fi
  else
    build_start=$(date +%s)
    if (cd "$repo" && task image) >"$build_log" 2>&1; then
      build_end=$(date +%s)
      build_secs=$((build_end - build_start))
      step "A-build" "OK" "$name built in $(human_secs $build_secs)"
    else
      build_end=$(date +%s)
      build_secs=$((build_end - build_start))
      step "A-build" "FAIL" "$name BUILD FAILED after $(human_secs $build_secs) — see $build_log"
      IMAGE_ROWS+=("$name|BUILD FAILED|$(human_secs $build_secs); $build_log")
      fail_total
      return 0
    fi
  fi

  # Some image tasks (notme, mache) produce a tar; some (rosary, llo,
  # cloister) build straight into the docker daemon via krust/docker build.
  # If a tarball was emitted as the obvious filename, load it.
  local tarball=""
  case "$name" in
    notme)    tarball="$repo/packages/notme.tar" ;;
    mache)    tarball="$repo/mache.tar" ;;
    cloister) tarball="$repo/cloister.tar" ;;
  esac

  if [ -n "$tarball" ] && [ -f "$tarball" ]; then
    if docker load -i "$tarball" >>"$build_log" 2>&1; then
      step "A-load" "OK" "$name loaded from $(basename "$tarball")"
    else
      step "A-load" "FAIL" "$name docker load failed — see $build_log"
      IMAGE_ROWS+=("$name|LOAD FAILED|$build_log")
      fail_total
      return 0
    fi
  fi

  # apko + docker load can land the image under multiple tags depending
  # on the toolchain. If the canonical tag is missing but a sibling tag
  # exists (e.g. "notme:0.1.0-arm64"), re-tag it.
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    local alt
    alt=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^${tag%:*}:" | head -1 || true)
    if [ -n "$alt" ]; then
      docker tag "$alt" "$tag"
      step "A-tag" "OK" "$name retagged $alt → $tag"
    else
      step "A-tag" "FAIL" "$name no candidate tag found for $tag"
      IMAGE_ROWS+=("$name|TAG MISSING|after build")
      fail_total
      return 0
    fi
  fi

  # ── Smoke ─────────────────────────────────────────────────────────────
  local smoke_log="$LOG_DIR/smoke-${name}.log"
  local smoke_detail=""
  local smoke_ok=1

  case "$smoke" in
    notme)
      docker rm -f cloister-smoke-notme >/dev/null 2>&1 || true
      if docker run -d --name cloister-smoke-notme \
           -p "${NOTME_SMOKE_PORT}:8788" \
           "$tag" >>"$smoke_log" 2>&1; then
        # Wait up to 20s for /health
        local ok=0 i
        for i in $(seq 1 40); do
          if curl -sf -m 1 "http://localhost:${NOTME_SMOKE_PORT}/health" \
               >>"$smoke_log" 2>&1; then ok=1; break; fi
          sleep 0.5
        done
        if [ "$ok" = "1" ]; then
          local body
          body=$(curl -s -m 2 "http://localhost:${NOTME_SMOKE_PORT}/health")
          # /health is plain "ok" (text/plain) by design — see notme
          # worker.ts §"/health liveness probe". Any non-empty 200 body
          # is acceptable.
          if [ -n "$body" ]; then
            smoke_detail="200 OK with body: ${body:0:40}"
          else
            smoke_detail="200 OK with empty body"
            smoke_ok=0
          fi
        else
          smoke_detail="no 200 on /health after 20s"
          docker logs cloister-smoke-notme >>"$smoke_log" 2>&1 || true
          smoke_ok=0
        fi
        docker rm -f cloister-smoke-notme >/dev/null 2>&1 || true
      else
        smoke_detail="docker run failed — see $smoke_log"
        smoke_ok=0
      fi
      ;;

    mache)
      # mache image entrypoint may be just /mache or "mache". --entrypoint
      # bypasses CMD; --version exits cleanly on success.
      local out
      if out=$(docker run --rm --entrypoint /usr/bin/mache "$tag" --version 2>&1) ||
         out=$(docker run --rm --entrypoint mache "$tag" --version 2>&1); then
        smoke_detail="--version: ${out:0:80}"
      else
        # Some images expose mache differently; try the default CMD with --version
        if out=$(docker run --rm "$tag" --version 2>&1); then
          smoke_detail="default CMD --version: ${out:0:80}"
        else
          smoke_detail="--version failed: ${out:0:120}"
          smoke_ok=0
        fi
      fi
      ;;

    rosary)
      # rosary entrypoint is /usr/bin/rsry with default CMD = mcp --ipc-socket ...
      # `docker run --rm <tag> --version` swaps CMD entirely.
      local out
      if out=$(docker run --rm "$tag" --version 2>&1); then
        smoke_detail="--version: ${out:0:80}"
      else
        smoke_detail="--version failed: ${out:0:120}"
        smoke_ok=0
      fi
      ;;

    llo)
      docker rm -f cloister-smoke-llo >/dev/null 2>&1 || true
      # leyline daemon listens on 8384 inside the container; map to host smoke port.
      if docker run -d --rm --name cloister-smoke-llo \
           -p "${LLO_SMOKE_PORT}:8384" \
           "$tag" >>"$smoke_log" 2>&1; then
        local ok=0 i
        for i in $(seq 1 40); do
          if curl -sf -m 1 -X POST "http://localhost:${LLO_SMOKE_PORT}/mcp" \
                -H 'Content-Type: application/json' \
                -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' >>"$smoke_log" 2>&1; then
            ok=1; break
          fi
          sleep 0.5
        done
        if [ "$ok" = "1" ]; then
          local body
          body=$(curl -s -m 3 -X POST "http://localhost:${LLO_SMOKE_PORT}/mcp" \
                  -H 'Content-Type: application/json' \
                  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
          if echo "$body" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
            smoke_detail="tools/list returned valid JSON"
          else
            smoke_detail="tools/list non-JSON: ${body:0:80}"
            smoke_ok=0
          fi
        else
          smoke_detail="no 200 on /mcp after 20s"
          docker logs cloister-smoke-llo >>"$smoke_log" 2>&1 || true
          smoke_ok=0
        fi
        docker rm -f cloister-smoke-llo >/dev/null 2>&1 || true
      else
        smoke_detail="docker run failed — see $smoke_log"
        smoke_ok=0
      fi
      ;;

    cloister)
      # cloister image alone needs the cluster compose context to be useful
      # (DO bindings, env). Verified via phase B; no standalone smoke here.
      smoke_detail="verified via cluster:up (phase B)"
      ;;

    *)
      smoke_detail="unknown smoke kind: $smoke"
      smoke_ok=0
      ;;
  esac

  if [ "$smoke_ok" = "1" ]; then
    step "A-smoke" "OK" "$name: $smoke_detail"
    IMAGE_ROWS+=("$name|OK|built $(human_secs $build_secs), smoked")
  else
    step "A-smoke" "FAIL" "$name: $smoke_detail"
    IMAGE_ROWS+=("$name|SMOKE FAILED|built $(human_secs $build_secs); $smoke_detail")
    fail_total
  fi
}

if [ "${SKIP_PHASE_A:-0}" != "1" ]; then
  log "═══ Phase A: image-in-isolation smokes ═══════════════════════════"
  # Order: build cheap ones first; cloister last (skips smoke).
  build_and_smoke "notme"          "$NOTME_DIR"   "notme:0.1.0"          "notme"
  build_and_smoke "ley-line-open"  "$LLO_DIR"     "ley-line-open:0.2.1"  "llo"
  build_and_smoke "mache"          "$MACHE_DIR"   "mache:0.8.0"          "mache"
  build_and_smoke "rosary"         "$ROSARY_DIR"  "rosary:0.2.0"         "rosary"
  build_and_smoke "cloister"       "$CLOISTER_DIR" "cloister:0.1.0"      "cloister"
else
  log "Phase A skipped (SKIP_PHASE_A=1)"
fi

# ── Phase B: cluster boot ─────────────────────────────────────────────────

if [ "${SKIP_PHASE_B:-0}" != "1" ]; then
  log "═══ Phase B: cluster boot via task cluster:up ═════════════════════"

  # Re-tag cloister:latest → cloister:0.1.0 if necessary (cloister's image
  # task defaults to TAG=latest; cluster.capnp pins :0.1.0).
  if docker image inspect "cloister:0.1.0" >/dev/null 2>&1; then
    :
  elif docker image inspect "cloister:latest" >/dev/null 2>&1; then
    docker tag "cloister:latest" "cloister:0.1.0"
    log "retagged cloister:latest → cloister:0.1.0 for cluster.compose.yaml"
  fi

  # Step B-1: emit
  if (cd "$CLOISTER_DIR" && task cluster:emit) >"$LOG_DIR/cluster-emit.log" 2>&1; then
    step "B-01" "OK" "task cluster:emit produced cluster.compose.yaml"
    CLUSTER_ROWS+=("task cluster:emit|OK|wrote $CLOISTER_DIR/cluster.compose.yaml")
  else
    step "B-01" "FAIL" "task cluster:emit failed — see $LOG_DIR/cluster-emit.log"
    CLUSTER_ROWS+=("task cluster:emit|FAIL|see $LOG_DIR/cluster-emit.log")
    fail_total
  fi

  # Step B-2: up (in background — `task cluster:up` runs compose up in
  # the foreground and only exits on container exit / Ctrl-C).
  local_compose="$CLOISTER_DIR/cluster.compose.yaml"
  if [ ! -f "$local_compose" ]; then
    step "B-02" "FAIL" "no cluster.compose.yaml; skipping rest of phase B"
    CLUSTER_ROWS+=("task cluster:up|FAIL|emit did not produce compose file")
    fail_total
  else
    log "starting cluster (background)"
    # Capture t0 immediately before `task cluster:up` invocation. This
    # is the baseline for the boot-time-to-/health-200 metric reported
    # alongside the 4/4-services-Up timing.
    boot_t0_ms=$(epoch_ms)
    (cd "$CLOISTER_DIR" && task cluster:up) >"$LOG_DIR/cluster-up.log" 2>&1 &
    CLUSTER_PID=$!

    # Wait for all 4 services to be running. Compose names services by their
    # bundle name. container_name in compose is "cloister-<bundle>".
    local_services=(cloister-cloister-router cloister-notme-identity cloister-mache cloister-rosary)
    boot_start=$(date +%s)
    all_up=0
    last_status=""
    for i in $(seq 1 "$CLUSTER_WAIT_SECS"); do
      up_count=0
      for s in "${local_services[@]}"; do
        if docker ps --format '{{.Names}}' | grep -qx "$s"; then
          up_count=$((up_count + 1))
        fi
      done
      last_status="$up_count/4"
      if [ "$up_count" -eq 4 ]; then all_up=1; break; fi
      # Detect compose-side failure early
      if ! kill -0 "$CLUSTER_PID" 2>/dev/null; then
        # `task cluster:up` exited unexpectedly — services may have
        # crashlooped. Capture and move on.
        log "cluster:up process exited early (i=${i}s)"
        break
      fi
      sleep 1
    done
    boot_end=$(date +%s)
    boot_secs=$((boot_end - boot_start))

    if [ "$all_up" = "1" ]; then
      step "B-02" "OK" "task cluster:up — 4/4 services Up in $(human_secs $boot_secs)"
      CLUSTER_ROWS+=("task cluster:up|OK|4/4 services up in $(human_secs $boot_secs)")
    else
      step "B-02" "FAIL" "task cluster:up — only $last_status services Up after $(human_secs $boot_secs)"
      CLUSTER_ROWS+=("task cluster:up|FAIL|$last_status services up after $(human_secs $boot_secs)")
      fail_total
      log "containers state:"
      docker ps --format 'table {{.Names}}\t{{.Status}}' | tee -a "$LOG_DIR/cluster-up.log" || true
    fi

    # Step B-3: /health on cloister-router
    # Poll at 200ms intervals (≤60s budget) so the first-200 timestamp
    # is fine-grained enough to be useful as a boot-time metric. The
    # boot_ms reported below is wall-clock from `task cluster:up` to
    # the first 200 OK on /health.
    if [ "$all_up" = "1" ]; then
      # Give workerd a beat to bind after the container reports Up.
      health_ok=0
      boot_t1_ms=0
      # 300 * 200ms = 60s budget
      for i in $(seq 1 300); do
        if curl -sf -m 2 "http://localhost:8787/health" >"$LOG_DIR/cluster-health.log" 2>&1; then
          boot_t1_ms=$(epoch_ms)
          health_ok=1; break
        fi
        sleep 0.2
      done
      if [ "$health_ok" = "1" ]; then
        boot_ms=$((boot_t1_ms - boot_t0_ms))
        body=$(cat "$LOG_DIR/cluster-health.log")
        if echo "$body" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if d.get('ok', True) is not False else 1)" 2>/dev/null; then
          step "B-03" "OK" "/health returned 200 with JSON (${boot_ms}ms from cluster:up)"
          CLUSTER_ROWS+=("/health|OK|200 with JSON")
        else
          step "B-03" "OK" "/health returned 200 (body: ${body:0:80}; ${boot_ms}ms from cluster:up)"
          CLUSTER_ROWS+=("/health|OK|200 (non-JSON or no 'ok' field)")
        fi
        CLUSTER_ROWS+=("/health 200 first reached|OK|${boot_ms}ms from cluster:up")
      else
        step "B-03" "FAIL" "/health no 200 after 60s"
        CLUSTER_ROWS+=("/health|FAIL|no 200 after 60s; see $LOG_DIR/cluster-health.log")
        CLUSTER_ROWS+=("/health 200 first reached|FAIL|never reached within 60s")
        fail_total
      fi

      # Step B-4: /.well-known/interlace/index.json
      wk_body=$(curl -s -m 3 "http://localhost:8787/.well-known/interlace/index.json" 2>/dev/null || true)
      if echo "$wk_body" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if isinstance(d, dict) else 1)" 2>/dev/null; then
        step "B-04" "OK" "/.well-known/interlace/index.json returned valid JSON"
        CLUSTER_ROWS+=("/.well-known/interlace/index.json|OK|valid JSON")
      else
        step "B-04" "FAIL" "/.well-known/interlace/index.json invalid: ${wk_body:0:120}"
        CLUSTER_ROWS+=("/.well-known/interlace/index.json|FAIL|invalid JSON")
        fail_total
      fi
    else
      step "B-03" "SKIP" "/health (cluster not up)"
      step "B-04" "SKIP" "/.well-known (cluster not up)"
      CLUSTER_ROWS+=("/health 200 first reached|SKIP|cluster did not reach 4/4")
    fi

    # Step B-5: cluster:down (also covered by trap; this catches the
    # success-path teardown so we can record its result in the matrix).
    log "tearing down cluster"
    if (cd "$CLOISTER_DIR" && task cluster:down) >"$LOG_DIR/cluster-down.log" 2>&1; then
      step "B-05" "OK" "task cluster:down clean"
      CLUSTER_ROWS+=("task cluster:down|OK|clean teardown")
    else
      step "B-05" "FAIL" "task cluster:down — see $LOG_DIR/cluster-down.log"
      CLUSTER_ROWS+=("task cluster:down|FAIL|see $LOG_DIR/cluster-down.log")
      fail_total
    fi

    # Wait for the cluster:up background process (it should exit on
    # `compose down`); kill if still alive.
    wait "$CLUSTER_PID" 2>/dev/null || true
  fi
else
  log "Phase B skipped (SKIP_PHASE_B=1)"
fi

# ── Matrix table ──────────────────────────────────────────────────────────

END_TIME=$(date +%s)
TOTAL_SECS=$((END_TIME - START_TIME))

printf '\n══════════════════════════════════════════════════════════════════\n'
printf '  Tier 1 integration matrix — cloister-1b1124\n'
printf '══════════════════════════════════════════════════════════════════\n\n'

if [ "${#IMAGE_ROWS[@]}" -gt 0 ]; then
  printf 'Image-in-isolation:\n'
  for row in "${IMAGE_ROWS[@]}"; do
    IFS='|' read -r name status detail <<<"$row"
    printf '  %-20s %-15s %s\n' "$name" "$status" "$detail"
  done
  printf '\n'
fi

if [ "${#CLUSTER_ROWS[@]}" -gt 0 ]; then
  printf 'Cluster boot:\n'
  for row in "${CLUSTER_ROWS[@]}"; do
    IFS='|' read -r name status detail <<<"$row"
    printf '  %-36s %-6s %s\n' "$name" "$status" "$detail"
  done
  printf '\n'
fi

printf 'Total wall time: %s\n' "$(human_secs $TOTAL_SECS)"
printf 'Logs: %s\n\n' "$LOG_DIR"

if [ "$TOTAL_FAIL" -gt 0 ]; then
  printf 'FAILURES: %d step(s)\n' "$TOTAL_FAIL"
  exit 1
fi

printf 'All checks passed.\n'
exit 0
