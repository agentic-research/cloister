#!/usr/bin/env bash
# regen.sh — regenerate Go bindings for cloister's public capnp wire schema.
#
# Source of truth lives at wire/cloister.capnp at the repo root. This script
# invokes `capnp compile -ogo` against that file and drops the generated
# cloister.capnp.go into wire/ next to this script.
#
# CI invariant (.github/workflows/cloister-schema-go.yml):
#   regen → `git diff --exit-code clients/go/cloister-schema/`
#
# So: re-run this whenever wire/cloister.capnp changes, then commit the diff.
#
# Tooling required (versions known to work):
#   - capnp (Cap'n Proto) >= 1.3.0
#   - capnpc-go from capnproto.org/go/capnp/v3@v3.1.0-alpha.2
#       go install capnproto.org/go/capnp/v3/capnpc-go@v3.1.0-alpha.2
#   - capnpc-go must be on $PATH (capnp shells out to it for `-ogo`).

set -euo pipefail

# Resolve repo root from this script's location (clients/go/cloister-schema/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$SCRIPT_DIR"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Make sure capnpc-go is reachable. `capnp compile -ogo` shells out to
# `capnpc-go` on $PATH, so a bare `go install` isn't enough — the GOPATH
# bin dir must be on PATH.
if ! command -v capnpc-go >/dev/null 2>&1; then
    GOBIN="$(go env GOBIN)"
    [ -z "$GOBIN" ] && GOBIN="$(go env GOPATH)/bin"
    export PATH="$GOBIN:$PATH"
fi
if ! command -v capnpc-go >/dev/null 2>&1; then
    echo "regen.sh: capnpc-go not found on PATH." >&2
    echo "Install with: go install capnproto.org/go/capnp/v3/capnpc-go@v3.1.0-alpha.2" >&2
    exit 1
fi
if ! command -v capnp >/dev/null 2>&1; then
    echo "regen.sh: capnp not found on PATH." >&2
    echo "Install with: brew install capnp  (macOS) | apt-get install capnproto  (Debian/Ubuntu)" >&2
    exit 1
fi

# Schema to regen: <absolute schema path>:<package basename>
SCHEMA_PATH="$REPO_ROOT/wire/cloister.capnp"
SCHEMA_DIR="$(dirname "$SCHEMA_PATH")"
SCHEMA_FILE="$(basename "$SCHEMA_PATH")"
PKG="wire"
OUT_DIR="$MODULE_DIR/$PKG"

mkdir -p "$OUT_DIR"

echo "regen: $SCHEMA_PATH -> $OUT_DIR/${SCHEMA_FILE}.go"

# capnp invocation:
#   --src-prefix=<dir>   : strip leading dirs so the output filename is
#                          just `cloister.capnp.go` (not the full
#                          repo-rooted path).
#   -ogo:<out_dir>       : write Go output under <out_dir>; the
#                          $Go.package annotation pins the package name,
#                          $Go.import pins the import path for cross-
#                          schema references.
#
# go.capnp is vendored at wire/go.capnp (sibling of cloister.capnp) and
# imported as `import "go.capnp"` (relative) so no -I path is needed.
(cd "$SCHEMA_DIR" && capnp compile \
    --src-prefix="$SCHEMA_DIR" \
    -ogo:"$OUT_DIR" \
    "$SCHEMA_FILE")

# `go build` from the module root to catch the class of bug where the
# annotation resolved but the generated Go has a missing import or stale
# identifier.
#
# GOWORK=off: this module is intentionally not in any parent `go.work`
# (multi-module monorepo pattern). A workspace file in an ancestor
# directory would otherwise refuse this build.
echo "regen: go build ./..."
(cd "$MODULE_DIR" && GOWORK=off go build ./...)

echo "regen: done."
