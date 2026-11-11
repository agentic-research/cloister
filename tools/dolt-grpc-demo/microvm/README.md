# dolt-grpc-demo on microVMs, from `cluster.toml`

Two microVMs joined by one declared connection (`cloister-991e65`, ADR-0069 /
ADR-0070). Nothing is hand-built. The plans, the socket paths, the start order
and readiness are all derived from [`cluster.toml`](cluster.toml):

- `dolt`: `dolt sql-server` (Dolt 1.86.1). It declares port `mysql` 3306
  (`art.mysql`, expose `cluster`).
- `orders`: the gRPC service from [`..`](../README.md). It declares port `grpc`
  50051 (`art.grpc`, expose `cluster`). Its connection `orders-db` targets
  `dolt.mysql`, with `minStrength = "capability"`.

## Requirements

- An Apple-silicon Mac (the images are linux/arm64), with libkrun and libkrunfw
  as `cloister runtime install` expects.
- `melange` and `apko`, to build the images (only to rebuild them: the lock
  is committed). On macOS, melange runs its build steps in a container, so
  that step needs a container runtime (Docker or OrbStack). On Linux it uses
  bubblewrap. apko needs neither.
- `grpcurl` for the check.

## From a clean checkout

```sh
pnpm install
node bin/cloister.mjs runtime install           # host runtime + krun worker
tools/dolt-grpc-demo/microvm/build.sh           # images → layouts → lock → import
node bin/cloister.mjs cluster up --env local --dir tools/dolt-grpc-demo/microvm
```

`build.sh` does three things:

1. **Builds both images reproducibly** with
   [`build-images.sh`](build-images.sh) (`cloister-2af014`), the way cloister
   builds its own image: melange makes an APK, apko makes an OCI layout in
   `out/`, linux/arm64.
   - [`melange-dolt.yaml`](melange-dolt.yaml): the static `dolt` binary from
     the official v1.86.1 release tarball, fetched with a pinned sha256. Wolfi
     ships no dolt package. [`apko-dolt.yaml`](apko-dolt.yaml) adds an empty
     `/data` for Dolt's data directory. `/tmp` is not shipped: since LLO
     v0.29.0 every guest has a tmpfs `/tmp`.
   - [`melange-orders.yaml`](melange-orders.yaml): a static (CGO off) build
     of the same package as `../Dockerfile`, with Go pinned to one Wolfi build
     and an empty build id. [`apko-orders.yaml`](apko-orders.yaml) runs it as
     the nonroot user (uid 65532), as `../Dockerfile`'s image does.
   - Every stamped timestamp is a constant `SOURCE_DATE_EPOCH`, and no
     commit hash, signing key or local path reaches an image (the script's
     header says why each is pinned). Two clean builds give byte-identical
     digests.
   - melange and apko are pinned to the versions that built the committed
     pins (melange 0.48.2, apko 1.2.2, in `build-images.sh`): melange writes
     its version into each APK's SBOM. Another version is refused by name.
   - The script writes only into a directory it made (a `.build-images-out`
     marker) and deletes only what it creates; it refuses any other
     non-empty directory.
2. **Pins each layout's digest** (from its own `index.json`) into
   [`cluster.lock.toml`](cluster.lock.toml) as `[inputs.<bundle>.oci]`. The
   lock is committed: a clean build pins the same digests, so `build.sh`
   leaves it unchanged. If a pin does change, `pin-layouts` prints a
   `WARNING` naming the old and new digest, and `git diff` shows it.
3. **Imports each pinned image** with `cloister runtime import --bundle
   … --symlinks resolve`. The images hold symlinks (apko's `/lib/apk`), which
   the importer's default refuses; LLO v0.30.0's rootfs manifest v2
   (ley-line-open-4f08ea) will record them, and the default will do. The
   import records the `blake3-256:` rootfs as a
   `[[inputs.<bundle>.oci.rootfs]]` row for this host's platform
   (`platform = "linux/arm64"` on Apple silicon). Re-running it is
   idempotent: an unchanged image prints `already recorded`.

**Reproducibility limit.** melange records each packaged file's owner as the
uid and gid of the user running the build (its container runner hands the
built files back through the host filesystem), and apko copies that into the
image's apk database (`a:501:20:0755`). The committed digests are therefore
those of a build run as uid 501, gid 20: the first account on a Mac. A build
as another user, or on Linux, gives different digests, and `build.sh` then
rewrites the lock (`cloister-426cb8`).

`cluster up` starts `dolt`, waits until its `dolt.mysql.sock` exists (it is then "bound"), then
starts `orders`, and prints:

```
  dolt.mysql (art.mysql): unix:///private/tmp/cloister-up-XXXXXX/dolt.mysql.sock
  orders.grpc (art.grpc): unix:///private/tmp/cloister-up-XXXXXX/orders.grpc.sock
cloister cluster up: all bundles bound (health not checked — ADR-0071 §3); Ctrl-C to stop
```

From another terminal, using the printed path. `orders` may still be seeding
for a few seconds; retry on `Unavailable`:

```sh
grpcurl -plaintext -d '{"id":1}' unix:///private/tmp/cloister-up-XXXXXX/orders.grpc.sock cloister.demo.v1.Orders/Get
# {"id": 1, "msg": "read from Dolt over a declared connection", "branch": "main"}
```

Press Ctrl-C in the `up` terminal. It stops `orders`, then `dolt`, and removes
the socket directory. Each host runtime cancels its run through LLO, which
kills the worker's process group.

When the VMs are, and are not, cleaned up:

- **Cleaned up:** these paths reach LLO's cancel, which kills the worker:
  - Ctrl-C, SIGTERM, SIGHUP or SIGQUIT to `up`;
  - a crash inside `up`, or its stdout closing;
  - a run ending on its own;
  - a stop during a bundle's start: the host runtime waits for start to
    settle, then cancels;
  - `up` itself killed with `kill -9`: each host runtime sees its stdin close
    and stops its run. Seen live: both host runtimes and both workers were
    gone within a second. Nothing removes `up`'s socket directory in that
    case, because its teardown never ran. Remove the printed
    `/private/tmp/cloister-up-…` directory by hand. A later `up` never reuses
    it.
- **Not guaranteed:**
  - A third signal makes `up` SIGKILL the host runtimes, and `up` says so.
  - A host runtime killed with `kill -9` directly.

  In both cases the krun workers can outlive their host runtime, because a
  worker does not notice its parent dying until ley-line-open-f963e6. Check
  `ps` for `leyline-krun-worker` after such a stop.

## The negative check

Copy `cluster.toml` and `cluster.lock.toml` to a scratch
directory. Delete the `[[connections]]` block (and its `[[connections.targets]]`
row) from the copy, and run `cluster up --env local --dir <scratch>`. `orders`
then has no channel to Dolt: `127.0.0.1:3306` in its guest answers nothing. It
gives up after its 30 s retry window and exits 2, and `up` reports:

```
cloister cluster up: bundle "orders" exited on its own with status 1: cloister-host-runtime: the workload ran and failed: BackendFailed: libkrun worker exited with exit status: 2; stopped the rest
```

The host runtime itself exits 1. Its message carries the guest's exit status,
2. `up` stops `dolt` before exiting non-zero.

## Notes

- **Signals while stopping:** a second Ctrl-C prints which bundles are still
  stopping and keeps waiting. A third SIGKILLs the host runtimes (see the
  limits above).
- **The services are stopped after 15 minutes.** Every run carries a
  wall-clock ceiling. LLO requires one, and cloister's default is 15 minutes.
  A service cannot yet ask for "no ceiling" (ley-line-open-e6b1bb). When the
  ceiling is reached, the host runtime exits 124, and `up` reports it as the
  ceiling, not as a workload failure:
  `bundle "dolt" reached its wall-clock ceiling and was stopped by the runtime — not a workload failure`.
  `up` then stops the rest and exits 124. Each bundle's ceiling is printed
  when it starts (`[dolt] cloister-host-runtime: run-dolt: wall-clock ceiling … s`).

- `bound` means every socket the bundle binds exists, and nothing more. A
  dependent can then be
  granted its channel. Health is not checked, so `up` does not call it
  ready ([ADR-0071](../../../docs/adr/0071-who-owns-a-running-workload.md) §3).
  The workload may not be listening yet. Since LLO
  v0.29.0 an early connection is held for up to 10 s, not closed; `orders`'
  client still retries.
- When a run FAILS, the host runtime prints the guest's stdout and stderr
  tails (LLO v0.29.0, a26ad0) as a block labelled `guest output (untrusted …)`.
  Nothing is printed for a success, or for a stop at the wall-clock ceiling,
  which isn't a workload failure. Every guest line is prefixed with
  `| `, and `up` shows it under the bundle's `[name]` prefix. It is the
  workload's own text: never interpreted, and it never changes an exit status.
  Exit codes propagate as before.
- The workload args avoid `"` (LLO d4b07f mangles it).
