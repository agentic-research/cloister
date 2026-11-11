# dolt-grpc-demo on microVMs, with Dolt from its published image

The same two services as [`../microvm`](../microvm/README.md). Here `dolt` is
**`dolthub/dolt-sql-server` 1.86.1 as published**: pinned by its multi-arch
index digest (the one [`../k8s/dolt.yaml`](../k8s/dolt.yaml) uses) and pulled
from Docker Hub by `cloister runtime import --bundle dolt` with no `--layout`
(`cloister-727354`). `orders` is built reproducibly with `../microvm`'s melange
+ apko build (`cloister-2af014`).

## From a clean checkout

```sh
pnpm install
node bin/cloister.mjs runtime install       # also provisions the case-sensitive CAS volume
tools/dolt-grpc-demo/microvm-published/build.sh
node bin/cloister.mjs cluster up --env local --dir tools/dolt-grpc-demo/microvm-published
```

`build.sh` builds orders' layout, pins orders' layout digest and Dolt's
published digest into [`cluster.lock.toml`](cluster.lock.toml), then imports
both. The lock is committed: both pins are the same on every checkout (see
`../microvm`'s reproducibility limit for the orders image). Dolt's import is a
registry pull:

```
cloister runtime import --bundle dolt --dir … --symlinks resolve
→ dolthub/dolt-sql-server@sha256:d492a79d… → blake3-256:3f8b2671…  (11655 files, 1966 links resolved)
```

The lock records it as the row for the platform LLO reported from the image's
config (`cloister-1c4ef5`). On an amd64 host the same import adds a
`linux/amd64` row beside it:

```toml
[[inputs.dolt.oci.rootfs]]
platform = "linux/arm64"
digest = "blake3-256:3f8b26712968250e02e650917f2f87adfa4746fa3e7c1230e8d8a335858c6a91"
image = "sha256:d492a79d22bc4bca51aa054293af95734a93ae005c22c80751148814379c8242"
symlinks = "resolve"
```

The pull is anonymous HTTPS, so only public images work; a tag-only or
unpinned image is refused. The image is Debian-based and has symlinks, so it
needs `--symlinks resolve`. It also has names that differ only by case
(perl's `Pod/` and `pod/`), so it needs a case-sensitive store.
`runtime install` provisions one: LLO's sparsebundle under
`~/.local/state/cloister/cas-volume`, created unprivileged with `hdiutil`. Each
run's ephemeral rootfs goes on the same volume. With the run root on default
APFS, the run was refused: `create ephemeral rootfs directory: File exists`
(ley-line-open-741388).

Then call orders as in `../microvm`:

```sh
grpcurl -plaintext -d '{"id":1}' unix://<printed orders.grpc.sock> cloister.demo.v1.Orders/Get
# {"id": 1, "msg": "read from Dolt over a declared connection", "branch": "main"}
```

## What the published image needed

- **No env.** Plans carry no environment yet. The image's
  `docker-entrypoint.sh` ran with the guest's own `HOME=/`, `PATH` and uid 0,
  and served on port 3306. `DOLT_ROOT_HOST` is not needed, because orders'
  connection arrives on the guest's loopback (`root@localhost`). The empty
  `WORKDIR /var/lib/dolt` is not in the imported rootfs, because the rootfs
  manifest lists files, not empty directories. The image config's working
  directory isn't applied either, so Dolt keeps its data under `/`. That data
  lives in the run's ephemeral rootfs and is gone when the run ends.
- **No tini.** The image's entrypoint is `tini -- docker-entrypoint.sh`. On
  LLO v0.29.0 a guest's arguments are cut at a literal `--`: `sh -c … a -- b`
  saw only `a`. So tini got no program and printed its usage.
  [`cluster.toml`](cluster.toml) runs the script directly. The guest has its
  own init. Reported as ley-line-open-7410ec.

## Observed (darwin-arm64, LLO v0.29.0)

- **Positive:** `SELECT dolt_version()` over the printed `dolt.mysql.sock`
  returned `1.86.1`. grpcurl returned the seeded row with `"branch": "main"`,
  and `id 9` returned `NotFound`.
- **SIGINT:** orders stopped, then dolt (both 143), and `up` exited 0. No
  host runtime, worker or socket directory was left.
- **Negative (connection removed):** `up` showed orders'
  `seed: database did not answer within 30s: dial tcp 127.0.0.1:3306: connect: connection refused`,
  stopped dolt and exited 1.
