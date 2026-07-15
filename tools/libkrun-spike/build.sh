#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
INC=$(ls -d /opt/homebrew/Cellar/libkrun/*/include 2>/dev/null | head -1)
if [ -z "${INC:-}" ] || ! command -v cc >/dev/null; then
  echo "SKIP: libkrun headers or cc not found (brew tap slp/krun && brew install krunvm)" >&2
  exit 0
fi
cc probe.c -I"$INC" -L/opt/homebrew/lib -lkrun -Wl,-rpath,/opt/homebrew/lib -o probe
codesign --entitlements hv.entitlements -s - --force probe
echo "built + signed: $(pwd)/probe"
