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
#   - melange and apko are pinned to the versions the committed pins were built
#     with (MELANGE_VERSION, APKO_VERSION below). melange writes its own
#     version into the SBOM inside each APK, which reaches the image; a
#     different version is refused by name rather than silently re-pinning.
#     Moving to a new version is a deliberate edit here plus new locks.
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
#
# <out dir> is created if missing. The script writes a marker file there and
# deletes only what it creates (<out dir>/packages and <out dir>/<image>), and
# it refuses a non-empty directory that lacks the marker: it is never handed a
# directory to wipe (cloister-2af014 review).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
REL=tools/dolt-grpc-demo/microvm
MELANGE_VERSION=0.48.2
APKO_VERSION=1.2.2
MARKER=.build-images-out
SOURCE_DATE_EPOCH=315532800 # 1980-01-01T00:00:00Z
export SOURCE_DATE_EPOCH

die() { echo "build-images.sh: $*" >&2; exit 2; }

[ $# -ge 1 ] || die "usage: build-images.sh <out dir> [dolt] [orders]"
OUT_ARG=$1
shift
IMAGES=${*:-dolt orders}

# Everything is checked before anything is created or deleted.
for b in $IMAGES; do
  case $b in
    dolt | orders) ;;
    *) die "unknown image $b (dolt, orders)" ;;
  esac
done
tool_version() { # <tool>: its GitVersion, as `<tool> version` prints it
  "$1" version 2>/dev/null | awk '$1 == "GitVersion:" { print $2; exit }'
}
for pin in "melange $MELANGE_VERSION" "apko $APKO_VERSION"; do
  set -- $pin
  have=$(tool_version "$1") || true
  if [ "$have" != "$2" ]; then
    die "$1 ${have:-(not found)} is not $1 $2, which built the committed pins. $1's version reaches the image digests, so a build with another version would not reproduce them. Install $1 $2, or, to move the pins deliberately, change the version in $REL/build-images.sh and commit the locks it produces."
  fi
done
if [ -e "$OUT_ARG" ]; then
  [ -d "$OUT_ARG" ] || die "$OUT_ARG is not a directory"
  if [ ! -e "$OUT_ARG/$MARKER" ] && [ -n "$(ls -A "$OUT_ARG")" ]; then
    die "$OUT_ARG is not empty and was not made by build-images.sh (no $MARKER); refusing to write into it. Give an empty or new directory."
  fi
fi

mkdir -p "$OUT_ARG"
OUT=$(cd "$OUT_ARG" && pwd)
: > "$OUT/$MARKER"
rm -rf "$OUT/packages"
for b in $IMAGES; do rm -rf "${OUT:?}/$b"; done
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
  esac
done

cd "$OUT"
for b in $IMAGES; do
  mkdir -p "./$b"
  apko build "$HERE/apko-$b.yaml" "dolt-grpc-demo/$b:local" "./$b/" \
    --arch aarch64 --ignore-signatures --sbom=false --repository-append ./packages
done
