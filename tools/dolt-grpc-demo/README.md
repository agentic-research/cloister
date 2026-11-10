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

Until `cloister runtime plan` lowers `cluster.toml` connections (ADR-0070 §4),
you write the two launch plans by hand and put each rootfs into the CAS
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
