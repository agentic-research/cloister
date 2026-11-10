# dolt-grpc-demo

The gRPC half of the two-microVM demo (`cloister-991e65`, ADR-0069 / ADR-0070):

```
host ── grpcurl ──▶ [microVM B: Orders gRPC] ── MySQL wire ──▶ [microVM A: dolt sql-server]
        B's socket       bind grant, guestPort 50051     A's socket      bind grant, guestPort 3306
                         connect grant on A's socket, guestPort 3306
```

The service only knows two loopback addresses: it dials `-db 127.0.0.1:3306`
and serves on `-listen 127.0.0.1:50051`. Inside a cloister microVM, both are
guest loopback ports that the confinement document presents (confinement/v1 §6
`guestPort`). What answers on `127.0.0.1:3306` is decided by the document the
host runtime carries, not by the service. With no grant, nothing answers.

On startup the service seeds `orders.orders` with one row, then serves
`cloister.demo.v1.Orders/Get`. Each reply includes the database's
`active_branch()`, so you can see the row came from Dolt. Server reflection is
on, so `grpcurl` needs no proto file.

## Build

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o out/orders .
```

To regenerate `ordersv1/` after editing `orders.proto`, run `protoc` with the
`protoc-gen-go` and `protoc-gen-go-grpc` plugins (`paths=source_relative`).

## Run it

`cloister runtime plan` now derives these grants from `cluster.toml` ports
and connections (ADR-0070 §4). The walkthrough below writes the two launch
plans by hand and put each rootfs into the CAS
yourself. A rootfs is a directory in `$CLOISTER_CAS_ROOT` named by the BLAKE3
of its `rootfs.manifest.json`. The manifest lists each file's path, mode and
BLAKE3. The guest has no `/tmp` unless the rootfs ships one, so include
`tmp/.keep`.

VM A runs `dolt sql-server --host 127.0.0.1 --port 3306 --data-dir /data` with:

```json
"confinement": { "unixSocket": { "allow": [
  { "path": "<run dir>/dolt.sock", "mode": "bind", "guestPort": 3306 }
] } }
```

VM B runs `/bin/orders -db 127.0.0.1:3306 -listen 127.0.0.1:50051` with:

```json
"confinement": { "unixSocket": { "allow": [
  { "path": "<run dir>/dolt.sock",   "guestPort": 3306 },
  { "path": "<run dir>/orders.sock", "mode": "bind", "guestPort": 50051 }
] } }
```

Start A and wait for its socket. B's connect grant needs A's socket to exist
already. Then start B and call it:

```sh
grpcurl -plaintext -d '{"id":1}' unix://<run dir>/orders.sock cloister.demo.v1.Orders/Get
```

grpcurl 1.9 needs the `unix://` scheme. With `-unix`, it still dials TCP.

## What was observed

Checked on darwin-arm64 with LLO v0.28.0 and socket hijacking off (main fd3e96c):

- `Get {"id":1}` returned `{"id":1,"msg":"read from Dolt in another microVM","branch":"main"}`
  on the first attempt. `Get {"id":9}` returned `NotFound`.
- With B's connect grant on A's socket removed (bind grant kept), B exited 2,
  the service's "database did not answer" branch, and the host got no reply.
  This is the `capability` strength from ADR-0070 §3: with no declared edge, B
  has nothing to dial.
- Undeclared destinations from a guest, checked by `tools/edge-probe`: other
  loopback ports get "Connection refused", external addresses get "Network
  unreachable", and UDP gets "Permission denied".

## Run it on kind (the `policy` tier)

The same two services, forwarded to Kubernetes instead of constructed as
microVMs (ADR-0070 §2). [`k8s/cluster.toml`](k8s/cluster.toml) places both
bundles `kubernetes` for env `local` and declares the `orders-db` connection
with `minStrength = "policy"`. [`k8s/dolt.yaml`](k8s/dolt.yaml) and
[`k8s/orders.yaml`](k8s/orders.yaml) are the operator's rendered manifests.
`cloister cluster k8s` checks each manifest's Service against the declared
ports and copies it unchanged. It then adds one namespace per bundle, a
default-deny-ingress NetworkPolicy, and one NetworkPolicy that admits `orders`
pods to `dolt` pods on 3306.

The service's address for Dolt (`dolt.dolt.svc.cluster.local:3306`) is written
in `orders.yaml`. cloister does not emit env vars yet.

NetworkPolicy is only enforced when the CNI enforces it. kind's default CNI
does from v0.24.

From the repository root:

```sh
kind create cluster --name cloister-demo            # kind >= v0.24
docker build -t dolt-grpc-demo:dev tools/dolt-grpc-demo
kind load docker-image dolt-grpc-demo:dev --name cloister-demo

rm -rf /tmp/cloister-k8s-out    # --out refuses files this run would not write
cloister cluster k8s --dir tools/dolt-grpc-demo/k8s --env local --out /tmp/cloister-k8s-out
kubectl apply -n dolt   -f /tmp/cloister-k8s-out/dolt
kubectl apply -n orders -f /tmp/cloister-k8s-out/orders
kubectl -n dolt   rollout status deploy/dolt   --timeout=180s
kubectl -n orders rollout status deploy/orders --timeout=180s
```

Each directory is applied with `-n <bundle>` because the operator's objects
declare no namespace, and cloister does not edit them to add one.

Positive check: the declared edge works. `orders` seeded its row through it.

```sh
kubectl -n orders port-forward svc/orders 50051:50051 &
grpcurl -plaintext -d '{"id":1}' 127.0.0.1:50051 cloister.demo.v1.Orders/Get
# expect {"id":1,"msg":"…","branch":"main"}
```

Negative check: a pod outside the edge cannot reach Dolt. This must FAIL,
with nc exiting non-zero after the 3 s timeout:

```sh
kubectl create namespace intruder
kubectl run probe -n intruder --rm -i --restart=Never --image=busybox:1.36.1 -- \
  nc -z -w3 dolt.dolt.svc.cluster.local 3306
```

Control (optional): the same probe, in the `orders` namespace with the `orders`
pod label, succeeds. That shows the NetworkPolicy is what refused the intruder,
not DNS or Dolt.

```sh
kubectl run probe -n orders --labels app=orders --rm -i --restart=Never --image=busybox:1.36.1 -- \
  nc -z -w3 dolt.dolt.svc.cluster.local 3306
```

Clean up with `kind delete cluster --name cloister-demo`.
