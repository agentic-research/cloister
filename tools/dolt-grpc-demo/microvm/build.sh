#!/bin/sh
# Build the microVM demo from a clean checkout (cloister-991e65):
#   1. both images as OCI layouts (docker buildx, linux/arm64, no attestations)
#   2. pin their digests into the generated cluster.lock.toml
#   3. import each pinned image into the microVM CAS and record its rootfs
# Then: cloister cluster up --env local --dir tools/dolt-grpc-demo/microvm
#
# Run from anywhere; paths are resolved from this script. Needs Docker with
# buildx and an installed runtime (`cloister runtime install`).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEMO=$(cd "$HERE/.." && pwd)
REPO=$(cd "$DEMO/../.." && pwd)
OUT="$HERE/out"
CLOISTER="node $REPO/bin/cloister.mjs"

rm -rf "$OUT"
mkdir -p "$OUT"

build() { # <bundle> <dockerfile> <context>
  docker buildx build --platform linux/arm64 --provenance=false --sbom=false \
    --output "type=oci,dest=$OUT/$1,tar=false" -f "$2" "$3"
}
build dolt "$HERE/dolt.Dockerfile" "$HERE"
build orders "$HERE/orders.Dockerfile" "$DEMO"

node "$HERE/pin-layouts.mjs" "dolt=$OUT/dolt" "orders=$OUT/orders"

for b in dolt orders; do
  $CLOISTER runtime import --bundle "$b" --dir "$HERE" --layout "$OUT/$b"
done
