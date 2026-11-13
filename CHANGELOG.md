# Changelog

All notable changes to cloister are tracked here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); the project is pre-1.0,
so we batch changes by month rather than ratcheting semver per release.

## [Unreleased]

### 2026-11 — Confinement digest no longer depends on a serde_json feature (`cloister-d95ff5`)

- The §7 canonicalizer now sorts object keys explicitly instead of relying on serde_json's `Map` being a sorted `BTreeMap`, which only holds while `preserve_order` is off.
- A workspace-wide build turned `preserve_order` on and broke two `confinement_digest` tests; the published digest is unchanged.
- One shared `cloister_cas::canonical_confinement_json` replaces three copies (test, example, dev-cert minter); it is native-only, so the wasm artifact is unchanged.
- `task rs:verify` now also runs the whole workspace with `llo-execution`, so feature unification is covered by the gate.

Tracking via the bead store (`rsry_list_beads --repo cloister --status open`).

### 2026-11 — Generator fetch replaces its cache file atomically (`cloister-fb0616`)

- `scripts/fetch-schema-bridge.mjs` wrote a downloaded generator straight to
  its cache path. `task lint` resolves the same generator from several
  parallel tasks, so on a cold cache one task could run the file while
  another was still writing it: `exec(): Text file busy`, and
  `cloister:zod:check-drift` failed. It happened in CI on the first runs
  after the LLO v0.30.0 bump made the cache path new.
- The asset is now written to a private file and renamed onto the cache
  path, so the path only ever names complete, verified bytes.

### 2026-11 — LLO v0.30.0: rootfs manifest v2, exact argv (`cloister-2fcb8f`, `cloister-b74da4`)

- **Pins.** Every ley-line-open channel moves to v0.30.0 (`de638aea`):
  Cargo deps, the `llo` input, the generator lock and the vendored
  execution/v1 contract. The contract gains `writeScope`, the
  `connectionsDigest` / `connectionsDocument` grant fields and
  `ConnectionOutcome`; cloister sends none of them yet.
- **BREAKING: every imported rootfs has a new digest.** The importer writes
  rootfs manifest v2. A lock row recorded before this release names a v1
  rootfs: re-run `cloister runtime import --bundle <name>` for each microvm
  bundle. Both demo locks are re-pinned.
- **`--symlinks` defaults to `preserve`.** Links are kept as links, so
  merged-usr and busybox images (Wolfi, Debian) import as they are. `refuse`
  and `resolve` remain. The demos no longer pass `--symlinks resolve`, and a
  lock row records the mode only when it is not `preserve`.
- **Empty directories are imported.** The demo dolt image drops its
  `/data/.keep` placeholder.
- **Arguments reach the guest byte for byte.** The published-image demo runs
  the image's own `tini -- docker-entrypoint.sh` instead of calling the
  script directly.
- **`Backend::start` takes the run's workspace shares.** The host runtime
  passes `ServedWorkspaces::none()`: a launch plan still maps no workspace.
- **`ureq` is held at 3.3.0 in `rs/Cargo.lock`.** LLO v0.30.0 does not
  compile against ureq 3.5 (`ley-line-open-d4ba4b`). Do not `cargo update`
  it until an LLO release fixes that.
- Checked live on darwin-arm64 with both demos: `mysql -h 127.0.0.1 -P 3306`
  returned the seeded row, grpcurl on `127.0.0.1:50051` returned it over the
  declared connection, and SIGINT left nothing running.
- Not in this release, still as before: the edge relay, a numeric wall-clock
  ceiling, and exit status 125 meaning either a pre-workload refusal or a
  workload that itself exited 125 (LLO v0.31.0).

### 2026-11 — Drop the SQLite advisory residual (`cloister-6ecd70`)

- The audit ignore for RUSTSEC-2026-0459 (bundled SQLite, through LLO's
  rusqlite) is removed from `rs/.cargo/audit.toml` and `rs/deny.toml`. The
  pinned LLO release already resolves rusqlite 0.41 / libsqlite3-sys 0.39, and
  `task rs:audit` passes without the ignore.

### 2026-11 — `expose = "edge"`: host TCP for microvm ports in `cluster up` (`cloister-991e65`)

- **What `edge` means now.** ADR-0069 §2 defines the three values: `none` (no
  channel), `cluster` (reachable only through declared connections), `edge`
  (that, plus from outside). For a `microvm` placement, `cluster up`
  publishes each `edge` port on the host as TCP at `127.0.0.1:<port>`
  (loopback only, never `0.0.0.0`) and relays each connection to the
  bundle's bind socket (`cli/lib/cluster/edge-relay.mjs`). It prints
  `edge: 127.0.0.1:3306 → dolt.mysql (art.mysql)`.
- **Lifecycle (ADR-0071 §1).** Every edge port is bound before any bundle
  starts. A busy one is refused by name (which bundle and port wanted it),
  with nothing started; binding is the check, so nothing else can take the
  port in between. A connection that arrives before its bundle is bound is
  closed. The listeners close before the runs are stopped; if `up` is
  killed, the OS closes them. Real-process tests cover SIGINT and `kill -9`.
- **Not reused:** the harness's `assertPortsFree`. It asks `lsof` (and
  passes when `lsof` is missing), checks then binds separately, and its
  message is about wrangler.
- **`cluster k8s`** refuses `edge` by name: a NodePort plus kind
  `extraPortMappings` is tracked with the broker work (`cloister-55424e`).
- **Demos.** `dolt.mysql` and `orders.grpc` are `expose = "edge"` in both
  microvm demos. Live on darwin-arm64:
  - `mysql -h 127.0.0.1 -P 3306 -uroot -e "select * from orders.orders"` and
    `grpcurl -plaintext 127.0.0.1:50051` return the row, on both demos;
  - the host's LAN address does not answer on 3306;
  - with `expose = "cluster"`, nothing listens on host 3306;
  - an edge port gives no VM a channel: with the connection removed, orders'
    guest dial to 127.0.0.1:3306 was refused while dolt was published on the
    host's;
  - SIGINT leaves no listener and no host runtime.
- **Boundary (ADR-0035).** The relay is a small data-plane piece in the Node
  CLI, carrying bytes and deciding nothing. LLO may absorb host publishing
  later; `up` would then pass the declaration through.

### 2026-11 — `cloister inspect`: plan references, Google Cloud Run / Cloud SQL, invoker evidence (`cloister-ca2582`)

- **Plan references.** A plan document says, in `configuration`, which
  resources an attribute references. For the attributes a mapping names
  (`referenceAttrs`), a fact keeps those resource addresses. A relation whose
  value is unknown until apply resolves through them, but only when exactly one
  referenced address has the target type; zero or several stay unresolved. A
  state document never uses references. A Worker's bindings list also gains a
  "Referenced by configuration" observation, which adds no wire and no finding.
- **More types.** `cloudflare_worker` plus its `cloudflare_worker_version`
  (one workload), R2 buckets (and their bindings), and a Google mapping for
  Cloud Run services, Cloud SQL instances and Cloud Tasks queues, each
  validated against its own vendored provider spec
  (`scripts/gen-facts-spec.mjs --provider ... --mapping ... --out ...`).
- **Invoker evidence.** Each Cloud Run service lists the invoker member rows
  the document holds, marks `allUsers` / `allAuthenticatedUsers` as publicly
  invocable, and says so when no row exists. Member rows are non-authoritative.
- **Fixture.** A real public plan (jsr, MIT) trimmed to mapped attributes by
  `scripts/trim-plan-fixture.mjs`, under `test/fixtures/terraform/oss/`.

### 2026-11 — `cloister inspect --terraform` / `--wrangler`: resource facts, imported and never granted (`cloister-85999c`)

- **What it does.** `cloister inspect --terraform <file>` reads the output of
  `terraform show -json` or `tofu show -json` (state or plan) and lists what
  it describes: Workers and their bindings, routes, KV and D1, tunnels and
  their ingress, Access applications, DNS names, private services.
  Cloudflare resource types are read today. `--wrangler <file>` (repeatable)
  reads a `wrangler.toml` or `wrangler.json`, where a Worker's bindings
  actually live; at least one of `--terraform` / `--wrangler` is required.
- **Compared with cluster.toml.** Each declared wire is reported as
  `evidenced` (a matching binding exists) or `unknown` (none in this
  document). A binding between workloads that no wire declares is reported as
  `undeclared`.
- **Read-only.** It runs no tool, reads no backend and writes nothing. A
  finding changes nothing: a fact has no field that could hold a grant, and
  the constructor refuses one by name (ADR-0073).
- **Secrets.**
  - Only the attributes in a data mapping are read, and anything the document
    marks sensitive is dropped. At load the mapping is validated against the
    provider's published schema (and wrangler's config schema), so an unknown
    or sensitive attribute cannot be mapped.
  - Relations are exact joins on mapped attributes. A value that matches
    nothing is reported as "not in this document"; nothing is guessed by name.
  - Ids are join keys and are not printed.
  - A Terraform document tracked by git is refused, because a rendered
    document prints secrets in plain text. A wrangler config is not.
  - The committed fixture is synthetic, and a test holds it to that.

### 2026-11 — Reproducible demo images (melange + apko); the demo locks are committed (`cloister-2af014`)

- **Build.** The microVM demo's images are built the way cloister builds its
  own: melange makes an APK, apko makes an OCI layout
  (`tools/dolt-grpc-demo/microvm/build-images.sh`). The two Dockerfiles are
  gone.
  - Wolfi ships no dolt package, so `melange-dolt.yaml` repackages the
    official v1.86.1 release binary, pinned by sha256.
  - `melange-orders.yaml` is the same static Go build, with Go pinned to one
    Wolfi build.
- **Reproducible.** These are pinned so no build-specific value reaches an
  image:
  - every timestamp is a constant `SOURCE_DATE_EPOCH`, not taken from git
    (committing the lock would move it);
  - melange records `--git-commit unknown` and a stated repository URL, and
    runs from the repository root with repo-relative paths;
  - apko runs from the output dir with the relative repository `./packages`;
  - the APKs are unsigned and apko ignores signatures: the images install only
    these local packages, and a per-machine key would be copied into
    `/etc/apk/keys`.
  - Two clean builds from different checkouts gave byte-identical digests.
- **Committed locks.** Both demos' `cluster.lock.toml` are now committed,
  with their linux/arm64 rootfs rows. `scripts/test/demo-locks.test.mjs`
  holds them to `cluster.toml` through the real lock readers. `task
  demo:images:check` rebuilds from a `git archive` of HEAD and requires the
  committed pins. It needs melange and apko, so it is not part of `task lint`.
- **Imports** use `--symlinks resolve`: apko writes `/lib/apk ->
  ../usr/lib/apk`. LLO v0.30.0's rootfs manifest v2 will make the default do.
- **`/data/.keep`.** Rootfs manifest v1 lists files only, so the dolt image
  ships one file in `/data`. Without it, dolt failed with "open /data: no such
  file or directory".
- **Limit.** melange records each packaged file's owner as the building
  user's uid and gid (`a:501:20` in the apk db). The committed digests are
  those of a build run as uid 501, gid 20 (a Mac's first account). Another
  user's build gives other digests (`cloister-426cb8`).
- **Docker.** melange needs a container runtime on macOS (its docker runner;
  bubblewrap on Linux). apko and the rest of the demo do not.

### 2026-11 — One rootfs row per platform in cluster.lock.toml (`cloister-1c4ef5`)

- **Lock shape.** `[inputs.<bundle>.oci]` no longer holds one flat `rootfs` /
  `rootfsImage` / `rootfsSymlinks`. Each imported rootfs is a
  `[[inputs.<bundle>.oci.rootfs]]` row: `platform`, `digest` (blake3-256),
  `image` (the sha256 it came from), and `symlinks` only when it isn't
  `refuse`. A pin is often a multi-platform index and LLO's importer builds
  the host's platform only; with one flat key the lock flipped between
  architectures on every re-import.
- **Platform is reported, never typed.** `runtime import` records the
  platform LLO read from the image's digest-verified config
  (`image.platform`), variant included as reported. No platform: nothing is
  recorded. Importing on one platform replaces only the rows that platform
  overlaps (`linux/arm64` and `linux/arm64/v8`, which one host selects
  alike), so a variant mismatch is repaired by re-importing rather than left
  as an ambiguity plan refuses.
- **One source for the host's platform.** A new host-runtime verb,
  `guest-platform`, prints LLO's `Platform::host()`, the value `import-oci`
  selects with. `runtime plan` and `cluster up` select the row it admits,
  by LLO's matching rule (no host variant admits any; `arm64` is `arm64/v8`).
  The CLI has no `process.arch` check.
- **Writers.** The one lock writer keeps every row while the pin is unchanged
  and drops all of them when it moves.
- **Refusals, by name:** no row for this host's platform (with the import
  command, and the platforms that are recorded); a row whose `image` is not
  the pin; two rows the host's platform both admits; and the old flat shape,
  which is not migrated because it does not say which platform it is for (its
  refusal prints the re-import command, and a re-import replaces it); and rows
  mixed with flat keys, at import and at plan (never collapsed: that would drop
  other platforms' rows). The no-row remedy carries the recorded rows'
  `--symlinks` policy, or lists each row's when they disagree.

### 2026-11 — Case-sensitive CAS volume and registry pulls (`cloister-727354`)

- **CAS volume.** `runtime install` provisions LLO's case-sensitive CAS
  volume through the new host-runtime `provision-cas` verb, which uses LLO's
  in-process `CasVolume`.
  - It is a sparsebundle under `<state>/cas-volume`, made with `hdiutil` as the
    user, with no sudo.
  - The returned `casRoot` is recorded in the provider record, the ONE place
    the CAS root is decided. The host runtime reads it as CLOISTER_CAS_ROOT,
    and so do `runtime plan`'s presence check and `storage status`.
  - The run root moves onto the same volume (`mnt/run`): a Debian rootfs
    failed to materialize on default APFS (`File exists`; LLO
    ley-line-open-741388).
  - A reboot or logout detaches the volume. `cluster up`, `runtime plan` and
    `runtime import` re-attach it through the host runtime's `cas-attach`
    (`attach_existing`, which never creates one) before they look in the
    store, and the host runtime does the same before a run or import. A
    detached volume no longer reads as "rootfs not in the CAS".
  - Install provisions the volume with the freshly built host runtime before
    anything is swapped into place, so a failed provision leaves the previous
    install intact.
  - A `CLOISTER_CAS_ROOT` that differs from the record is refused by the CLI;
    the host runtime refuses one that differs from the attached volume.
  - Removing the volume: `hdiutil detach <state>/cas-volume/mnt`, then delete
    `cas.sparsebundle`. It does not shrink by itself.
- **`runtime storage status`** reads the CAS root from the record and reports
  the volume (attached, case-sensitive) through the read-only `cas-status`.
- **Old store.** `~/.local/state/cloister/cas` is neither migrated nor
  deleted. Install says to re-import, and `runtime plan` names the command.
- **Registry source.** `runtime import --bundle <b>` with no `--layout` pulls
  the lock's pinned `identifier@sha256:…` through LLO's in-process
  `pull_oci_image`, then records the rootfs as before.
  - The pull is anonymous HTTPS, so only public images work.
  - An identifier with its own tag or digest, or an unpinned image, is
    refused.
- **Demo:** `tools/dolt-grpc-demo/microvm-published` runs the published
  `dolthub/dolt-sql-server` 1.86.1, pinned by its index digest and pulled
  from Docker Hub (`--symlinks resolve`).
  - It needed no env: the image's `docker-entrypoint.sh` ran with the guest's
    `HOME=/` and `PATH`.
  - It does not use tini: LLO v0.29.0 drops every guest argument from a
    literal `--` onward (ley-line-open-7410ec), so `tini -- …` cannot run.
  - Live: grpcurl returned the seeded row, `dolt_version()` returned 1.86.1,
    SIGINT stopped both runs, and the negative run showed orders' own error.

### 2026-11 — LLO v0.29.0: guest output reaches the operator (`cloister-164236`, `cloister-edec62`)

- **Pins.** Every ley-line-open channel moves to v0.29.0 (1e811a9a), via
  `scripts/llo-bump.mjs`. The krun worker is pinned at 0ff3aba8…, which
  matches the release. confinement/v1 is unchanged.
  - The execution/v1 vectors are re-synced; `rootfs-manifest.json` is new.
  - The generated `llo-execution-tools.json` gains `ProvisionOutput.casRoot`.
    The generated schema requires it, so a provision reply from an older LLO
    is now refused (tested).
- **Guest output.** The host runtime now waits on LLO's `RunOutcome`. When a
  run FAILS, it prints the guest's stdout and stderr tails in a block labelled
  `guest output (untrusted; shown as printed, not interpreted)`.
  - Nothing is printed on success. Nothing is printed for a stop at the
    wall-clock ceiling either: that isn't the workload failing, and a healthy
    service's stdout doesn't belong in a CI log because a deadline passed.
  - Every guest line is prefixed with `| `, so it can't pass for a host-runtime
    line. LLO already replaces control characters other than newline and tab.
    At most the last 40 lines of each stream are shown, with a count of the
    rest. The block is written under one stderr lock.
  - The reported failure is the supervisor's part of the detail only. That
    part is found by stripping exactly the suffix LLO's own
    `failure_with_output` appends for this output, never by matching headings.
    If the detail doesn't end with that suffix, it is withheld (fail closed).
  - `cluster up` relays only whole stderr lines, so a line written in pieces
    keeps its `| ` prefix.
  - A provision reply without `casRoot` is reported as an LLO daemon older
    than v0.29.0.
  - The output never changes an exit status.
  - `cluster up` shows the block under the bundle's `[name]` prefix. Live:
    with the connection removed, `up` printed orders' own `seed: database did
    not answer within 30s: dial tcp 127.0.0.1:3306: connect: connection
    refused`.
- **`/tmp`.** Every guest now has a tmpfs `/tmp`, so the demo's Dolt image no
  longer ships a `tmp/` placeholder (it keeps `/data`). The docs that said to
  ship one are updated.
- **Early connections.** A serve channel now holds a connection that arrives
  before the workload listens, for up to 10 s. cloister's behaviour is
  unchanged; the docs that described the old EOF are updated.
- Still open in LLO: d4b07f (double quotes in argv), cffbb5, f963e6, e6b1bb.

### 2026-11 — `cluster up`: cluster.toml in, running microVMs out (`cloister-991e65`)

- **Lock records the rootfs.** `cloister runtime import --bundle <b> [--dir]
  --layout <oci-layout>` imports the image the lock pins. `--image` is derived
  from the lock, and must equal it if given. The command writes
  `[inputs.<b>.oci] rootfs = "blake3-256:…"`, plus `rootfsSymlinks` when the
  mode isn't `refuse`. It is idempotent. `cluster resolve` carries the rootfs
  forward while the image digest is unchanged.
- **`runtime plan` emits runnable microvm plans.** The artifact is the
  recorded rootfs, never the `sha256:` image. A missing rootfs, or one absent
  from the CAS, is refused with the exact import command. Process plans are
  unchanged. A new `--dir` flag is added.
- **`cloister cluster up --env <env> [--dir]`** starts every microvm-placed
  bundle.
  - Order: targets before sources; a cycle is refused by name.
  - A bundle is "bound" when its bind sockets exist. Health isn't checked, so
    `up` never calls it ready ([ADR-0071](docs/adr/0071-who-owns-a-running-workload.md) §3; health-gated start is a later slice).
  - Each `up` gets a fresh 0700 channel directory under the real `/tmp`. Each
    exposed port's `unix://` path is printed. The directory is removed on exit.
  - Runs in the foreground. SIGINT/SIGTERM stops runs in reverse order. A run
    that ends on its own tears the rest down and is reported with its status.
  - Without `--env`, `cluster up` is the unchanged compose path.
- **The wall-clock ceiling is reported as the ceiling.** When LLO stops a run
  at its deadline, `cloister-host-runtime run` exits 124 (`timeout(1)`'s
  status) instead of 1. It does this by matching LLO's `ResourceExhausted`
  code, not its text. `cluster up` reports the stop as the ceiling being
  reached rather than as a workload failure, and exits 124. Each run's
  ceiling is printed when it starts. Services are stopped after 15 minutes
  until ley-line-open-e6b1bb.
- **Host runtime stops its guest on a stop request.** The krun worker runs in
  its own process group, so a killed host runtime used to orphan the VM.
  - SIGINT, SIGTERM, SIGHUP and SIGQUIT now cancel the run through LLO.
  - So does EOF on stdin, when run with `--stop-on-stdin-eof` (which `cluster
    up` passes, so `up` dying stops its runs).
  - A stop that arrives while LLO is still starting the run waits for start
    to settle, then cancels.
  - Only a real cancel is reported as "stopped".
  - Messages on the stop path never panic on a closed stderr. `eprintln!` did,
    which meant that after `kill -9` of `up` the host runtimes kept running.
    Seen live, then fixed.
  - The run exits 128+signal.
  - Not covered until ley-line-open-f963e6: a host runtime that is itself
    SIGKILLed can still leave its worker running.
- **`cluster up` teardown is robust** (#287 review).
  - Stop handlers stay installed until teardown ends.
  - A second signal reports progress; a third SIGKILLs the host runtimes and
    names the f963e6 risk.
  - SIGHUP, SIGQUIT, an uncaught error and EPIPE on stdout all tear down.
  - Any run ending on its own, including during a later bundle's start, stops
    everything and makes the exit non-zero.
- **The rootfs is bound to its image by value.** The lock records
  `rootfsImage`. Plan and up refuse a rootfs imported from a different image
  than the current pin.
  - Every lock regeneration (`cluster resolve`, `cloister add`, the demo pin)
    goes through one writer that carries the rootfs and writes atomically.
    `add` used to erase it.
  - `runtime import` re-reads the lock after importing and refuses if the pin
    moved.
  - A bundle pinned only through `[[inputs.*.ociBundles]]` is refused by name.
- **Demo:** `tools/dolt-grpc-demo/microvm/`. `build.sh` builds both images as
  OCI layouts (scratch images, no symlinks; dolt 1.86.1 fetched with a pinned
  sha256), pins their digests into a generated, gitignored lock, and imports
  them. `cluster up` then serves the gRPC row from Dolt over the declared
  connection.

### 2026-11 — Restore the wall-time ceiling; test against LLO's own validation (`cloister-991e65`)

- #285 removed cloister's 15-minute wall-time default by sending zero. LLO
  refuses a zero wall time ("wall_time_ms must be non-zero"), so every microVM
  launch on main failed. This restores the default.
- The gap that let it through: the tests used a recording stub, which never
  ran LLO's request validation. A new test drives the real libkrun backend
  with a missing worker, so a request LLO would call invalid fails the test.
- A service still stops after 15 minutes. Running one with no ceiling needs LLO
  to accept that (`ley-line-open-e6b1bb`).

### 2026-11 — Placements, the strength rail, and `cloister cluster k8s` (`cloister-991e65`)

- **Schema.**
  - `Bundle.placements @11 :List(PlacementSpec)` holds `{env, kind, manifest}`
    rows (TOML: `[[bundles.placements]]`). Kinds are microvm, workerd,
    kubernetes and cloudRun.
  - `ConnectionSpec.minStrength @4` is one of "", none, policy, capability.
  - Both are append-only. ADR-0070 §2 is amended to the list form.
  - A bundle with no rows and `executionMode = "microvm"` is placed `microvm`
    everywhere, so existing clusters lower unchanged.
- **Build-time checks**, refused by name:
  - a duplicate env;
  - an unknown kind;
  - `microvm` without `executionMode = "microvm"`;
  - `kubernetes` without a manifest, or a manifest on a constructed kind;
  - a non-relative manifest path;
  - a connection end unplaced in the env, or placed a kind no emitter lowers.
    #283's "channel ends are external microvm bundles" rule generalises to
    "placed `microvm` or `kubernetes`". An exposed port needs at least one
    such placement.
- **Strength rail (ADR-0070 §3).** microvm = capability, kubernetes = policy,
  everything else = none. An edge is as strong as its weaker end, and below
  its `minStrength` the build fails, naming the connection, the env, both
  placements and the computed strength.
- **`cloister cluster k8s --env <name> --out <dir> [--dir <cluster>]`.** For
  each bundle placed `kubernetes`, it checks the rendered manifest's one
  Service against the declared ports (name, number, `appProtocol`) and copies
  the manifest unchanged. It adds a per-bundle Namespace, a
  default-deny-ingress NetworkPolicy, and an allow policy per declared
  connection.
  - Refused: namespace conflicts, a missing or mismatched Service port, edges
    across placements (they need LLO's broker, `ley-line-open-e2c5ce`), and
    unlowered kinds.
  - A stale file already in `--out` is refused, not deleted.
- **Demo.** `tools/dolt-grpc-demo/` gains a distroless Dockerfile and a
  `k8s/` fixture: Dolt 1.86.1 pinned by index digest, plus orders and a
  `cluster.toml` with `minStrength = "policy"`. The README lists the kind
  commands for a positive check (grpcurl) and a negative one (an intruder
  namespace's `nc` must fail).
- Adds the `yaml` dependency (2.9.1), required because `lint:structured-parse`
  forbids hand-matching YAML.
- No env lowering yet: the operator's manifest carries the address.

### 2026-11 — Declared ports and connections lower to §6 grants (`cloister-991e65`)

- **Schema.** `Bundle.ports @10 :List(PortSpec)` and
  `Cluster.connections @8 :List(ConnectionSpec)`, append-only. In TOML these
  are `[[bundles.ports]]` and `[[connections]]` with one
  `[[connections.targets]]` row per `env` (ADR-0069, amended to the list form
  because capnp has no maps). `ConnectionSpec` is a different thing from
  ADR-0051's `Connection`. Only the `bundle` target kind exists so far.
- **Build-time checks** in `toml-to-cluster`, each refused by name:
  - per bundle: port names unique (a-z, 0-9, hyphen), port non-zero and
    unique, `expose` one of `none` / `cluster` / `edge`;
  - per connection: `from` declared, (from, name) unique, at least one target,
    `env` unique, target bundle declared and not `from`, target port exists
    and is exposed, and the `appProtocol`s match.
  - Labels use the one ADR-0030 §A4 validator, now in `cli/lib/app-protocol.mjs`.
    `art.mysql` joins the blessed set.
- **`cloister runtime plan --env <name> --channel-dir <abs>`** lowers a
  microvm bundle's exposed ports to `bind` grants and its connections to
  connect grants, both with `guestPort`, on `<channel-dir>/<bundle>.<port>.sock`.
  The two ends of an edge get the same path, so two plans join with no broker.
  - Refused: no target for `--env`, a guest port used twice (no auto-shift,
    because plans carry no workload env yet), a socket path over 103 bytes,
    ports or connections on a `process` bundle, and a target that is not a
    microvm bundle.
  - Plans for bundles with no declarations are byte-identical to before.
- **Review hardening.**
  - `runtime plan` parses `cluster.toml` with `parseTomlToCluster`, the same
    strict pipeline as `cluster:toml`. There is no second, looser parse path.
  - Build time refuses:
    - an exposed port or a connection end on any bundle that isn't an external
      `microvm` bundle (so ADR-0069 §3's no-SQL-from-workerd rule is
      structural);
    - a hand-written `confinement.unixSocket`, and any other unknown
      `confinement` or `[bundles.external]` key, which used to be dropped
      silently;
    - a channel-endpoint bundle whose name isn't a DNS label;
    - a duplicate edge.
  - `--channel-dir` refuses a trailing slash.
  - The host runtime creates missing bind-grant directories (0700) before
    launch, because LLO refuses a missing one.
  - The emitted dolt/orders plans are committed as
    `test/fixtures/runtime-plan/`, and both the JS emitter and the Rust parser
    test against them.
  - `cluster-to-toml` drops only empty scalars from port and connection rows.
  - New rail: `lint:conflict-markers`.
- Not built: forwarded placements, the strength rail, env lowering, and an env
  registry for ADR-0069's "resolves for every env" rail (ADR-0070 "What exists
  today").

### 2026-11 — Two microVMs over a declared edge: gRPC in one, Dolt in the other (`cloister-991e65`)

- **`tools/dolt-grpc-demo`** is a static Go gRPC service. It dials its database
  at `127.0.0.1:3306` and serves on `127.0.0.1:50051`, both guest loopback
  ports presented by §6 `guestPort` grants.
- **Verified live** on darwin-arm64 with LLO v0.28.0 and hijacking off.
  `grpcurl` on the host calls the service in microVM B. The service answers
  with a row it read from `dolt sql-server` in microVM A, over a connect grant
  on A's socket. No broker is involved.
- **Negative case.** The same service without that connect grant exits with
  its "database did not answer" code, and the host gets no reply.
- **Not yet done.** Launch plans and CAS rootfs are still written by hand. The
  `runtime plan` lowering of `cluster.toml` connections is the next step
  (ADR-0070 §4).

### 2026-11 — LLO v0.28.0: declared channels reach unmodified workloads; Dolt served over one (`cloister-da1a59`)

- **Pins.** Every ley-line-open channel moves to v0.28.0 (dafd2976). The krun
  worker is pinned at 52969c3c…, which matches SHA256SUMS. confinement/v1
  changed only in §6, additively (`guestPort`), so the mirrored dimensions are
  unchanged.
- **`guestPort`.** A launch plan's §6 grant can carry one. With connect, the
  workload dials `127.0.0.1:guestPort` and reaches exactly that peer. With
  `bind`, it listens there and only that channel reaches it. The port is in the
  attested document.
  - Plans are refused by name, before LLO sees them, for port 0,
    connect-bind with a port, and a port presented twice.
  - Tests run LLO's own fold over the carried document and show the port is
    part of the digest.
- **`tools/edge-probe` is plain std::net** (no vsock). Live on darwin-arm64:
  - it dialed its declared peer and served on its declared port;
  - undeclared loopback ports were refused;
  - TCP to anything else was unreachable, and UDP was denied;
  - interfaces were `lo` and `dummy0`.
- **Dolt `sql-server`** (static linux-arm64 1.86.1) ran in a microVM with one
  §6 bind grant on guestPort 3306. The host's stock `mysql` client, connecting
  over the declared UNIX socket, created a database, wrote a row and read it
  back.
  - Needed: the guest has no `/tmp`, so the rootfs ships `data/` and `tmp/`
    placeholders.
  - Until LLO a915e3 ships, a connect before the workload listens is accepted
    and then closed, so clients retry on EOF.

### 2026-11 — `cloister runtime import`: OCI image → microVM rootfs (`cloister-3a6dd7`)

- `cloister runtime import --layout DIR --image sha256:…` imports a
  digest-pinned OCI image layout into the microVM store through LLO's importer
  (`import_oci_layout`, in-process in the host runtime, not a subprocess). It
  prints LLO's import record, whose `rootfs` is the plan's `blake3-256:`
  digest. Tags are refused. Re-importing gives the same digest.
- Live on darwin-arm64 (LLO v0.27.0): `hello-world@sha256:c567b231…` imported
  and booted. This is the first boot of an import-oci rootfs. Its root-level
  `/hello` entrypoint exits 127 because LLO execs it as a bare name when no
  workspace is mounted (ley-line-open-fe130c). The same bytes under `bin/`
  exit 0.
- None of the first-party images cloister pins import yet. LLO's carries a
  `dev/console` device (ley-line-open-fe3d26), and mache and rosary carry
  dangling symlinks (ley-line-open-391965).

### 2026-11 — a declared channel, and no other: §6 grants reach the microVM (`cloister-bb0142`)

- A host-runtime launch plan can declare confinement/v1 §6 socket grants
  (`confinement.unixSocket.allow[]`, mode empty = connect, `bind`, or
  `connect-bind`). The execution adapter builds the confinement document with
  LLO's own compiler over the same deployment inputs the worker uses, adds the
  grants, and sends it with its digest. LLO folds §6 in and requires the
  documents to be equal, so they match by construction.
- Live on darwin-arm64 with LLO's v0.26.0 worker (hijacking off), the guest
  served on its one declared vsock port and the host reached it through the
  declared UNIX path. Every other way out failed: undeclared vsock ports had no
  answer, a guest-originated dial on the serve port was reset, and TCP and UDP
  reported "network unreachable" (interfaces: `lo`, `dummy0`).
  `tools/edge-probe` is the guest that ran it.
- Socket paths longer than the platform's `sun_path` are refused by name.
  libkrun only warns when it cannot bind one, so the channel would silently
  not exist (ley-line-open-bb2143).

### 2026-11 — runtime docs and CLI stop describing krunvm (`cloister-a4e446`)

- GETTING-STARTED's microVM path described the krunvm runtime that
  cloister-17e502 retired: a krunvm + Buildah prerequisite, a sparsebundle
  storage step, and `sha256:` OCI plans. It now describes what runs:
  `brew install libkrunfw`, `cloister runtime install`, and a plan over a
  `blake3-256:` root filesystem in the store. It also says plainly that OCI
  images wait on LLO's import-oci and that grants are refused by name until
  they are mapped.
- `cloister runtime storage gc` and `task runtime:storage:gc` are removed. Both
  failed with "managed krunvm's buildah storage, which cloister no longer
  uses".
- `cloister runtime storage init` without the LLO provider no longer creates a
  sparsebundle that nothing reads. It refuses and names `cloister runtime
  install`. The LLO-provider path is unchanged.
- `cloister runtime storage status` on the compatibility provider reports the
  microVM store directly instead of calling a host-runtime command that no
  longer exists.
- `doctor` labels the backend "libkrun microVM (LLO worker)". The persisted
  record identifier is unchanged, so existing installs still validate.
- The runtime-subprocess ratchet drops from 13 to 9 sites.

### 2026-11 — `runtime install` provides the microVM tier; `run` waits for the guest (`cloister-991e65`)

- `cloister runtime install` now installs LLO's `leyline-krun-worker`, a
  release asset pinned by digest in `schema-bridge.lock.json` (darwin-arm64
  only, which is the only platform LLO publishes it for). It also creates the
  content store and run roots under `~/.local/state/cloister` and records the
  libkrunfw it found, with that file's digest. Before this, the host runtime
  looked for the worker at `/usr/local/libexec` and its store under
  `/var/lib`, and nothing created either, so `doctor` reported
  `microvm: false` on every install. When this host can't have the tier,
  install says why and still installs the harness lane.
- The CLI starts the host runtime with those paths. Variables the operator
  has set explicitly still take precedence. A worker or libkrunfw whose bytes
  have changed since install is refused.
- `cloister-host-runtime run` now waits for the run to finish. It used to
  return as soon as the worker was ready, exit 0 without anyone seeing the
  guest's result, and then cancel the VM when the backend was dropped on exit.
  A guest that fails now gives `the workload ran and failed`, which is
  distinct from `launch refused`.
- `runtime doctor` prints `microVM:` / `process:` availability. It previously
  read `krunvm` / `buildah` fields that no longer exist, so it always printed
  "missing".
- `llo-bump` reads each family's platforms from the lockfile instead of a
  fixed list of four.
- Verified on darwin-arm64: `dolt version` in a microVM exits 0, and an
  unknown subcommand exits 1. Two upstream gaps were found along the way:
  libkrunfw is loaded by bare name (`ley-line-open-a267af`; worked around for
  now with `DYLD_LIBRARY_PATH`), and guest output is discarded
  (`ley-line-open-a26ad0`).

### 2026-11 — LLO's prebuilt signing wasm; pin rail covers `tools/` (`cloister-dbe9c3`, `cloister-b4d6eb`)

- The Worker now loads LLO's published `leyline_sign.wasm` instead of a local
  wasm32 build. It is digest-pinned under `"wasm"` in `schema-bridge.lock.json`
  at the same release version as the generators, fetched by `task llo:wasm`.
  `rs:sign:wasm` is removed. `cloister_cas.wasm` is still built locally until
  `ley-line-open-dbacd2` ships.
- `lint:upstream-pins` walks `tools/` as well as `rs/`.
  `tools/harness-sandbox`'s leyline-sign pin had sat at v0.7.6 while `rs/`
  moved to v0.21.1. It is now on v0.21.1.

### 2026-11 — ley-line-open v0.21.1 (`cloister-bc42d9`, `cloister-dac140`)

Every LLO channel moves from v0.18.2 (`75e3af6`) to v0.21.1 (`d11e89a8`) via
`task llo:bump`: the Cargo git deps, `[inputs.llo]`, `schema-bridge.lock.json`
(all twelve generator digests checked against the release's `SHA256SUMS`), and
`llo-execution-contract.lock.json` (the regenerated `execution.tools.json` is
byte-identical to the release asset). The execution/v1 vectors and the
confinement/v1 schema are re-vendored from the tag.

**BREAKING — execution/v1 `ResourceLimits` is the OCI shape.** `memoryBytes` /
`cpuMillis` are gone; limits are `wallTimeMs`, `outputBytes`, `memory{limit}`,
`cpu{quota, period}`, `pids{limit}`, zero meaning no ceiling. Every tier
refuses a non-zero `outputBytes`; native without a delegated cgroup root
refuses memory, cpu and pids; the microVM tier sizes whole MiB and whole vCPUs
and refuses pids. `cloister-host-runtime` requests its defaults (15 min wall
clock, 1024 MiB, 2 vCPUs) only on the dimensions the backend declares it
enforces.

**BREAKING — `cloister runtime run` refuses a daemon without the OCI limits
layout.** Before `start` it reads `llo_execution_capabilities` and requires
`cloister/execution/v1/resource-limits` at version `2`. A pre-v0.21 daemon would
read the OCI message as its old four words and drop every memory, cpu and pids
ceiling without saying so.

**BREAKING — `CLOISTER_LIBKRUN` is gone.** The LLO worker links libkrun. Grant
libkrunfw with `CLOISTER_LIBKRUNFW=<path>` (passed to the worker as a runtime
file); nothing is granted when it is unset.

**Lease certs must be Interlace-profile.** The lease gate verifies through
`leyline_verify_cert_path` with `expected_profile=1`, so a Signet-profile
(notme/signet) certificate under the lease anchor is refused instead of having
its `.1.5`/`.1.6` read as peer fingerprint and scope.

Also from v0.21.1: the native tier refuses Graph workspace grants (workspaces
are microVM-only). Cloister maps no workspace authority from a launch plan, so
nothing in cloister routes a workspace run to native.

### Shipped 2026-08-05

**BREAKING — the confinement digest changed twice. Re-mint dev certs.**

`cli/lib/harness/launch.mjs`'s confinement/v1 document changed shape, so the
`confinementDigest` committed into every previously-minted cert no longer
matches what the runner recomputes. The failure surfaces at exec time as an §8
commitment mismatch, far from the cause — hence the shout. Re-run
`task harness:dev` (or `cloister run`) to mint against the new shape; nothing
else is needed, and no production credential is affected (these are dev certs).

Two independent fixes, both found by running cloister's document through a
conforming runner rather than by any check in cloister:

- **`credentialSource: "vault://<service>"` removed** (`cloister-d2ba07`).
  `vault://` is not one of the six schemes §5 closes over — at any spec version
  — so every document cloister issued was refused at parse. The field is
  removed rather than corrected: a harness authenticates against no keystore,
  because the vault proxy injects the credential as a header and the process
  never holds it. §5: "A bundle needing no credentials omits the field."
- **`fs.allow` roots are now absolute** (`cloister-bd6399`):
  `workspace` → `/run/cloister/workspace/`. §2 requires absolute paths. The
  symbolic names stay symbolic — nothing resolves them on this plane, real
  directories travel on the nono manifest — following LLO's own
  `ATTESTED_RUN_ROOTFS` pattern, so per-repo digest stability survives.

**BREAKING — `cloister-host-runtime` needs `--features llo-execution` to
execute anything.**

The default build links no execution backend and refuses with a message naming
the feature. ley-line-open's runtime uses nono as its enforcement mechanism, so
depending on it unconditionally pulled the sigstore / aws-lc-rs / rustls closure
into the default dep graph — reopening threat model §17.1, which had closed
exactly that expansion. Detected by `cargo deny` (a license rejection on
`webpki-root-certs`), not by tests, because the code was correct and the closure
was the problem.

**BREAKING — `cloister-host-runtime status` and `gc` are retired.**

Both managed krunvm's buildah storage volume, which no longer exists. They fail
with a reason naming the replacement rather than "unknown command", so a script
calling them learns what happened.

### Also shipped

- **ley-line-open v0.15.1 → v0.17.0** across every channel, plus
  `task llo:bump` (`cloister-464216`) — the bump was 11 manual steps behind a
  rail that already enumerated all of them.
- **krunvm shell-out deleted** (`cloister-17e502`); cloister calls LLO's
  first-party execution API in-process. No PATH dependency on `krunvm` /
  `buildah`, and no "command not found" standing in for "this workload is not
  confined".
- **Content origin on receipts** (ADR-0065, `cloister-16f81c`). A receipt now
  commits to *what content was used*, not only *which bytes moved* — as a
  digest, so the set is disclosed under scope rather than published in a
  response header. Threat model §21.
- **The macOS unenforced-bind hole is closed** (`cloister-2d420c`). The harness
  was asking nono for `ports.localhost` — a bidirectional IPC grant — when it
  only ever dials the shim. It now asks for connect-only, and
  `CLOISTER_ACCEPT_UNENFORCED_BIND` is gone.
- **The confinement mirror is current and railed** (`cloister-d303b2`).
  `manifest/cluster.capnp` declared `confinement/v1 @ v0.7.3` against a v0.17.0
  tree; ~20 section citations had silently gone stale. `lint:spec-citation` now
  compares a mirror's declared version against the pinned one.
- New ADRs: 0064 (harness credential env by auth mode), 0065 (receipts carry an
  origin set), 0066 (what a notme WIMSE URI names).
- New rails: `lint:origin-derivation`, mirror-version agreement, Inv 11 §5, and
  a fix to `lint:sibling-bead-refs` whose error message documented a clearance
  path the code never implemented.
- **`task install` now needs the Cap'n Proto compiler and its standard
  schemas** (`cloister-28f440`). Building `cloister-host-runtime` with
  `--features llo-execution` pulls `capnp-json`, whose build script runs
  `capnp compile` on a schema importing `/capnp/c++.capnp`. On Debian/Ubuntu
  that is two packages — `capnproto` (the compiler) and `libcapnp-dev` (the
  schemas); `brew install capnp` carries both. The README names them, the
  clean-image install test installs them, and the `verify` CI job — which had
  the compiler but not the schemas — installs `libcapnp-dev`.

### Shipped 2026-07-15

- **`tools/schema-bridge/` deleted; the capnp→zod/go codegen plugin is
  consumed from LLO's `leyline-schema-bridge`** (`cloister-a7346b`,
  cloister-side of LLO PR #222 / `ley-line-open-0806dc`, ADR-0036 Phase
  2). LLO's `rs/ll-open/schema-bridge/` now hosts the crate; the two
  plugin binaries keep their names verbatim (`capnpc-schema-bridge-zod`
  / `capnpc-schema-bridge-go` — capnp's `-o<plugin>` argv[0] PATH
  dispatch). Cloister pulls it via a git dep pinned by SHA
  (`e8a501b`, v0.7.9) in `rs/crates/cas/Cargo.toml`, the same workspace
  anchor that carries `leyline-sign`; `task schema-bridge:build` now
  runs `cargo build -p leyline-schema-bridge --bin …` into
  `rs/target/release/` (the `leyline-sign-helper` pattern), and the
  `cluster:*` / `identity:*` Taskfile targets `-o` those paths. The
  upstream plugin (capnp `=0.25.0`) produces **byte-identical** zod +
  go output to the deleted vendored copy (capnp `0.24`) for both
  `cluster.capnp` and `identity.capnp` — proven by diff before deletion.
  - `tools/schema-bridge/scripts/verify-go.sh` → `scripts/verify-go.sh`
    (NOT lifted to LLO — it orchestrates cloister's own cluster const +
    `go.mod`; deliberately cloister-repo-local).

### Shipped 2026-07-09

- **`rs/crates/sign` deleted; cloister depends on LLO's canonical
  `leyline-sign`** (`cloister-8f4d3f`, cloister-side of LLO PR #160 /
  `ley-line-open-7226e3`). LLO's `rs/ll-open/sign/` now hosts the
  crate — the wasm32 verifier, the ADR-0019 host feature, and the
  `leyline-sign-helper` binary. Cloister pulls it via a git dep
  pinned by SHA in `rs/crates/cas/Cargo.toml`. The build outputs
  cloister depends on (`rs/target/wasm32-unknown-unknown/release/leyline_sign.wasm`
  + the native `leyline-sign-helper` binary) are byte-identical to
  the pre-consolidation fork — cargo builds the LLO crate at the
  same target paths, so `src/wire/signet-verify.ts` needs no code
  change. See ADR-0045 Follow-up.
  - `lint:cargo-pins` (+ its script + test) deleted — LLO enforces
    the ADR-0019 `ed25519-dalek ~2.1` tilde-pin upstream.
  - `rs/README.md`, ADR-0045 marked Accepted with the deletion set.
  - `crates/cas/Cargo.toml` doubles as the workspace anchor for both
    LLO git deps (leyline-cas-ffi + leyline-sign). `host` feature is
    enabled via a `cfg(not(target_arch = "wasm32"))` target-dep row
    so the wasm build path stays free of the tokio/mio/keyring
    closure while native builds get the host closure the
    `leyline-sign-helper` binary needs.

- **`cloister-spec/` deleted; substrate IDL consumed from LLO's
  `leyline-schema-spec`** (`cloister-a77222`, cloister-side of LLO PR
  #159 / `ley-line-open-729a7e`). LLO's `rs/ll-core/schema-spec/` now
  hosts the canonical `_traits.capnp`, `_capability-mapping.md`,
  `credential-isolation/v1`, `build-cache/v1`, `mcp-tool/v1` (plus
  VECTORS.sha256 gates and the Python reference-implementation
  conformance suite) — byte-identical to what cloister-spec/ shipped,
  now enforced by the `verify_vectors_sha256` test on the
  `leyline-schema-spec` crate. Cloister no longer runs the drift
  gates locally.
  - `.github/workflows/credential-isolation-spec-drift.yml` — deleted
    (LLO's cargo test owns the digest + version-bump check).
  - `Taskfile.yml` — `lint:capability-mapping-coverage` +
    `verify:cred-iso-conformance` deleted.
  - `scripts/lint-capability-mapping-coverage.mjs` + its test — deleted.
  - `scripts/resolve-inputs.mjs` + `scripts/lint-capability-scheme.mjs`
    — spec-path comments retargeted at `leyline-schema-spec/*`.
  - `src/routes/*` + `src/storage/*` + `test/**/*` — spec-path
    comments retargeted at `leyline-schema-spec/*`.
  - Docs (`CLAUDE.md`, `docs/STATUS.md`, `docs/ARCHITECTURE.md`,
    `docs/plans/credential-isolation-capability.md`,
    `docs/reference/task-done.md`, `docs/tenants/mache-mcp.md`,
    `docs/integration/*`, `docs/security/threat-model.md`,
    `interlace-spec/0.1.0/README.md`) — spec-path references
    retargeted; `docs/integration/authoring-server-json.md` links
    rewritten from relative paths to LLO GitHub URLs so
    `lint:doc-links` stays green.

### Shipped 2026-06-25

Two parallel workstreams: ADR-0036 schema-bridge Phase 1 (multi-output
IR generalization) and vault security fixes migrated from notme after
notme retired its vault.

- **ADR-0036 Phase 1 — schema-bridge multi-output IR** (`cloister-7536e7`
  epic, all 5 sub-beads closed):
  - A (`cloister-7585bc`) — output multiplexer in `tools/schema-bridge`;
    per-binary-name dispatch (`capnpc-schema-bridge-{zod,go}`) mirrors
    capnpc-rust/go/c++ convention. argv[0] basename selects format.
  - B (`cloister-75f6d5`) — Go emitter v1 (types + json tags). New
    `tools/schema-bridge/src/outputs/go.rs`; covers struct, enum, list,
    named/anonymous unions, void variants, consts.
  - C (`cloister-765d83`) — Void-variant Marshal/Unmarshal closes the
    wire-fidelity gap where Go's default encoder turned `*struct{}{}`
    into `{}` instead of capnp's canonical `null`. Emitted only when
    needed (union has at least one Void variant); payload-only unions
    skip the custom marshalers.
  - D (`cloister-76a9ea`) — `task cluster:go` + `cluster:go:check-drift`
    + `cluster:go:verify` round-trip gate. New `go.mod` at repo root +
    `pkg/cluster/cluster.go` (committed generated artifact) +
    `tools/schema-bridge/scripts/verify-go.sh`.
  - E (`cloister-77172d`) — second-schema proof; vendored notme's
    `manifest/identity.capnp`. Surfaced two IR/parser gaps closed
    in this bead: (a) skip top-level annotation DECLARATION nodes
    (from `import "/go.capnp"`); (b) emit anonymous-inline unions
    (`struct Foo { union { … } }` — flat shape). Promotes one README
    `#[ignore]`'d stub to active. `pkg/identity/identity.go` +
    `src/generated/identity.zod.ts` committed; `identity:{zod,go}` +
    `:check-drift` tasks landed.
  - ADR-0036 Amendment 2026-06-25 records three execution-time scope
    corrections (C required not optional; MarshalCBOR out-of-scope;
    IR gaps closed during E).
  - 4 emit drift gates green; 1 round-trip verify gate green.

- **Vault security migration from notme** (notme-9af5dd retired
  notme/vault → cloister is canonical). 8 notme/vault beads triaged;
  6 P1 + 2 P2:
  - 3 P1s already-fixed/N/A in cloister, closed with evidence
    (cloister-faa2a2 proxyRequest sub-pass; cloister-fcb3fc 404/403
    oracle collapse; cloister-fc4bc1 DPoP audience N/A — cloister
    uses leases).
  - cloister-fb1ea2 — 8 vault denial sites now emit structured
    `buildDenialAuditEntry` audit logs (bucketed cardinality on
    subjectFp + callerSub). Wire body stays constant-shape per §9.4.b.
  - cloister-fbc6eb — `VAULT_KEK_SOURCE` spec is pinned to DO storage
    on first resolve; mismatch throws on subsequent derive. Blocks
    the config-write attack where an attacker swaps `keychain://` for
    `env://ATTACKER` between DO evictions.
  - cloister-1d2e89 (P2 → P2 in cloister) — pre-auth IP burst limit
    (`src/routes/pre-auth-budget.ts`) runs BEFORE `verifyAndUpsertLease`
    on the vault-proxy-route. CF-Connecting-IP-keyed in-memory token
    bucket per isolate (CAPACITY=300, REFILL=10/s, LRU-evicted at
    10k IPs). Prevents lease-verify DoS amplification.
  - cloister-1d952e (P3) — wire `op://` + `apple-password://` +
    `keyring://` + `secret-tool://` KEK schemes via the existing
    `KEK_HELPER` sidecar (ADR-0019). `HELPER_SCHEMES` const introduced
    as single source of truth for the dispatch table.

- **New deferred-design beads filed**:
  - cloister-f34e2e (P3) — vault in-cluster bundle identity propagation
    (a/b/c decision); deferred-design with re-open trigger tied to
    the first in-cluster bundle Worker landing.

### Shipped 2026-06-22 – 2026-06-24

Multi-cycle session covering an adversarial-cycle close-out, two new
ADRs, the BeadStore-DO migration foundation, and three new
substrate-property lint invariants.

- **Adversarial cycle 2026-06-22 close-out** (`cloister-92e846` parent +
  C1-C7 sub-beads) — §13.7.6 oracle posture fully closed:
  - C3 (`cloister-9339c0`): `tenant-dispatch` unwired-binding warn
    throttled to one emit per binding + tenant name elided from log
    channel
  - C5 (`cloister-938b32`): vault decrypt-error `bundleIdName` replaced
    with stable FNV-1a fingerprint + defensive redaction in
    `error_message`
  - C6 (`cloister-93b0c2`): new `scripts/lint-vault-id-source.mjs`
    forward-guard against `.newUniqueId()` on vault source files (per
    ADR-0021)
  - §13.7.6(b): path-prefix scan converted to full-walk
    first-match-precedence (no early break)
  - §13.7.6(c): `match()` + `handle()` share a per-request WeakMap
    cache — matched requests cost exactly one scan
  - C7 (`cloister-93d674`): §13.7.8 + §13.7.3 + §13.7.7 residual-posture
    roll-up (boot-time config error channel; service-tier
    consumer-aspiration framing; Inv 6 no-op on empty inputs)

- **ADR-0033 — bd substrate binding** (`cloister-9d19e3`,
  [ADR-0033](docs/adr/0033-bd-substrate-binding.md)) — rsry IS the MCP
  server for the bead substrate; bd is the storage layer rsry consumes
  underneath. Cloister-Worker reaches the bead substrate via a new
  `rsry_*` `mcpProxy` backend routing to the existing rosary bundle.
  No new bundle, no new wire, no MySQL in workerd. Multi-substrate
  framing made explicit. Amendment 2026-06-23 corrects an early-draft
  bd-has-MCP-server assumption after verifying against `bd 1.0.0`.

- **ADR-0034 — multi-tenant access spec across the ecosystem**
  (`cloister-cbfd7f`,
  [ADR-0034](docs/adr/0034-multi-tenant-access-spec.md)) — classifies
  rosary / mache / ley-line / notme / signet by required-vs-deferred
  for true-multi-tenant deployments. Spawns 5 sub-beads for the
  in-scope work (3 cloister-side, 1 notme, 1 mache).

- **cloister-c8b907 BeadStore-DO deprecation migration** — three
  sub-beads delivered:
  - Sub-bead 1 (`cloister-dea77c`): TrustStore `peer_attestations`
    gains a `bead_id TEXT NULL` column + partial index + ALTER TABLE
    migration. New `attestationsForBead(sql, beadId)` helper. The
    §13.4 audit chain now reconstitutes via a JOIN on `bead_id` —
    rsry/bd-stored beads have no `content_hash` of their own, but
    the TrustStore attestation row links them back.
  - Sub-bead 2 (`cloister-decf0d`): `BEAD_STORAGE_BACKEND` env var
    routes the `bead_create` orchestrator's Step 2 between
    BeadStore DO (`"do"`, default) and rsry's `rsry_bead_create`
    over `ROSARY_BUNDLE` (`"rsry"`). Both paths thread the new
    bead_id into Step 3's attestation row. Operators can opt in
    today; default flip stays deferred.
  - Sub-bead 3 prep (`cloister-f34f7b`): one-shot structured
    deprecation warning (`event: "bead_create.legacy_backend"`)
    when an operator runs on the legacy path. Per-isolate module
    flag prevents log spam.

- **cloister-cedcf3 perTenant + Inv 7/8/9 lint coverage** (ADR-0034
  §Sequencing item #3) — operator-facing multi-tenant substrate:
  - Phase 1: `perTenant: Bool` field on `BundleSpec` in
    `manifest/cluster.capnp` + `cluster.zod.ts` regen. Back-compat
    via `unflattenBundleKind` default; existing cluster.toml parses
    without modification.
  - Inv 7 (`cloister-ce936e`): tenantDispatch row ↔ workerd-id
    alignment via input.tenancy.workerdId. Skipped on empty
    `inputs[]` (recipe-shape leniency).
  - Inv 8 (`cloister-cedcf3` Phase 2 piece 1): `perTenant = true`
    bundle MUST have a `tenantDispatch` route declared.
  - Inv 9 (`cloister-cedcf3` Phase 2 piece 3): perTenant bundle MUST
    be the `to` of at least one `[[wires]]` entry whose binding is
    referenced by a `tenantDispatch` row (the full chain
    `tenantDispatch row.binding → wire → bundle`).
  - emit-compose surfaces `perTenant=true` as a `cloister.per-tenant`
    container label (Phase 2 piece 2 — per-tenant container
    splitting — deferred for naming/volume design).

- **Threat-model §13.8 entries** — new bd-substrate binding section
  covering UDS perimeter (§13.8.1), rsry↔bd Dolt storage boundary
  (§13.8.2), the BeadStore-DO migration audit-chain reconstitution
  (§13.8.3, with the operator-facing SQL query), multi-tenant
  coexistence with ADR-0030 (§13.8.4). Summary table cross-links to
  the migration sub-beads + lint invariants.

- **Documentation + manifest plumbing**:
  - New `docs/reference/tenancy-model.md` — operator-facing model of
    the two existing tenancy primitives (per-input + per-route) and
    how Inv 7/8/9 enforce their composition
  - New `docs/tenants/rsry-mcp.md` — operator-facing tenant doc for
    the new `rsry_*` backend
  - New `recipes/multi-tenant-smoke/` — smallest demonstration of the
    `tenantDispatch` routing primitive
  - `task lint` deps extended with `cluster:zod:verify` — closes the
    drift gap where schema-vs-runtime mismatch only surfaced under
    `task verify`
  - Bidi pipeline supports the new `tenantDispatch` route variant +
    `perTenant` field via `scripts/emit-cloister-capnp.mjs` +
    `scripts/toml-to-cluster.mjs` + roundtrip tests

- **Test coverage** — 60+ new tests across 8 new test files (manifest
  rsry-backend pin, rsry e2e, recipe→instantiate pipeline,
  peer-attestations bead_id, orchestrator backend dispatch, rsry-mode
  integration, multi-tenant smoke, recipe-multi-tenant integration).
  Total: 84 test files / 1290 vitest + ~290 node:test, all green
  through every commit.

- **Cross-repo carry-overs cleaned up** (`cloister-a2809a` closed —
  LLO `lsp_*` route shipped via manifest-driven mcpProxy; LLO ticket
  marked retired with cross-link).

- **Bundle-type drift gate** (`cloister-204ac9`,
  [src/manifest/bundle-drift-guard.ts](src/manifest/bundle-drift-guard.ts)) —
  compile-time mutual-assignability check between the hand-maintained
  `Bundle` / `WorkerdBundle` / `ExternalBundle` interfaces in
  `src/manifest/cluster-types.ts` and the schema-bridge-generated
  counterparts in `src/generated/cluster.zod.ts`. `task lint`'s tsc
  pass fails fast on field-level divergence. `Normalize<T>` recurses
  `ReadonlyArray<X>` → `X[]` and strips property-level readonly so
  the gate ignores readonly-vs-mutable drift (818f2b half 1 has
  since landed schema-bridge readonly emit, commit `eac436e`;
  `Normalize<T>` stays as defense-in-depth). Full consolidation
  (delete `cluster-types.ts`) deferred until 818f2b half 2 (JSDoc
  carry-through) lands.

- **Stale tenant-doc cleanup** (`cloister-cedcf3` doc-hygiene sweep) —
  `docs/tenants/ley-line-mcp.md` deleted (orphaned: documented a
  `leyline-lifecycle` backend that no longer exists in
  `cloister.capnp` after the `[inputs.llo]` migration). Stale
  `lsp-mcp.md` row removed from `docs/tenants/README.md` (broken
  link since PR #94); replaced with a one-paragraph footnote
  explaining that `lsp_*` + `reparse` / `enrich` / `status` arrive
  via the lockfile→backend emitter as a `generatedBackend` keyed off
  `[inputs.llo]`, not as a hand-coded tenant. `task lint:tenant-docs`
  still reports 4 docs accounted for — no drift introduced.

- **LLO contract recovery** (commit `a062dd0`) — the committed
  `cluster.lock.toml` had drifted to a stale snapshot of LLO's
  `server.json` (bytes=1_213, 3 groups under
  `_meta.art.cloister/v1.groups[]`) while the on-disk source had
  advanced to v0.5.0 / 2603 bytes / 7 groups. Result: the
  `src/generated/manifest.ts` emitted to production silently
  dropped FOUR entire groups (`query`, `wire`, `validate`, `hdc`)
  and truncated `lifecycle` (missing `snapshot`) + `sheaf`
  (1-of-6 claims). The `query` group's 16 LLO TABLE_CONTRACT
  nodes-surface tools (`get_node`, `inspect_symbol`, `at_position`,
  `inspect_neighborhood`, `search_symbols`, `read_content`,
  `find_callers/defs/callees`, `get_refs_map`, `get_defs_map`,
  `get_schema`, `get_db_path`, `agreement`, `query`,
  `list_children`) were unreachable through cloister's MCP face
  until an operator noticed by hand. Re-ran `task cluster:resolve`
  + `task manifest`; all 31 LLO tools now correctly claimed across
  7 `mcpProxy` backends bound to `LSP_MCP` / `LLO_MCP_URL`.

- **Lockfile-drift lint** (commits `33c140b` + `baacdd7`) — the
  forward-guard against another LLO-contract incident.
  [`scripts/lint-lockfile-drift.mjs`](scripts/lint-lockfile-drift.mjs)
  parses `cluster.toml` + `cluster.lock.toml`, hashes each
  `file://`-resourced input on disk, and fails with a per-input fix
  hint (`run task cluster:resolve`) when the on-disk sha256 ≠ the
  committed digest. Wired into `task lint:lockfile-drift` + the
  `task lint` deps array + `task test:lint-scripts`. Six `node:test`
  cases cover the matrix (match / drift / lockfile-missing /
  source-missing-skip-with-warn / https-ignored / multi-input
  partial drift). `https://` + `github://` inputs are intentionally
  out of scope — their content-addressed pinning is load-bearing on
  its own; an https:// drift check is a separate decision (likely
  ADR-0026 Phase 3 + Interlace receipts).

- **Doc-links drift gate** (commit `fd1d905`) — forward-guard for the
  PR-#94 class of bug where deleting a doc leaves dangling
  `[foo](foo.md)` refs in sibling pages.
  [`scripts/lint-doc-links.mjs`](scripts/lint-doc-links.mjs) walks
  `docs/**/*.md` + the canonical top-level docs and asserts every
  relative URL resolves to a real file. Strips fenced + inline code
  blocks before scanning so doc snippets showing example URLs
  (e.g. the ellipsis-bearing `adr/0028-…` example in
  `docs/cross-repo-audit.md`) don't false-flag. Seven `node:test`
  cases. Wired into `task lint:doc-links` + the `task lint` deps
  array + `task test:lint-scripts`. 77 markdown files scanned on
  current main; all clean.

- **schema-bridge: emit `readonly` on List fields** (commit
  `eac436e`, half 1 of `cloister-818f2b`) — `tools/schema-bridge/
  src/outputs/zod.rs::render_zod_type` and `render_ts_type` now
  render `z.array(T).readonly()` + `readonly T[]` for capnp
  `List(T)` fields. Zod v4's `ZodReadonly<ZodArray<T>>` infers its
  output as `readonly T[]`, so the `z.ZodType<Bundle>` annotation
  type-resolves cleanly. `src/generated/cluster.zod.ts` regenerated
  — `holdsCredential`, `args`, `env`, `bundles`, `wires`, `claims`,
  `subjects` all carry the modifier on both schema + interface
  sides, matching what the hand-maintained `cluster-types.ts` has
  declared all along. `Normalize<T>` in `bundle-drift-guard.ts`
  stays as defense-in-depth. 2 integration tests updated; all 16
  schema-bridge tests pass. Half 2 (capnp `# comment` → JSDoc
  carry-through) remains open as the half-2 tracker on
  `cloister-818f2b`; requires capnp-rust source-span access which
  the parser doesn't surface today.

### Shipped 2026-05-17

Eight feature PRs + ten stale-close reconciliations in a single
session (`cloister-963bf6` doc-polish + reorg landing after).

- **Bidi TOML ↔ capnp pipeline (Phase 1)** (PR #9, `cloister-ae06f3`,
  [ADR-0025](docs/adr/0025-bidi-toml-pipeline.md)) — `cluster.toml`
  at the repo root is now the operator-facing source. `task cluster:toml`
  parses + validates against `ClusterSchema` (zod via schema-bridge)
  + renders `src/generated/cluster.ts`. Capnp stays the substrate
  schema authority. Lossless on the data layer; comments NOT preserved
  (P3 follow-up).

- **`cluster:toml` chains canonicalize** (PR #12, `cloister-fe891f`)
  — operator workflow is one verb. `task cluster:toml` now chains
  forward + reverse legs so `httpPort = 9999` lands as canonical
  `httpPort = 9_999` in one step.

- **`task done` pre-PR readiness gate** (PR #13, `cloister-0d5e0f`)
  — drop-in `done-rules/*.json` (mache smell-rules shape). Five
  seed rules; cargo-pin rule (PR #15) extended cleanly to six.

- **`/.well-known/interlace/index.json` epoch index** (PR #11,
  `cloister-c13fa5`, RECEIPTS.md §2.3) — discovery doc bumps to
  Interlace 0.2.0 + carries epoch list with per-epoch pubkey + §2.7
  compromise notices, projected from `TrustStore.listCaBundleEpochs()`.
  Backwards-compat with 0.1.0 readers preserved.

- **`lint:bundle-isolation` reads `cluster.ts` not `cluster.capnp`**
  (PR #10, `cloister-cf519b`) — post-ADR-0025, `cluster.toml` is
  authoritative + `cluster.ts` is the canonical derived artifact.
  Lint catches ADR-0013-violating bundles in `cluster.toml` even
  when `cluster.capnp` is stale.

- **schema-bridge emits `.strict()`** (PR #14, `cloister-cf2e6a`,
  skeptic N1 from `cloister-ae06f3`) — zod's default behavior
  silently drops unknown keys. `.strict()` rejects them at the
  boundary where schema-bridge is the source of truth.

- **`lint:cargo-pins` for ed25519-dalek tilde-pin** (PR #15,
  `cloister-9bfbf6`, ADR-0019 §15.7) — cargo-deny operates on
  resolved versions (Cargo.lock); the `~` vs `^` vs bare vs `*`
  shape is purely syntactic in Cargo.toml. Lint parses the string
  directly.

- **README §13.2 row split** (PR #16, `cloister-ff437f`) — the
  load-bearing-claims table's §13.2 row was a 470-char wall
  conflating request-side + response-side. Split into two; added
  "this is a summary; full prose lives at
  `docs/security/load-bearing-claims.md`" framing.

Plus ten **stale-close reconciliations** (work already on main; bead
just got reconciled): `cloister-e14804`, `cloister-1f249f`,
`cloister-99165e`, `cloister-d95f0d`, `cloister-ff3169`,
`cloister-dc21b3`, `cloister-d7a862`, `cloister-7cd202`,
`cloister-d7674e`, `cloister-906adf`.

### Shipped 2026-05-16

- **`CLOISTER_DO_PATH` env-var override** (PR #7, `cloister-addcdd`,
  [ADR-0023](docs/adr/0023-host-path-resolution.md)) — macOS
  unblocker for `task serve:local`. `scripts/emit-workerd-config.mjs`
  substitutes the resolved path into `dist/config.capnp`'s
  `do-storage` service entry at build time. No `sudo`, no firmlinks,
  no docker required.

- **`task image:run` composable OCI launcher + DO SQLite
  unencrypted-at-rest disclaimer** (PR #5, `cloister-a3681d`) —
  `image:run` chains image → image:load → docker run with `/data/do`
  as a named volume. Disclaimer added across GETTING-STARTED + ADR
  surface: vault ciphertexts ARE AES-GCM-encrypted; bead/trust/blob
  tables are not. Don't drop production-sensitive data into a dev
  install.

- **ADR-0024: `cloister/credential-isolation/v1` capability + STATUS.md
  tracking index** (PR #8) — first concrete capability spec under the
  substrate-as-kernel framing (`cloister-1b59a2`). Defines capability
  shape, wire protocol, identity model, audit invariants, injection-
  strategy union. `docs/STATUS.md` lands as the canonical reality
  index for "what's Shipped vs Drafted vs Blocked."

### Shipped 2026-05-13

- **leyline-sign-helper keystore federation + ResolveCache hardening**
  (PR #2, `fix/cloister-2a0faa`, beads `cloister-2a0faa`, `cloister-d95f0d`,
  `cloister-d9a3c6`, `cloister-da4a07`, `cloister-da87da`,
  `cloister-d7674e`) — host-side keystore now federates across
  `keychain://`, `op://` (1Password CLI), `security://` (macOS
  `/usr/bin/security`), and plain `https://` allow-list with byte-identical
  bytes from each backend. Six-specialist adversarial cycle (trust-root,
  dos, oracle, silence, isolation, replay friends + synthesis) ran inline:
  13 of 17 findings fixed pre-merge, 4 carry as follow-ups.
- **`ResolveCache` rewritten** (`cloister-d95f0d`, `cloister-d9a3c6`) —
  replaced `tokio::sync::OnceCell` with `tokio::sync::watch::channel` +
  `std::sync::Mutex` over a bounded `HashMap`/`VecDeque` pair. Two
  invariants closed: (a) **no panic on leader cancellation** — followers
  see `rx.changed().await → Err(_)` and bail with `HelperError::Internal`
  instead of hitting an `unreachable!()` (skeptic-friend P1); (b)
  **bounded growth** under unique-spec floods via FIFO eviction at
  `LEYLINE_SIGN_RESOLVE_CACHE_MAX` (default 1024). New testable entry
  `resolve_with<F, Fut>` separates wiring from the work-fn so unit
  tests can assert the singleflight contract directly.
- **`HelperError::KeystoreLocked` retired** (`cloister-da4a07`) — all
  keystore-side failures collapse to the §17.10 constant-time
  `NotFound` on the wire. Comment block on the removed variant
  warns future devs against re-introducing a distinct 503 (re-opens
  the §17.10 enumeration oracle); a `"keystore_locked"` outcome
  label remains on the operator-side `tracing` log only.
- **Coalescing test sharpened** (`cloister-da87da`) — the
  `concurrent_resolve_for_same_spec_*` HTTP-layer test was a
  wall-clock-budgeted shape check that would have passed even if
  singleflight regressed to N independent fetches. Renamed to
  `_smoke` (kept for HTTP-layer coverage); the actual invariant
  now lives in three unit tests on `ResolveCache` directly: real
  call-count assertion via `AtomicUsize` (16 concurrent callers →
  `counter == 1`), leader-cancellation no-panic, and bounded-flood
  size check.
- **Cargo feature split: `host` vs `host-extras`** — `host-extras`
  pulls in the OS-keystore federation (`keyring`, `secret-service`,
  `dbus-sys`), `host` is the lean default. `task verify` runs both
  feature shapes so the helper compiles + tests on linux-without-dbus
  builds where AGPL `secret-service` is not desired.
- **New env vars on the leyline-sign-helper** —
  `LEYLINE_SIGN_SIGN_ALLOW` (per-helper allow-list overlay for
  `/sign`), `LEYLINE_SIGN_OP_BIN` + `LEYLINE_SIGN_SECURITY_BIN`
  (subprocess paths for 1Password CLI and macOS `security`),
  `LEYLINE_SIGN_RESOLVE_TTL_MS` (positive-cache TTL; `0` disables
  caching), `LEYLINE_SIGN_RESOLVE_CACHE_MAX` (FIFO cap; default
  1024). All documented in ADR-0019 normative reqs 14–18.
- **ADR-0019 normative reqs 14–18** — env-var surface frozen for
  the pre-OSS release: `RESOLVE_CACHE_MAX` bound, `RESOLVE_TTL_MS`
  zero-means-no-cache semantics, subprocess-path overrides, allow-
  list overlay, host-extras feature flag.
- **CI hardening** (commits `7e4c3f1`, `7ef7c61`) — linux runner
  gained `libdbus-1-dev` + `pkg-config` so `keyring`'s
  `sync-secret-service` feature links; `dtolnay/rust-toolchain`
  pinned to `1.95.0` (matches `rust-toolchain.toml`) with a
  pre-warm step to stop the `rs:sign:host`/`rs:sign:wasm` parallel
  fan-out from racing rustup.

### Shipped 2026-05-12

- **Interlace 0.2.0 receipts (Phase 1)** (`cloister-ae713f`) — full
  TypeScript implementation of the six-piece arc. Server emit
  (Interlace-Receipt header on every authenticated 2xx), P-live verify,
  V-archival verify, SSE stream chain (open/close commitments with
  cryptographic pairing via `open_commitment_hash`), archival CA bundle
  endpoint, compromise notice mechanism. 104 new tests. Phase 1
  semantics: `RECEIPT_SIGNING_KEY` unset → no emission; peers verify-
  but-don't-enforce. Phase 2 cutover (peers fail-closed on missing
  receipts) is a future operator action, not a code change.
- **ADR-0018 Accepted** (`cloister-db99cd`) — notme co-location design
  with math-friend dual review synthesis. V8 isolate boundary trades
  memory-isolation for finer-grained policy expression; full
  prerequisite gate chain documented. Implementation gated on
  cloister-99165e + cloister-988589 + cloister-993bef Phase C.
- **ADR-0019 Accepted** (`cloister-98b693`) — sign-only trust-anchor-
  helper protocol. Cross-cutting prerequisite for ADR-0018 + ADR-0014
  v2b. Math-friend dual review synthesized: alg-substitution defense,
  opt-in pubkey return, base64url, 64 KiB MUST, 5s timeout, rate
  limit, ed25519-dalek pin, constant-time error shape, byte-hash-keyed
  SigningKey cache for zero-operator-action rotation propagation.
- **Lint-bundle-isolation gaps closed** (`cloister-988589`) — math-
  friend's 7 specific gaps fixed. New manifest fields
  (`holdsCredential`, `workerdServiceName`, `hypervisorRationale`),
  new Inv 5 (hypervisor-to-hypervisor wires must appear in
  cluster.capnp), Inv 1 extended to flag external-server-backed
  globalOutbound, Inv 3 requires non-empty hypervisorRationale for
  hypervisor-tier bundles. 9 new tests.
- **Threat model §2** — new row for the leyline-sign-helper binary
  trust root (per ADR-0019).
- **ADR-0020 Proposed + adversarial team chartered** (`cloister-1f249f`)
  — 7-role red-team rotation (dos-friend, oracle-friend, isolation-
  friend, replay-friend, trust-root-friend, silence-friend, synthesis-
  lead). Agent definitions in `~/github/jamestexas/agents/agents/`.
  Six specialists read-only; synthesis-lead owns the threat model.
  Origin: 5-why exercise surfaced pioneer-mode-under-resources-ops
  pattern across multiple surfaces.
- **dos-friend pilot dispatched** against `src/vault-store.ts` —
  4 findings: F1 unbounded RPC queue (`cloister-211b68`, open), F2
  identity propagation (`cloister-2140b5`, resolved by ADR-0021 below),
  F3 KEK rejected-promise cache (`cloister-2176e4`, **shipped**), F4
  credential-payload size cap (`cloister-21b5eb`, **shipped**).
- **F3 + F4 shipped in vault** (commit `4499f7c`) — `#getKEK` clears
  rejected promises with race-guard; `HelperKekSource.resolve` bounded
  retry (3 attempts, 100/250ms backoff + jitter, no 4xx retry);
  `validateCredentialPayload` enforces 32-header / 16 KiB / UTF-8-
  byte-counted caps at the input boundary before encrypt + SQL write
  can be triggered. 7 new adversarial tests.
- **ADR-0021 Proposed** — per-bundle vault DO instances. Closes the
  open identity-propagation question from `src/vault-store.ts:92-110`
  by implementing ADR-0013's documented binding-layer identity design
  (per-bundle `idFromName(bundleName)`) rather than adding new
  per-call signature or workerd-caller-name machinery. Gated by
  ADR-0018 (notme-as-bundle) landing. Layered-defense follow-on (per-
  call sig via ADR-0019 helper) noted but out of scope.
- **dos-friend F1 shipped** (commit `835816b`, `cloister-211b68`) —
  per-caller token-bucket budget + concurrency cap in vault DO.
  Math extracted as pure functions in `vault/src/rate-bucket.ts`
  (16 unit tests). DO-integration tests for Response-shaped paths
  in `test/vault-store.test.ts` (2 tests). Structured emit
  `vault.rate_limit_reject` for silence-friend's future audit hook.
- **trust-root-friend pre-merge gate** on PR #1 (cloister-99165e) —
  adversarial cycle 2026-05-12 surfaced 3 P1s + 3 P2s in the
  leyline-sign-helper. Merge held. Findings (one bead each):
  cloister-7aaab1 (/resolve byte exfil), cloister-7afedc (cross-UID
  loopback), cloister-7b5b9d (rate-limit wrong identity),
  cloister-7bb456 (binary integrity), cloister-7c2179 (CSRF simple-
  POST), cloister-7c737a (no-CL body cap bypass), cloister-7cd202
  (ed25519-dalek pin drift).
- **Threat model §15** — "Trust-anchor-helper attack surface" — 7
  new rows (§15.1–15.7) documenting each finding's invariant and
  closing playbook. Adversarial-cycle report at
  `docs/security/adversarial-cycles/2026-05-12.md`.
- **Failing tests on PR #1 branch** (`rs/crates/sign/tests/host_adversarial.rs`)
  — 5 tests that RED initially, each panic message points to a bead +
  threat-model row. PR CI now blocks the merge until they go green.
- **trust-root-friend cycle 1 fixes shipped on PR #1** (commits
  `de51d86` + `cb7ff50`): 5 of 7 findings closed code-side
  (§15.1 `/resolve` allow-list, §15.2 bearer-token auth, §15.3
  per-caller rate-limit, §15.5 strict Content-Type, §15.6
  RequestBodyLimitLayer, §15.7 ed25519-dalek pin). §15.4 (supervisor
  binary integrity) deferred as P2.
- **trust-root-friend cycle 2 verification** — re-dispatched after
  cycle-1 fixes. Headline NEW-1 (`cloister-9bd96c`, P1): supervisor
  templates were dropping operators into `AuthConfig::Disabled` =
  §15.2 restored for any operator following the install instructions
  verbatim. Closed same-cycle in commit `af794fb` via `--require-auth`
  fail-stop flag + `EnvironmentFile=`/`EnvironmentVariables` block in
  launchd plist and systemd unit. NEW-2 (P2, `cloister-9bee1f`) and
  NEW-3 (P3, `cloister-9bfbf6`) filed as non-blocking follow-ups.
- **Threat model §15.A** — cycle-2 per-row verification status +
  NEW-1/2/3 rows + "fix isn't done when code lands; done when the
  artifact operators follow enforces it" lesson captured.
- **PR #1 disposition: MERGE OK** for the trust-root surface. Other
  red-team specialists (oracle, isolation, replay, silence) queued
  for follow-up cycles.

### Arcs in flight

- **Cloister CLI in `rs/crates/cli/`** (`cloister-999532`) — Rust
  binary subsumes `scripts/cli-init.mjs`. Install/bundles/init/status
  subcommands. OCI-annotation-based tool installation per
  cloister-3a3b0d's CAS substrate.
- **External-consumer survey for notme's public surface** — ADR-0018
  prerequisite gate #5. Determines whether full co-location (this ADR)
  or Alternative 4 (split notme surface) is the right shape.
- **Joint benchmark** — `bead_create` burst + `cert_mint` on one
  workerd process. ADR-0018 prerequisite gate #6.
- **Receipts crypto TS → Rust-wasm port** (`cloister-9a1b72`) —
  attack-surface reduction follow-up to ae713f. P2; non-blocking.
- **TOML-derived config DX** (`cloister-277ae7`) — generate the three
  capnp files from extended wrangler.toml.

## [0.1.0] — 2026-05 (current)

The substrate baseline. Everything below is in `main` and gated by CI's
`task lint` + `task verify`.

### Hypervisor + cluster topology

- **v8-isolate hypervisor on `workerd`**. Same TypeScript bundle runs locally
  on `workerd serve` and on Cloudflare Workers in production.
- **Declarative routing** via `cloister.capnp`. Adding a route, backend, or
  bundle is a manifest edit; nothing in `src/` changes.
- **Per-tier bundle classification** per ADR-0011 — `hypervisor` (cloister-router,
  notme-identity, the singleton DOs) vs `cluster` (mache, rosary, ley-line-open).
- **Cluster runtime**: `task cluster:dev` (mac-native), `task cluster:up`
  (docker/podman/nerdctl compose). Boot-to-200-on-`/health` metric reported
  in `task cluster:test`.

### MCP face

- **`/mcp` Streamable HTTP** endpoint serves `bead_*`, `lsp_*`,
  `reparse`/`enrich`/`status`, and (with dynamic-tools) `mache_*`.
- **Sessionless protocol support** per SEP-2575 + SEP-2567 — cloister speaks
  both the current `2024-11-05` lifecycle and the next sessionless protocol
  concurrently. `MCP-Protocol-Version` header switches dispatch path. (`cloister-a35fdb`)
- **Spec-compliance test fixture** at `test/spec/fixture-mcp-server.ts` —
  asserts P-live verifier and V-audit invariants against both protocol versions.
- **MCP Registry** OpenAPI surface at `/.well-known/mcp-registry/v0.1/`
  exposes cloister's upstream catalog (`art.agentic-research/cloister/<id>`).
  Single-server lookup returns constant-time 404 for filtered-out backend
  kinds (`durableObject`, `serviceBinding`, `udsForward`). (`cloister-a30e40`,
  `cloister-ec7a52`)
- **Identity bridge** at `/.well-known/identity-bridge` — proxies WebFinger,
  Nostr NIP-05, OAuth2 client_credentials grant, OIDC discovery, JWK Set.
  (`cloister-c9922f`)

### Identity & trust

- **Interlace lease verification** in `src/routes/lease-middleware.ts` —
  full pipeline: header parse → clock-skew bound → wasm32 cert-chain verify
  → claims required → epoch + validity-window check → Web Crypto Ed25519
  request-sig verify → scope match → seen-nonces replay check → TrustStore
  RPC upsert. Active when `INTERLACE_ROOT_PUBKEY` is set; skipped when unset
  (deployment-binding granularity, not per-request bypass).
- **TrustStore + BeadStore + BlobStore** singleton/per-repo Durable Objects
  per ADR-0012. Cross-DO writes via ADR-0003 content-addressed handoff;
  `bead_create` orchestrator at `src/routes/bead-create-orchestrator.ts`.
- **Per-bundle credential namespacing** in CredentialVault DO — composite
  primary key `(subject_fp, service)` derived from `VerifiedLease.peerFp`,
  not from caller input. Cross-bundle write attempts fail at the SQL layer
  in addition to the binding layer. (`cloister-26546a`)
- **Pluggable KEK source** — vault DO resolves the KEK from a URL spec
  (`env://`, `file://`, `keychain://` via the kek-helper sidecar, etc.).
  macOS Keychain dogfood-validated end-to-end. (`cloister-268a01`)

### Wire codecs

- **leyline-net wire** at `src/wire/` — signed capnp manifests with AEAD;
  cross-implementation byte-equality maintained via test vectors and a
  Python reference implementation.
- **Wasm cert-chain verifier** — `rs/crates/sign/` compiles to
  wasm32-unknown-unknown; loaded by `src/wire/signet-verify.ts`. Build via
  `task rs:sign:wasm`.

### OCI distribution

- **`task image`** builds a distroless OCI image via melange + apko (Wolfi
  base). `task image:load` retags after apko's per-arch tar emit so
  `cluster.compose.yaml`'s bare `cloister:0.1.0` reference resolves.
- **OCI registry Phase 1** at `/v2/` — read-only pull path (manifests +
  blobs). Tags live in TrustStore's `registry_tags` table. (`cloister-cabd57`)

### Specifications + drafts

- **Interlace protocol** at `interlace-spec/0.1.0/` — FINAL. 6 test-vector
  files; Python ref impl passes the same 27 conformance vectors as
  cloister's runtime.
- **Interlace 0.2.0 draft** at `interlace-spec/0.2.0-draft/` — signed
  receipts amendment closing the §13.2 response-side non-repudiation gap;
  URL canonicalization (Option 5: sign path-suffix after operator-declared
  prefix); paired test vectors. Three rounds of math-friend review.
  Cloister's internal protocol — the rigor exists to make cloister itself
  defensible, not as a campaign to standardize externally.
  (`cloister-ae713f` + `cloister-aecd26` + `cloister-770464`)
- **MCP Proxy Server design note** at `docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md` —
  internal design documentation. Describes what a first-class MCP Proxy
  Server data-layer concept could look like (a `proxy` capability +
  `proxy/upstreams` introspection RPC). Cloister implements this shape
  as a working prototype. No upstream submission planned — per the MCP
  SEP guidelines (modelcontextprotocol.io/community/sep-guidelines),
  protocol changes derive from community + working-group consensus, not
  from cold spec drops. Kept here so the design rationale survives.

### Substrate properties (load-bearing)

- **§9.4 constant-time 404** at the disclosure endpoint — verified via
  `docs/perf/2026-05-10-disclosure-endpoint.md` bench-pinned at 60µs
  post-fix (was 17× delta pre-fix).
- **Slice-grant via V8 isolate + service-binding-as-syscall** per ADR-0013.
  19-case prompt-injection demo at `test/security/prompt-injection.test.ts`.
- **Substrate-property lint** (`scripts/lint-bundle-isolation.mjs`) — enforces
  ADR-0013 invariants at manifest level (no `globalOutbound` on cluster-tier;
  credential bindings only on the allow-list; every bundle declares a tier;
  cluster-tier bindings must have matching wires). (`cloister-ac30e7`)

### Build + CI

- **`.npmrc`** pins `package-import-method=hardlink` for pnpm. Without it,
  pnpm's default `auto` silently falls back to copy mode on macOS APFS;
  fix saves ~400MB per worktree (verified empirically).
- **`task ci`** mirrors GitHub Actions exactly (`task lint` + `task verify`).
  `scripts/git-hooks/pre-push` available for opt-in local enforcement.
- **CI drift gate** for interlace-spec vectors at
  `.github/workflows/interlace-spec-drift.yml` — pinned SHA-256 set
  refuses silent vector mutations. (`cloister-af1290`)

### Documentation

- README load-bearing claims table is honest about §13.2's current state
  (response-side non-repudiable only at Phase 2 cutover of receipts impl).
- ADRs 0001–0017 cover every substrate decision. ADR-0017 documents the
  workerd-config generator rationale (so reviewers don't keep asking why
  `[[wasm_modules]]` doesn't work).
- Navigability READMEs at 9 subsystem directories. (`cloister-be36ea`)
- MCP-client onboarding at `docs/integration/mcp-client.md`.

### Known gaps (the OSS-launch caveat list)

- **`mache_*` / `lsp_*` tools/list** is empty against `task cluster:up` —
  cloister-router doesn't complete the spec-mandated `notifications/initialized`
  handshake with upstream MCP servers. Tracked as `cloister-91e5d4`; fixed by
  Phase 1 of the spec-alignment arc (`cloister-a3ae4c`).
- **§13.2 chain-completeness** is currently honest-actor-at-admission only on
  the response side. interlace-spec 0.2.0 receipts close the gap; spec text
  complete, **cloister-side implementation Phase 1 shipped 2026-05-12**
  (`cloister-ae713f`, commit `a0d3fd3`) — emit-but-don't-enforce mode.
  Phase 2 cutover (peers fail-closed on missing receipts) is an operator
  action (flip `RECEIPT_SIGNING_KEY` env), not a code change. (Self-attested
  via three rounds of LLM adversarial review — no third-party cryptographic
  audit has been performed.)
- **Notme runs as a separate workerd process**. Co-location into
  cloister-router's workerd (`cloister-db99cd`) — ADR-0018 **Accepted
  2026-05-12** with math-friend dual review synthesized. Implementation
  gated on `cloister-99165e` (Rust helper binary) + `cloister-988589`
  (lint gaps, shipped) + `cloister-993bef` Phase C (sign-only helper
  available as opt-in) + external-consumer survey.
