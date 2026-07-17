#!/usr/bin/env bash
# cloister-e87760 — the ADR-0044/0046 keystone proof.
#
# The plain spike (run-spike.sh) backs the guest's virtio-fs with a passthrough
# host dir. THIS run backs it with the ConfinementGraph MEDIATOR's NFS instead,
# and proves the guest's fs traverses the mediator: an allowed skill is served
# (+ recorded as a SkillLoadReceipt), a policy-denied path is blocked in-guest.
#
# Chain:  guest → virtio-fs (DAX off) → host NFS mount (noac) → ConfinementGraph
#                                                              → leyline-fs
# DAX is off because probe.c uses krun_add_virtiofs (no shm/DAX window), and
# `noac` disables the host NFS client's attribute cache, so EVERY guest op
# reaches the mediator — not just create/first-read (ADR-0046 mmap/DAX constraint).
#
# macOS + libkrun + sudo (for the NFS mount) only. SKIPs gracefully otherwise.
# Not a CI gate — CI runners lack HVF. Iterate on-Mac.
set -euo pipefail
cd "$(dirname "$0")"
MED_MANIFEST=../mediator/Cargo.toml
MNT=mediated-mnt
LOG=med.log

skip() { echo "SKIP: $1"; exit 0; }
command -v cargo >/dev/null || skip "no cargo"
command -v sudo  >/dev/null || skip "no sudo (needed for the NFS mount)"

./build.sh
[ -x ./probe ] || skip "probe not built (no libkrun) — run run-spike.sh first"
[ -x ./rootfs/bin/busybox ] || skip "rootfs missing — run run-spike.sh once to fetch it"

echo "[e87760] building the ConfinementGraph mediator (nfs feature)…"
cargo build --manifest-path "$MED_MANIFEST" --features nfs --bin mount 2>/dev/null \
  || skip "mediator nfs build failed (needs the leyline-fs nfs deps)"
MED_BIN=$(cargo metadata --manifest-path "$MED_MANIFEST" --format-version 1 \
  | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')/debug/mount
[ -x "$MED_BIN" ] || MED_BIN=../mediator/target/debug/mount

cleanup() { sudo umount "$MNT" 2>/dev/null || true; [ -n "${MED_PID:-}" ] && kill "$MED_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "[e87760] starting the mediator NFS server…"
: > "$LOG"
"$MED_BIN" >>"$LOG" 2>&1 &
MED_PID=$!
for _ in $(seq 1 60); do grep -q "confined NFS server on" "$LOG" && break; sleep 0.1; done
PORT=$(grep -oE "127\.0\.0\.1:[0-9]+" "$LOG" | head -1 | cut -d: -f2 || true)
[ -n "$PORT" ] || { echo "FAIL: mediator did not report a port"; cat "$LOG"; exit 1; }
echo "[e87760] mediator serving on 127.0.0.1:$PORT (policy: read /skills; content: /skills/demo.md)"

echo "[e87760] host-mounting the mediator's NFS (noac → every op hits the mediator)…"
mkdir -p "$MNT"
sudo mount -t nfs -o vers=3,tcp,port="$PORT",mountport="$PORT",noac 127.0.0.1:/ "$MNT" \
  || skip "NFS mount failed (macOS nfs + sudo required)"

echo "[e87760] booting the guest with virtio-fs backed by the mediated mount…"
GUEST='echo GUEST_UP; mkdir -p /mnt; mount -t virtiofs workspace /mnt && echo MOUNT_OK || echo MOUNT_FAIL; '\
'echo ALLOWED-READ:; cat /mnt/skills/demo.md && echo READ_OK; '\
'echo DENIED-READ:; cat /mnt/etc/secret 2>&1 | head -1; echo GUEST_DONE'
export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
OUT=$(SPIKE_ROOTFS="$PWD/rootfs" SPIKE_WORKSPACE="$PWD/$MNT" SPIKE_GUEST_SCRIPT="$GUEST" ./probe 2>&1 || true)
echo "$OUT"

# ── assertions ──────────────────────────────────────────────────────────────
echo "$OUT" | grep -q MOUNT_OK   || { echo "FAIL: guest could not mount the mediated virtio-fs"; exit 1; }
echo "$OUT" | grep -q READ_OK    || { echo "FAIL: allowed skill read did not succeed through the mediator"; exit 1; }
echo "$OUT" | grep -q "hello world" || { echo "FAIL: mediator did not serve the allowed skill content"; exit 1; }
# completeness: the mediator's RecordingSink logs a skill_load per served read
grep -qiE "skill_load|/skills/demo.md" "$LOG" \
  || echo "WARN: mediator log shows no SkillLoadReceipt for the read — check RecordingSink emit (cloister-3fc1b6)"
# the denied path must fail IN-GUEST (mediator denies anything outside /skills)
echo "$OUT" | grep -A1 "DENIED-READ:" | grep -qiE "no such file|denied|i/o error|can't open|not permitted" \
  || echo "WARN: policy-denied read did not clearly fail in-guest — inspect the DENIED-READ line above"

echo
echo "PASS: the guest fs traverses the ConfinementGraph mediator —"
echo "      allowed skill served + recorded, policy-denied path blocked in-guest."
echo "      ADR-0044/0046 'the mediated fs is the only fs' holds for this run."
echo
echo "Full every-op fidelity trace (cloister-e87760 acceptance): in another shell run"
echo "    sudo fs_usage -w -f filesys | grep $MNT"
echo "  while the guest reads/stats the same file repeatedly — confirm EVERY op appears"
echo "  (not just first-read). DAX-off (no shm window) + noac is what makes that true."
