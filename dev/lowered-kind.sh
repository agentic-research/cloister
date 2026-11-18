#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# dev/lowered-kind.sh — apply what cloister lowers to a real cluster, and see
# that it does what cluster.toml says (ADR-0074 §7, ADR-0070 §4).
#
# Every other test of lowering stops at the YAML. This one runs it:
#
#   1. `cluster lower` writes the manifests from test/e2e/lowered-kind/cluster.toml
#   2. `cluster k8s` checks them and writes the NetworkPolicies
#   3. `kubectl apply` puts all of it on a kind cluster
#   4. then three things are observed, not assumed:
#        - the declared caller reaches the server at the address lowering wrote
#        - the declared Job runs to completion
#        - an undeclared pod is REFUSED by the cluster
#
# The third is the one that matters. Without it this would pass on a cluster
# that enforces nothing, and "strength: policy" would be a word.
#
# Needs: kind (>= 0.24, whose network plugin enforces NetworkPolicy), kubectl,
# docker, node. Run from the repository root: `task smoke:lowered-kind`.
#
#   KEEP_CLUSTER=1   leave the kind cluster up afterwards, to look around
#   CLUSTER_NAME     kind cluster name (default: cloister-lowered)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-cloister-lowered}"
CONTEXT="kind-${CLUSTER_NAME}"
ENV_NAME="local"
WORK="$(mktemp -d)"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }
k() { kubectl --context "$CONTEXT" "$@"; }

for tool in kind kubectl docker node; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed; this smoke needs kind, kubectl, docker and node"
done

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    # What a person would look at first, while the cluster still exists.
    say "state at failure"
    k get pods,jobs,networkpolicies --all-namespaces -o wide 2>/dev/null || true
    k get events --all-namespaces --sort-by=.lastTimestamp 2>/dev/null | tail -25 || true
  fi
  if [ "${KEEP_CLUSTER:-0}" = "1" ]; then
    printf '\nkind cluster "%s" left running (KEEP_CLUSTER=1). Delete it with: kind delete cluster --name %s\n' "$CLUSTER_NAME" "$CLUSTER_NAME"
  else
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

say "lower cluster.toml to manifests"
cp "$ROOT/test/e2e/lowered-kind/cluster.toml" "$WORK/cluster.toml"
node "$ROOT/bin/cloister.mjs" cluster lower --dir "$WORK" --env "$ENV_NAME"

say "check the manifests and write the NetworkPolicies"
node "$ROOT/bin/cloister.mjs" cluster k8s --dir "$WORK" --env "$ENV_NAME" --out "$WORK/k8s"

say "create kind cluster \"$CLUSTER_NAME\""
kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
kind create cluster --name "$CLUSTER_NAME" --wait 120s

say "apply"
for dir in "$WORK"/k8s/*/; do
  bundle="$(basename "$dir")"
  k apply -n "$bundle" -f "$dir"
done

say "wait for the workloads"
for bundle in server caller stranger; do
  k rollout status "deployment/$bundle" -n "$bundle" --timeout=180s
done

# The address the caller was GIVEN, read back from what was applied. Using it,
# and not a copy typed here, is what makes this a test of the lowering.
url="$(k get deployment caller -n caller -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="SERVER_URL")].value}')"
[ -n "$url" ] || fail "the caller has no SERVER_URL: lowering did not write the connection's address"
hostport="${url#*://}"
hostport="${hostport%%/*}"
printf 'caller was given SERVER_URL=%s\n' "$url"

# A policy takes a moment to reach the node after it is applied, so each
# observation is retried until it holds. The two can only be told apart by
# which way they are allowed to settle: the declared edge must come to work,
# and the undeclared one must come to be refused, each within the time given.
connects() { k exec -n "$1" "deployment/$1" -- /agnhost connect --timeout=3s "$hostport" >/dev/null 2>&1; }

say "the declared caller reaches the server"
ok=0
for _ in $(seq 1 30); do
  if connects caller; then ok=1; break; fi
  sleep 2
done
[ "$ok" = "1" ] || fail "caller could not reach $hostport, though cluster.toml declares the connection"
echo "ok: caller → server"

say "the declared Job runs to completion"
k wait --for=condition=complete job/probe -n probe --timeout=180s || fail "the probe Job did not complete: it could not reach the server"
echo "ok: probe → server, and the Job finished"

say "an undeclared pod is refused"
refused=0
for _ in $(seq 1 15); do
  if ! connects stranger; then refused=1; break; fi
  sleep 2
done
[ "$refused" = "1" ] || fail "stranger reached $hostport with no declared connection: the cluster is not enforcing the NetworkPolicy"
# Refused once is not enough if it was a blip: it must stay refused.
for _ in 1 2 3; do
  if connects stranger; then fail "stranger was refused and then got through: the denial does not hold"; fi
done
echo "ok: stranger ✗ server"

# And the allowed edge still works after the policy has settled, so the
# refusal above is the policy and not a server that went away.
connects caller || fail "caller lost its connection once the policy settled"

say "PASS: lowered manifests run on a real cluster, and the declared graph is what the cluster enforces"
