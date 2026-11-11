#!/bin/sh
# Build the demo's images as OCI layouts under <out dir>/<image>
# (cloister-2af014): dolt and orders by default, or the ones named. Everything that reaches an image is pinned, so two clean
# builds of the same tree give byte-identical digests:
#   - SOURCE_DATE_EPOCH is a constant: every timestamp melange and apko stamp.
#     It is not taken from git, because committing the lock (which records the
#     resulting digests) would move it, and a shallow clone would see another.
#   - --git-commit unknown: melange would otherwise embed the checkout's HEAD,
#     which changes on every commit. "unknown" is what it writes when it
#     cannot detect one.
#   - Go is pinned to one Wolfi build (melange-orders.yaml); Dolt is the
#     release binary pinned by sha256 (melange-dolt.yaml).
#   - No absolute path reaches an image: melange runs from the repository root
#     with repository-relative config paths (its SBOM records the config's
#     path), with the repository URL stated rather than read from a remote (a
#     fork's would differ), and apko runs from <out dir> with the relative
#     repository ./packages (it records the repository in /etc/apk).
#   - The APKs are unsigned and apko ignores signatures. The images install
#     only these freshly built local packages (no Wolfi repository), and a
#     signing key generated per machine would otherwise be copied into each
#     image's /etc/apk/keys.
# Usage: build-images.sh <out dir> [dolt] [orders]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
shift
IMAGES=${*:-dolt orders}
export SOURCE_DATE_EPOCH=315532800 # 1980-01-01T00:00:00Z
REL=tools/dolt-grpc-demo/microvm

rm -rf "$OUT"
mkdir -p "$OUT/packages"
cd "$REPO"
melange_build() { # <package> [melange flags]
  name=$1
  shift
  melange build "$REL/melange-$name.yaml" --arch aarch64 \
    --git-commit unknown --git-repo-url https://github.com/agentic-research/cloister \
    --out-dir "$OUT/packages" "$@"
}
for b in $IMAGES; do
  case $b in
    orders) melange_build orders --source-dir tools/dolt-grpc-demo ;;
    dolt) melange_build dolt --empty-workspace ;;
    *) echo "build-images.sh: unknown image $b (dolt, orders)" >&2; exit 2 ;;
  esac
done

cd "$OUT"
for b in $IMAGES; do
  mkdir -p "./$b"
  apko build "$HERE/apko-$b.yaml" "dolt-grpc-demo/$b:local" "./$b/" \
    --arch aarch64 --ignore-signatures --sbom=false --repository-append ./packages
done
