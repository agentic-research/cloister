#!/bin/sh
# The published-image variant of the microVM demo (cloister-727354):
#   1. build orders as an OCI layout, reproducibly, with ../microvm's
#      melange + apko build (cloister-2af014)
#   2. pin orders' layout digest and Dolt's PUBLISHED index digest into
#      cluster.lock.toml (committed: both digests are the same on every
#      checkout)
#   3. import orders from its layout, and pull Dolt from Docker Hub by digest
#      (--symlinks resolve: both images hold links; the CAS volume `runtime
#      install` provisions is case-sensitive, which Dolt's Debian tree needs)
# Then: cloister cluster up --env local --dir tools/dolt-grpc-demo/microvm-published
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEMO=$(cd "$HERE/.." && pwd)
REPO=$(cd "$DEMO/../.." && pwd)
OUT="$HERE/out"
cloister() { node "$REPO/bin/cloister.mjs" "$@"; }

# dolthub/dolt-sql-server:1.86.1, multi-arch index (also in ../k8s/dolt.yaml).
DOLT_DIGEST=sha256:d492a79d22bc4bca51aa054293af95734a93ae005c22c80751148814379c8242

sh "$DEMO/microvm/build-images.sh" "$OUT" orders

node "$DEMO/microvm/pin-layouts.mjs" --dir "$HERE" "orders=$OUT/orders" "dolt=$DOLT_DIGEST"

cloister runtime import --bundle orders --dir "$HERE" --layout "$OUT/orders" --symlinks resolve
cloister runtime import --bundle dolt --dir "$HERE" --symlinks resolve
