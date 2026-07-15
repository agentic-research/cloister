#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/alpine-minirootfs-3.24.0-aarch64.tar.gz"

./build.sh
if [ ! -x ./probe ]; then echo "SKIP: probe not built (no libkrun)"; exit 0; fi

if [ ! -x ./rootfs/bin/busybox ]; then
  mkdir -p rootfs
  curl -sSL --max-time 90 -o mini.tar.gz "$ALPINE_URL"
  tar -xzf mini.tar.gz -C rootfs
fi

mkdir -p workspace
echo "hello-from-host" > workspace/host-wrote-this.txt
rm -f workspace/guest-wrote-this.txt

export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
OUT=$(SPIKE_ROOTFS="$PWD/rootfs" SPIKE_WORKSPACE="$PWD/workspace" ./probe 2>&1 || true)
echo "$OUT"

echo "$OUT" | grep -q GUEST_UP  || { echo "FAIL: guest did not boot"; exit 1; }
echo "$OUT" | grep -q MOUNT_OK  || { echo "FAIL: virtio-fs did not mount"; exit 1; }
echo "$OUT" | grep -q hello-from-host || { echo "FAIL: guest could not READ host file"; exit 1; }
grep -q guest-wrote-this-ok workspace/guest-wrote-this.txt 2>/dev/null \
  || { echo "FAIL: guest WRITE did not forward to the host path"; exit 1; }
echo "PASS: boot + read-forward + write-forward proven (mediate-below-libkrun holds)"
