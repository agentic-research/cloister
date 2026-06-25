#!/bin/sh
# verify-go.sh — round-trip gate for the schema-bridge Go emitter
# (cloister-76a9ea / ADR-0036 Phase 1 piece D).
#
# Orchestrates the cross-language verify:
#   1. Dump the canonical cluster const (src/generated/cluster.ts,
#      itself derived from cluster.toml via ADR-0025's bidi pipeline)
#      as JSON into a tmpfile.
#   2. Run `go test ./pkg/cluster/...` with CLUSTER_JSON_PATH pointing
#      at that tmpfile. The test there unmarshals the JSON into the
#      schema-bridge-generated Go types and asserts round-trip.
#
# GOWORK=off because ART repos share a parent go.work that doesn't
# list cloister; we want self-contained build behavior from cloister's
# own go.mod.
#
# Run from the cloister repo root, either directly or via
# `task cluster:go:verify`.

set -eu

REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO_ROOT"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Dump the cluster const to JSON via tsx -e. `tsx -e` doesn't forward
# trailing args to process.argv[2] reliably, so we redirect stdout to
# the tmpfile. tsx's own warnings/errors go to stderr (untouched), so
# the captured stdout is clean JSON.
pnpm exec tsx -e '
  import { cluster } from "./src/generated/cluster.ts";
  process.stdout.write(JSON.stringify(cluster));
' > "$TMPDIR/cluster.json"

if [ ! -s "$TMPDIR/cluster.json" ]; then
  echo "FAIL — cluster.json dump is empty; check tsx output above" >&2
  exit 1
fi

CLUSTER_JSON_PATH="$TMPDIR/cluster.json" GOWORK=off go test ./pkg/cluster/...
