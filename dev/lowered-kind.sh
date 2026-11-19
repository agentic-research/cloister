#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# dev/lowered-kind.sh — apply what cloister lowers to a real cluster, and see
# that it does what cluster.toml says (ADR-0074 §7, ADR-0070 §4).
#
# Every other test of lowering stops at the YAML. This one runs it:
#
#   1. `cluster lower` writes the manifests from a hand-written cluster.toml
#   2. `cluster k8s` checks them and writes the NetworkPolicies
#   3. `kubectl apply` puts all of it on a kind cluster
#   4. then the graph is observed, not assumed
#
# Two scenarios, chosen by the first argument:
#
#   kubernetes (default)   test/e2e/lowered-kind/cluster.toml
#       - the declared caller reaches the server at the address lowering wrote
#       - the declared Job runs to completion
#       - an undeclared pod is REFUSED by the cluster
#
#   knative                test/e2e/lowered-knative/cluster.toml
#       Knative Serving and Kourier are installed first.
#       - the Knative Service becomes ready, and has no route from outside
#       - a kubernetes pod reaches it over HTTP, through Knative's ingress
#       - its own pod reaches a kubernetes Service (knative → kubernetes)
#       - an undeclared pod is REFUSED by that kubernetes Service
#
# The refusals are the ones that matter. Without them this would pass on a
# cluster that enforces nothing, and "strength: policy" would be a word.
#
# Needs: kind (>= 0.24, whose network plugin enforces NetworkPolicy), kubectl,
# docker, node, and curl for the knative scenario. Run from the repository
# root: `task smoke:lowered-kind` or `task smoke:lowered-knative`.
#
#   KEEP_CLUSTER=1   leave the kind cluster up afterwards, to look around
#   CLUSTER_NAME     kind cluster name (default: cloister-lowered-<scenario>)

set -euo pipefail

SCENARIO="${1:-kubernetes}"
case "$SCENARIO" in
  kubernetes) INPUT="test/e2e/lowered-kind/cluster.toml" ;;
  knative) INPUT="test/e2e/lowered-knative/cluster.toml" ;;
  *) printf 'usage: dev/lowered-kind.sh [kubernetes|knative]\n' >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-cloister-lowered-${SCENARIO}}"
CONTEXT="kind-${CLUSTER_NAME}"
ENV_NAME="local"
WORK="$(mktemp -d)"
FORWARD_PID=""

# Knative Serving and its Kourier ingress, pinned by release and by digest:
# what is applied to the cluster is exactly what was reviewed.
KNATIVE_VERSION="knative-v1.24.0"
KNATIVE_MANIFESTS=(
  "https://github.com/knative/serving/releases/download/${KNATIVE_VERSION}/serving-crds.yaml 85dfaab78eb0032e920f754198ee9f2c7e94d1ae6d3583768b0ba910646f5f36"
  "https://github.com/knative/serving/releases/download/${KNATIVE_VERSION}/serving-core.yaml 04535dccf8f7bc615e7a21e9cbf73bb133daef3047e91488f203900ba81fb2c3"
  "https://github.com/knative-extensions/net-kourier/releases/download/${KNATIVE_VERSION}/kourier.yaml 60c7f7a1c1d503075f653e58e2a5b48d0417da5659f0d2be988b8fa1c2b165f8"
)

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }
k() { kubectl --context "$CONTEXT" "$@"; }

TOOLS=(kind kubectl docker node)
[ "$SCENARIO" = "knative" ] && TOOLS+=(curl sha256sum)
for tool in "${TOOLS[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed; the $SCENARIO scenario needs: ${TOOLS[*]}"
done

cleanup() {
  status=$?
  [ -n "$FORWARD_PID" ] && kill "$FORWARD_PID" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ]; then
    # What a person would look at first, while the cluster still exists.
    say "state at failure"
    k get pods,jobs,networkpolicies --all-namespaces -o wide 2>/dev/null || true
    [ "$SCENARIO" = "knative" ] && { k get ksvc,revisions,routes --all-namespaces 2>/dev/null || true; }
    k get events --all-namespaces --sort-by=.lastTimestamp 2>/dev/null | tail -30 || true
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

# host:port of the address a bundle was GIVEN in an env var, read back from
# what was applied. Using it, and not a copy typed here, is what makes this a
# test of the lowering. A URL with no port is dialled on its scheme's port.
given_hostport() { # <namespace> <kind/name> <env var> <jsonpath to the pod spec>
  local url
  url="$(k get "$2" -n "$1" -o "jsonpath={$4.containers[0].env[?(@.name==\"$3\")].value}")"
  [ -n "$url" ] || fail "$2 has no $3: lowering did not write the connection's address"
  printf '%s was given %s=%s\n' "$2" "$3" "$url" >&2
  local hostport="${url#*://}"
  hostport="${hostport%%/*}"
  case "$hostport" in *:*) ;; *) hostport="${hostport}:80" ;; esac
  printf '%s' "$hostport"
}

# A policy takes a moment to reach the node after it is applied, so each
# observation is retried until it holds. The two can only be told apart by
# which way they are allowed to settle: a declared edge must come to work, and
# an undeclared one must come to be refused, each within the time given.
connects() { # <namespace> <pod or deployment/name> <host:port> [container]
  k exec -n "$1" "$2" ${4:+-c "$4"} -- /agnhost connect --timeout=3s "$3" >/dev/null 2>&1
}
must_connect() { # <what> <namespace> <target> <host:port> [container]
  local i
  for i in $(seq 1 30); do
    if connects "$2" "$3" "$4" "${5:-}"; then echo "ok: $1"; return 0; fi
    sleep 2
  done
  fail "$1: could not reach $4, though cluster.toml declares the connection"
}
must_be_refused() { # <what> <namespace> <target> <host:port>
  local i refused=0
  for i in $(seq 1 15); do
    if ! connects "$2" "$3" "$4"; then refused=1; break; fi
    sleep 2
  done
  [ "$refused" = "1" ] || fail "$1: reached $4 with no declared connection: the cluster is not enforcing the NetworkPolicy"
  # Refused once is not enough if it was a blip: it must stay refused.
  for i in 1 2 3; do
    if connects "$2" "$3" "$4"; then fail "$1: was refused and then got through: the denial does not hold"; fi
  done
  echo "ok: $1"
}

say "lower cluster.toml to manifests ($SCENARIO)"
cp "$ROOT/$INPUT" "$WORK/cluster.toml"
node "$ROOT/bin/cloister.mjs" cluster lower --dir "$WORK" --env "$ENV_NAME"

say "check the manifests and write the NetworkPolicies"
node "$ROOT/bin/cloister.mjs" cluster k8s --dir "$WORK" --env "$ENV_NAME" --out "$WORK/k8s"

say "create kind cluster \"$CLUSTER_NAME\""
kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
kind create cluster --name "$CLUSTER_NAME" --wait 120s

if [ "$SCENARIO" = "knative" ]; then
  say "install Knative Serving and Kourier ($KNATIVE_VERSION)"
  for entry in "${KNATIVE_MANIFESTS[@]}"; do
    url="${entry% *}"
    digest="${entry#* }"
    file="$WORK/$(basename "$url")"
    curl -fsSL --retry 3 -o "$file" "$url"
    echo "$digest  $file" | sha256sum -c - >/dev/null || fail "$(basename "$url") does not match its pinned digest"
    k apply -f "$file" >/dev/null
    # The CRDs must be established before the objects that use them.
    case "$url" in *serving-crds.yaml) k wait --for=condition=Established crd --all --timeout=120s >/dev/null ;; esac
  done
  k wait --for=condition=Available deployment --all -n knative-serving --timeout=300s
  k wait --for=condition=Available deployment --all -n kourier-system --timeout=300s
  # After the wait: Knative's webhook validates this ConfigMap, and refuses the
  # change while it is still starting.
  k patch configmap/config-network -n knative-serving --type merge \
    --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}' >/dev/null
fi

say "apply"
for dir in "$WORK"/k8s/*/; do
  bundle="$(basename "$dir")"
  k apply -n "$bundle" -f "$dir"
done

if [ "$SCENARIO" = "kubernetes" ]; then
  say "wait for the workloads"
  for bundle in server caller stranger; do
    k rollout status "deployment/$bundle" -n "$bundle" --timeout=180s
  done
  hostport="$(given_hostport caller deployment/caller SERVER_URL .spec.template.spec)"

  say "the declared caller reaches the server"
  must_connect "caller → server" caller deployment/caller "$hostport"

  say "the declared Job runs to completion"
  k wait --for=condition=complete job/probe -n probe --timeout=180s || fail "the probe Job did not complete: it could not reach the server"
  echo "ok: probe → server, and the Job finished"

  say "an undeclared pod is refused"
  must_be_refused "stranger ✗ server" stranger deployment/stranger "$hostport"

  # And the allowed edge still works after the policy has settled, so the
  # refusal above is the policy and not a server that went away.
  connects caller deployment/caller "$hostport" || fail "caller lost its connection once the policy settled"
else
  say "wait for the workloads"
  for bundle in api client outsider; do
    k rollout status "deployment/$bundle" -n "$bundle" --timeout=180s
  done
  k wait ksvc/web -n web --for=condition=Ready --timeout=300s

  say "the Knative Service has no route from outside the cluster"
  # expose = "cluster" was lowered to Knative's visibility label. Knative shows
  # what it made of it in the URL it gives the Service: a cluster-local name.
  url="$(k get ksvc web -n web -o jsonpath='{.status.url}')"
  [ "$url" = "http://web.web.svc.cluster.local" ] || fail "web's URL is \"$url\", not a cluster-local one: it has a route from outside"
  echo "ok: web is reached at $url only"

  say "a kubernetes pod reaches the Knative Service, over HTTP"
  web_hostport="$(given_hostport client deployment/client WEB_URL .spec.template.spec)"
  # agnhost can make an HTTP request on request: ask the client to dial web.
  # The answer is the hostname of the pod that served it, so it is a real
  # response from the Knative Service and not just an open port.
  k port-forward -n client deployment/client 18080:8080 >/dev/null 2>&1 &
  FORWARD_PID=$!
  dial="http://127.0.0.1:18080/dial?request=hostname&protocol=http&host=${web_hostport%:*}&port=${web_hostport##*:}&tries=1"
  answer=""
  for _ in $(seq 1 30); do
    answer="$(curl -fsS --max-time 20 "$dial" 2>/dev/null || true)"
    case "$answer" in *'"responses":["web-'*) break ;; esac
    sleep 2
  done
  served="$(printf '%s' "$answer" | sed -n 's/.*"responses":\["\([^"]*\)".*/\1/p')"
  case "$served" in
    web-*) echo "ok: client → web, answered by $served" ;;
    *) fail "client could not get an answer from web through Knative's ingress: ${answer:-no response}" ;;
  esac

  say "the Knative Service's pod reaches the kubernetes Service"
  api_hostport="$(given_hostport web ksvc/web API_URL .spec.template.spec)"
  # The request above started a pod. It is found by the label Knative puts on
  # every pod of a Service, which is the label the NetworkPolicy admits.
  pods="$(k get pods -n web -l serving.knative.dev/service=web --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}')"
  pod="${pods%% *}"
  [ -n "$pod" ] || fail "no running pod carries serving.knative.dev/service=web, the label the NetworkPolicy admits"
  must_connect "web → api" web "pod/$pod" "$api_hostport" web

  say "an undeclared pod is refused by the kubernetes Service"
  must_be_refused "outsider ✗ api" outsider deployment/outsider "$api_hostport"

  connects web "pod/$pod" "$api_hostport" web || fail "web lost its connection to api once the policy settled"
fi

say "PASS ($SCENARIO): lowered manifests run on a real cluster, and the declared graph is what the cluster enforces"
