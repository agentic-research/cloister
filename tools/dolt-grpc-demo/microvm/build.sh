#!/bin/sh
# Build the microVM demo's images reproducibly (cloister-991e65, cloister-2af014):
#   1. both images as APKs (melange) and OCI layouts (apko), linux/arm64
#   2. pin their digests into cluster.lock.toml (committed: a clean build on
#      another checkout gives the same digests, so the lock does not change)
#   3. import each pinned image into the microVM CAS and record its rootfs row
# Then: cloister cluster up --env local --dir tools/dolt-grpc-demo/microvm
#
# Needs melange and apko, and an installed runtime (`cloister runtime
# install`). On macOS melange runs its build steps in a container (its docker
# runner); on Linux it uses bubblewrap. apko needs no runner.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEMO=$(cd "$HERE/.." && pwd)
REPO=$(cd "$DEMO/../.." && pwd)
OUT="$HERE/out"
cloister() { node "$REPO/bin/cloister.mjs" "$@"; }

sh "$HERE/build-images.sh" "$OUT"
node "$HERE/pin-layouts.mjs" "dolt=$OUT/dolt" "orders=$OUT/orders"

# Wolfi images hold symlinks (apko's /lib/apk -> ../usr/lib/apk). Rootfs
# manifest v2 (LLO v0.30.0, ley-line-open-4f08ea) keeps them as links, which
# is the importer's default.
for b in dolt orders; do
  cloister runtime import --bundle "$b" --dir "$HERE" --layout "$OUT/$b"
done
