# Changelog

All notable changes to cloister are tracked here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); the project is pre-1.0,
so we batch changes by month rather than ratcheting semver per release.

## [Unreleased]

Tracking via the bead store (`rsry_list_beads --repo cloister --status open`).

### 2026-11 — `cloister inspect` reads Knative Services (ADR-0073 amendment)

- A Knative Service written as `kubernetes_manifest` (`serving.knative.dev/v1
  Service`) is read as a workload placed `knative`, which answers at its own
  cluster name. It is checked against Knative Serving 1.24.0's published CRD,
  projected by `gen/facts-spec.mjs --api`, which now reads a CRD. A CRD cannot
  describe `metadata`, so that part is Kubernetes 1.37.0's ObjectMeta.
- Its port's name is its protocol (`http1`, `h2c`). With no port it is served on
  8080 over `http1`, and the draft says that was assumed.
- Its `networking.knative.dev/visibility` label sorts its exposure: `cluster-local`
  is cluster. With no label the plan does not say, and the draft says so
  instead of choosing.
- A mapping's exposure may read one key of a map it reads, and one of its two
  sort lists may be empty.

### 2026-11 — ley-line-open 0.31.0

- Every LLO channel moves to v0.31.0 (`eb07092a`) in one step (`task llo:bump`):
  - the Cargo pins and both lockfiles;
  - the input in `cluster.toml` and `cluster.lock.toml`;
  - the generator and wasm digests in `schema-bridge.lock.json`;
  - the vendored spec files.
- LLO's spec tree is byte-identical between the two releases. The vendored
  files change only their source line, and the three hand-written copies of
  `confinement/v1` move to 0.31.0 having been re-read against it.
- **The worker and `leyline-runtime` move together.** The host runtime builds
  against `leyline-runtime` 0.31.0, and `runtime install` fetches the 0.31.0
  `leyline-krun-worker`. The worker now holds a lifeline to its host runtime:
  when the host runtime ends, `SIGKILL` included, the worker exits and takes its
  VM with it (ley-line-open-f963e6).
- **Operators: re-run `cloister runtime install` after upgrading.** A run now
  refuses an installed worker that the checkout's `schema-bridge.lock.json`
  does not pin, and names that step: the worker and the host runtime were
  installed together for another release. A worker set explicitly with
  `CLOISTER_KRUN_WORKER` is the operator's, and is not checked. A VM an older
  worker already started can still be running; `cluster up`'s messages and the
  docs say how to find it.
- The generators' output changes one header line, and every generated file is
  regenerated.
- `task llo:bump` asks GitHub's REST API for the release and its assets,
  instead of `gh release view` and `gh release download`, which go through
  GraphQL. It hashes each download itself, and stops if that disagrees with the
  digest the release lists.
- LLO's daemon wire break (`wire_format_major` 3, positional `query` rows) does
  not reach cloister, which does not read daemon query rows.

### 2026-11 — `cloister inspect` reads `kubernetes_manifest` (ADR-0073 amendment)

- A workload written as `kubernetes_manifest` was not read at all. The report
  counted it under "Not read", a connection declared for it was reported
  `unknown`, and one it made that nobody declared could not be seen. A
  Deployment, StatefulSet, DaemonSet, Job, Service or Namespace written that
  way is now read like the provider's typed resource. A test rewrites the
  whole Kubernetes plan as manifests and gets the same report and findings.
- The kinds are mapping entries, checked against Kubernetes' published OpenAPI
  schema (1.37.0), projected by `gen/facts-spec.mjs --api` and reproducible
  byte for byte. A mapping declares the resource under `objects`.
- A kind no entry reads is named on the "Not read" line
  (`kubernetes_manifest networking.k8s.io/v1 Ingress`).
- Nothing is guessed from a manifest's configuration, which is one expression
  for the whole object. Its references are not read as edges. An env value is
  drafted as a constant only when the expression takes from nothing; otherwise
  it is unknown, named with what the expression takes from.
- A sensitivity marker on a parent block now covers everything under it, for
  every mapping. Before, a value two levels under a marked block read as public.

### 2026-11 — a token is minted only for a lease holder, in that holder's name (ADR-0086)

- `POST /oauth/token` requires a lease, always, dev mode included. Its tenant
  doc said it did. The code checked no client and named the cluster as every
  token's subject.
- The token's subject is now the caller's lease fingerprint. The request names
  exactly one scope, the gate checks the lease covers it, and the token carries
  that scope only.
- Refusals are `401 invalid_client`, `503 temporarily_unavailable` when the CA
  bundle is unavailable, and `400 invalid_scope` without exactly one scope.
- Two comments about which key `/.well-known/jwks.json` publishes predated the
  change that makes it ask notme for the signing key, and are corrected.
- The threat model gains §6.6. The token is still a bearer token, because
  notme's delegated signer refuses to bind a key; that is recorded as residual.
- `url` 2.5.9 in both Rust lockfiles, for RUSTSEC-2026-0592.

### 2026-11 — the lock writer's carry rule keeps the records #366 could drop

- #366 said it moved the rule that carries rootfs records across a lock
  regeneration from the microVM driver into `cli/lib/cluster/lockfile.mjs`.
  It also changed the rule's guard. The driver skipped the carry only when the
  regenerated row held its own rootfs rows. #366 skipped it when that row held
  any rootfs record, so a row holding only a flat (pre-cloister-1c4ef5) record
  lost the recorded rootfs rows. Nothing writes such a row today, and no test
  covered it.
- The guard is the driver's again, with one deliberate difference: a record
  the regenerated row holds is never overwritten. The driver's version
  overwrote the new row's flat record with the old row's.
- The test now checks the rule over every combination of records on either
  side and every digest relation, 288 cases, instead of examples. It fails on
  both earlier versions.

### 2026-11 — every lease refusal is recorded (ADR-0085)

- `gateAndVerify`, the one gate every lease-gated route uses, records each
  refusal once, as a structured `lease_gate` event. It carries the JSON-RPC
  code, the reason, the route, the method and the scope asked for. It never
  carries a certificate, signature, nonce, timestamp header, body or
  credential, and the caller's constant-shape response is unchanged.
  Before, a refusal left no trace, so an operator could not see probing,
  expired certificates, scope misses or a CA outage.
- `tenant-dispatch.ts` said lease verification happens before dispatch. The
  threat model (§13.7.1) and the code agree it happens inside the tenant's
  gateway, after dispatch, and the comment now says so. Which bundles a tenant
  binding may name is recorded as open in ADR-0085.
- The threat model gains §6.5, refusals are recorded, with the log-flood
  residual.

### 2026-11 — `artifacts pull` fills the store `cluster up` starts from, operator pins included

- `artifacts pull` chooses its engine by `cluster up`'s rule:
  `CONTAINER_CMD` if set, otherwise the engine `cluster up`'s compose runtime
  drives. It used to try docker, then nerdctl, then podman, while `cluster up`
  tries nerdctl, then podman, then docker. On a machine with docker and
  podman, as GitHub's runners have, it pulled into docker's store while
  `cluster up` started podman's.
- It also pulls each operator image the lock pins in `[[images]]`
  (ADR-0083 §2), by its digest. It used to read only the inputs' pins, so an
  offline `cluster up`, which pulls nothing itself, lacked an operator's
  pinned image.

### 2026-11 — `--locked` runs only what the lock pins (ADR-0083 §5)

- `cluster up --locked` starts only a digest cluster.toml writes or
  cluster.lock.toml pins. Before anything starts, it refuses by name:
  - an image with no digest, such as a local build, which nothing pins;
  - a committed `cluster.compose.yaml` whose images are not what cluster.toml
    and cluster.lock.toml render, which is the lock out of date with the
    declaration.
- `cluster k8s --locked` refuses, before anything is written, a container
  whose image has no digest, or runs a digest other than the lock's pin for
  its bundle. Lowering never overwrites a manifest, so one lowered before its
  image was pinned is caught here.
- The microVM placement already ran only the lock's rootfs, so `--locked`
  changes nothing there.
- `--locked` asks no registry what a tag names today. ADR-0083 §5 is amended
  to drop that clause: Cargo, npm and Nix refuse only a lock that would have
  to change, and a locked run must not depend on the registry's state.
- CI uses it. The kind jobs now run `cluster resolve`, then lower, then
  `cluster k8s --locked`. The compose e2e checks a locked refusal and a locked
  start.
- The digest probe now re-asks the host that challenged after a token
  exchange. A registry that redirects to another host, as registry.k8s.io
  does, would otherwise get the token back without it, because fetch drops
  Authorization on a cross-origin redirect.

### 2026-11 — cloister keeps no Rust; each tree it still has names its exit (ADR-0084)

- ADR-0084 makes no Rust cloister's target. Cloister keeps its own policy,
  authorization, audit and CLI, and none of that needs Rust. Each of the four
  remaining Rust trees names the work that ends it:
  - `rs/crates/cas`: LLO publishes its wasm32 build (ley-line-open#605),
    pinned by digest;
  - `rs/crates/host-runtime`: runs go through LLO's daemon, and LLO gives a
    caller that is not Rust a way to build a run (ley-line-open#606);
  - `tools/harness-sandbox`: LLO's port of its kernel-level confinement
    assertions;
  - `tools/edge-probe`: becomes a script in a pinned image, once a microVM
    boots in CI.
- `lint:rust-exits` holds it:
  - every tracked Rust or Cargo file lies in a listed tree;
  - a new crate is refused, even inside the listed workspace;
  - each entry names its exit;
  - an entry whose tree is gone is refused;
  - the Rust stays under ADR-0084's `rust-budget` of 6,000 lines, against
    5,943 today.

### 2026-11 — dead code removed, with its functionality accounted for

- `src/wire/run-id.ts` is deleted, with its test and the vendored
  `run-id.json` vector. It derived an execution/v1 run ID that cloister never
  computes. LLO's runtime derives it (`leyline-runtime` `authorization.rs`,
  against the same vector), and cloister's `runtime` commands use the ID LLO
  returns.
- `src/wire/confinement-digest.ts` is deleted. Nothing called it, and its
  header claimed lease-verify compares the digest, which it does not. Its
  check moves to the copy cloister keeps: `test/wire/confinement-digest.test.ts`
  now hashes the CLI's `canonicalJson`, the confinement lattice's canonical
  form, with the substrate BLAKE3, and pins LLO's digest. The digest a run is
  held to is still checked by the harness runner before `Sandbox::apply`.
- `rs/crates/host-runtime/src/mediator/` (428 lines) is deleted, along with
  the `leyline-fs` dependency only it used. Nothing constructed it. It was the
  filesystem half of ADR-0049's runtime, from before that runtime moved to
  LLO. ADR-0050 makes per-operation mediation an escalation, which would live
  with LLO's runtime.

### 2026-11 — `cluster up` resolves each compose image when it starts it (ADR-0083 §4)

- `cloister cluster up` (without `--env`) now resolves every image before it
  starts compose, through the engine compose drives:
  - an image written by digest, whether cluster.toml's own or the lock's
    pin, runs as written, and is pulled by that digest when the engine does
    not hold it;
  - any other image the engine holds, a local build or a pulled one, runs by
    its image ID, under a tag made from it (`cloister:sha256-<hex>`), so a
    rebuild while compose starts cannot change what runs. One rule serves
    docker's classic and containerd image stores;
  - an image that names a registry and is missing is pulled with the
    engine's own credentials, then runs by its ID;
  - a bare name the engine does not hold is refused by name, and never
    pulled. Nothing starts.
- The committed compose file runs as it is, plus one override in the run's
  directory that names each image by its content address. The cluster root
  stays the project directory, so relative paths and `.env` are unchanged.
- Each container records what it runs in labels: `cloister.image`,
  `cloister.image.digest` and `cloister.image.by`. There is no state file.
  The next `up` prints each digest that moved, and removes the tag the
  previous local build ran under.
- `CONTAINER_CMD`, which `artifacts pull` reads, names the engine for `up`
  too.
- `task smoke:compose-up-images` runs `cluster up` against docker in CI's
  compose-hold job. It checks:
  - what each container actually runs;
  - that a rebuild is picked up, and its move printed;
  - that an `up` with nothing rebuilt changes nothing;
  - that a bare name is refused and nothing is pulled for it.

### 2026-11 — every placement runs images by digest, resolved for you (ADR-0083 §1–§3)

- A manifest `cluster lower` writes now runs the lock's pins. Before, a
  lowered workload ran the `image` string from `cluster.toml` verbatim, and
  never read the lock. A manifest lowered earlier is left alone, as lowering
  always does. Compose pinned only an image derived from an input, so an
  operator's own `image` ran by its tag.
- One image resolution serves compose and Kubernetes
  (`cli/lib/oci-artifact.mjs`): a digest the declaration writes, then the
  lock's pin, then unpinned. A pinned image is written `name:tag@sha256:…`, so
  the digest runs and the tag stays readable.
- `cluster resolve` pins an operator image that names a registry, through the
  probe inputs already use, into `[[images]]` rows of `cluster.lock.toml`.
  Docker's rules decide what a reference means:
  - an untagged image is `latest`;
  - `docker.io` is asked at `registry-1.docker.io`, a fix inputs share;
  - a bare name such as `cloister:0.1.0` is a local build, and is never
    looked up, since Docker would read it as Docker Hub's `library/cloister`.

  An image the registry does not resolve is refused by name, as an input's is.
- `cluster generate` carries those pins too. It writes the committed compose
  file and runs the drift check, but it read only the input pins, so an
  operator's pinned image was written by its tag. Both render paths now take
  every pin the lock holds as one object, so no list of pin kinds can drop
  one. A test runs `cluster resolve` and then `cluster generate`, as a user
  does.
- A committed compose file or Kubernetes manifest names, in its header, each
  image it does not pin, with the fix. Renders stay deterministic, so
  `cluster:emit:check-drift` holds. Every shipped configuration's images are
  local builds, so their compose files now say so.
- Next (ADR-0083 §4 and §5): a run resolves a local build's digest when it
  starts it, and `--locked` refuses anything the lock does not pin.

### 2026-11 — one credential injection, applied by the vault as declared (ADR-0082)

- Production now does what a service declares. Before, the vault's Durable
  Object:
  - injected whatever headers were stored with the credential, and never read
    the service's declared `injection`;
  - sent every call to the stored upstream URL, dropping the path the caller
    asked for.

  The five credential-isolation/v1 strategies lived only on a path tests used.
- `vault/src/inject.ts` is the only injection. It computes the upstream
  request from the declared strategy and base, the stored secret, and the
  caller's method, parsed path, query and headers. It uses no platform types,
  so the egress boundary ADR-0082 names as its north star can later share it.
  The vault, the in-memory path and nothing else call it. The vault library's
  request builder, its unused handler and the harness's `credentialHeaders`
  are deleted.
- A credential is stored as the secret and the upstream it is for, not as
  ready-made headers. The vault refuses, with the usual constant-shape 404,
  a call whose declared base is not the one the credential was stored for.
  The credentials table is recreated on first use, since nothing in
  production writes credentials yet. The dev seed carries the API key.
- The caller's lease headers no longer reach the upstream. Production
  forwarded `X-Signet-Sig`, `X-Signet-Ts` and `X-Signet-Nonce`. A secret
  holding a CR, LF or NUL is refused when stored and when injected.
- LLO's eight injection vectors run through the Durable Object
  (`test/routes/credential-isolation-conformance.test.ts`, cloister-7c9312).
  The test worker's outbound network echoes requests to the vectors' hosts,
  so each test compares the request that actually reached the upstream.
  Where LLO's vectors and spec text disagree, cloister follows the vectors:
  a `queryParam` collision appends, and a `bodyField` body has sorted keys.
- No test reaches the real network: the test worker answers any other host
  502.

### 2026-11 — core no longer reads the gateway's manifest types or the microVM driver's lock rows (ADR-0081)

- The actor-fingerprint resolver takes the declared fingerprint, which the
  gateway's routes pass it, instead of the whole gateway manifest.
- `src/manifest/vault-proxy-services.ts` is classified as the MCP gateway
  feature. It turns the gateway manifest's `vaultProxyServices` rows into the
  vault proxy's registry, so it is the gateway reading its own declaration.
  The proxy it feeds stays core.
- The lock writer no longer imports the microVM driver. The rule that carries
  a record derived from a pinned image (a rootfs) across a lock regeneration
  is core's: the record follows the image's digest. It moved from the driver
  into `cli/lib/cluster/lockfile.mjs`, rather than behind a hook the driver
  registers, because a writer that never loads the driver would skip a hook
  and silently drop the rows.
- Outward imports went from 10 to 7.
- Core's budget is now a coarse ceiling of 22,000 lines, above core's 21,198,
  instead of core's exact size. Lines are a proxy: the ceiling catches
  something large landing in core and is not managed line by line. What core
  must do is checked by tests of its guarantees and by the import rule
  (ADR-0081 §4, amended).

### 2026-11 — core declares the environment it reads (ADR-0081)

- `src/core-env.ts` declares `CoreEnv`: the configuration core reads, and the
  endpoints it calls, typed by those calls rather than by workerd's binding
  types. The workerd driver's `Env` extends it, and each field's documentation
  moved with it.
- Five core files that only read configuration now take `CoreEnv`: the
  actor fingerprint, the lease gate, the CA bundle source and its notme
  fetcher, and the receipt emitter. The vault's key source reads its two HTTP
  endpoints by that shape too, not as workerd `Fetcher`s. The vault no longer
  casts to reach `VAULT_KEK_TENANT_SCOPED`, which is now declared.
- `src/routes/vault-do-credential-store.ts` is classified as the workerd
  driver. It is how that driver provides core's `CredentialStore` port over
  the vault's Durable Object.
- The layer rail now counts an import of `cloudflare:*` as an import of the
  workerd driver. That makes two imports visible that it had missed: the trust
  store and the vault are Durable Object classes.
- Outward imports went from 14 to 10. The ones left are core hosted as
  Durable Objects, the registry tables, the gateway's manifest types, and the
  lock writer. Core shrank to 21,351 lines, and its budget was lowered to
  match.

### 2026-11 — imports point inward, and core has a budget (ADR-0081 §3, §4)

- `task lint` now refuses an import that points outward:
  - core importing anything but core;
  - a driver importing another driver, or a feature;
  - a feature importing a composition root;
  - runtime code importing tooling, configuration or examples.

  It reads imports with
  TypeScript's own pre-processor for scripts. For Rust it reads `mod`
  declarations and crate paths, and for Cap'n Proto its `import` statements,
  in both cases after comments are removed.
- The 14 outward imports in the tree today are listed by name, and an entry
  that no longer exists is refused, so the list only shrinks. All 14 start in
  core:
  - nine core files are typed against the workerd driver's `Env`;
  - the trust store keeps the OCI registry's tables;
  - two core files read the MCP gateway's manifest types;
  - core's lock writer carries the microVM driver's rootfs rows.
- Core's size is `core-budget` in ADR-0081's frontmatter, and `task lint`
  refuses core larger than that. Core may shrink freely. Growing it raises the
  budget in the same change, with a reason.
- The rail found mistakes in the first map, which ADR-0081's amendment
  corrects:
  - the MCP gateway's backend kinds, manifest and wires had been counted as
    the workerd driver;
  - the module that instantiates the gateway had been counted as a driver;
  - shared logging and script-entry helpers had been counted as features.

  Core is 21,363 lines (40%), not 21,972, and core gains a seventh area,
  support. Drivers are 8,220 lines and features 22,392. No code moved.

### 2026-11 — cloister is a core, drivers and features (ADR-0081)

- ADR-0081 separates cloister into three layers, joined only at composition
  roots:
  - **core**: what every deployment guarantees, in five sentences;
  - **drivers**: one per placement (workerd, compose, microVM, kubernetes);
  - **features**: built on both.

  The gateway is not core. Its isolate hosting is the workerd driver and its
  routes are features. Core is not a place either: on Cloudflare Workers
  there is no host underneath the worker.
- A measured snapshot of cloister's 52,788 lines of runtime code:
  - core is 21,972 lines (42%), and 12,349 of them are written as gateway
    code in `src/`;
  - drivers are 12,577 lines;
  - features are 17,723 lines.
- `lint/layers.mjs` maps every tracked source file to its layer, and
  `task lint:layers` prints the inventory. `task lint` refuses a source file
  with no layer, and a map entry that names no file.
- Still to come:
  - a rail that keeps imports pointing inward;
  - a size budget on core, which can grow only with an amendment;
  - no files moving until each is next changed.

### 2026-11 — every `cluster` subcommand is parsed from its declaration

- One hand parser served every `cluster` subcommand. It accepted each
  subcommand's flags for all of them, and ignored the ones that did not
  apply: `cluster generate --destroy` ran a generate. Each subcommand now
  accepts only its declared flags (ADR-0077 Part 3).
- Defaults are stated once, in the declaration, and help shows them:
  - `--dir` defaults to `.`;
  - `--env` defaults to `local` for `k8s` and `lower`.
- `up -d` is declared as `--detach`'s alias. `up` without `--env` is still
  the compose path.
- `cloister cluster` with no subcommand lists the subcommands. It printed
  `cluster generate`'s help instead.
- The test that the committed CLI reference matches the declaration now
  compares the whole page. It checked only that each command had a section,
  so a stale flag or default passed it and failed only in the gate.

### 2026-11 — `add` and `artifacts pull` are parsed from their declaration

- `cloister artifacts pull --help` listed no option but `--help`. Its
  declaration named none, while the command accepted `--print`, `--yes`
  (`-y`), `--allow-unpinned` and input names. `cloister add` accepted
  `--provides` and `--requires`, which its help did not list.
- Both are now declared in full and parsed from the declaration (ADR-0077
  Part 3), so what help lists is what they accept. `add`'s hand-kept help,
  with its ref forms and examples, moved into the declaration.
- A declaration can now state a command's positional arguments, a flag's short
  alias, and examples. Help and `docs/reference/cli.md` render them.
- Every declared command is held to its declaration through the real entry
  point, except an explicit list of commands that still parse by hand. The
  list can only shrink.
- `lint:doc-invocations` checks short aliases. It parses a documented
  invocation of a command that declares its arguments with that command's own
  parser. A `<placeholder>` in a shell fence is read as a word, not as two
  redirections.
- The CLI reference escapes `|` in its tables. Rows such as
  `--color <auto|always|never>` were split into extra cells.

### 2026-11 — ADR-0079 accepted: microVM runs on signed grants

- ADR-0079 is accepted, with its open questions decided:
  - the sign-only helper holds the issuing key, under a key URL used only for
    execution grants (Q1);
  - every grant is signed, in development too, by a development key the helper
    holds, and cloister never passes `--allow-unverified-evidence` (Q2);
  - one execution daemon serves each distinct workspace, plus one for the runs
    that declare none (Q3).
- Two facts from ley-line-open v0.30.0 correct it:
  - a run's executable is named by the `blake3-256` of its bytes, which the
    host runtime reads from the manifest of the rootfs the lock pins;
  - a workspace is named by its tree root, which moves with every accepted
    proposal. So a daemon's catalog is generated at each start, not from the
    lock alone.
- A daemon serving a workspace needs the tree's root in its catalog before it
  starts, and ley-line-open reports the root only from a running daemon.
  cloister will not start a daemon twice to learn it; ley-line-open#602 asks
  for the root to be reported at start. Until then, a microVM bundle that
  declares a workspace stays refused by name. Signed runs without a workspace
  are built first.
- The helper can sign a grant, but not the DSSE evidence it references:
  ley-line-open's envelope is signed only by an in-process key.
  ley-line-open#603 asks for a way to build it from a signature made outside
  the process. Until then the daemon path is built and tested with a key held
  by the test, and no run takes it.
- **The host runtime builds what a signed run needs** (`issue`, behind
  `llo-execution`), with ley-line-open's own types:
  - the RunSpec;
  - the unsigned RunGrant, and the bytes the helper signs for it;
  - the evidence statement, which binds each evidence role to the run;
  - the catalog entry for the run's executable, read from the rootfs
    manifest.
- Its tests run ley-line-open's own authorization, with the DSSE evidence
  verifier, and its catalog on what the host runtime issues for the emitted
  dolt and orders plans. The request they resolve must equal the one the
  direct path builds, so moving a run to the daemon loses nothing. A key the
  daemon does not trust, evidence bound to another run, and a manifest that
  is not the pinned one are each refused.
- The threat model gains §22, execution grant issuance, before the seam is
  live: what a grant is worth, seven attacks with their defenses and tests,
  and what stays open (ley-line-open#602 and #603, and the daemon's state
  directory).

### 2026-11 — a bundle pinned through a multi-image producer runs like any other

- `runtime import --bundle`, `runtime plan` and `cluster up` accept a bundle
  pinned through a multi-image producer, as both notme bundles are. They read
  its pin from the `[[inputs.<input>.ociBundles]]` row that names it, as
  compose already did, and refused such a bundle before.
  - Its imported rootfs rows are recorded on that row.
  - A lock regeneration carries them while the pin holds. Rows are matched by
    bundle, not by position.
  - Refusals name that row, not `[inputs.<bundle>.oci]`.
- One reading of the lock's image pins (`ociBundleClaims` and `ociPins` in
  `cli/lib/oci-artifact.mjs`) now serves compose, the isolation lint, the
  runtime and `artifacts pull`. Each refuses, by name, two producers naming
  one bundle.
- `artifacts pull` pulls a multi-image producer's other images. It read only
  each input's own `oci`, so notme-proxy's image was never pulled, though
  compose runs it with `pull_policy: never`. Naming an input pulls every
  image it pins.
- The isolation lint says why it could not read a lockfile. It used to report
  every image as underivable without saying why.
- notme-identity's rationale no longer lists this as a need.

### 2026-11 — no exemption is described as an impossibility

- The schema's own description of `executionModeRationale` read "Why this
  bundle cannot be isolated", which every editor shows on hover and every
  generated file repeats. It now reads "What this bundle needs that no guest
  placement gives it yet, and the work that ends that: a bead, an issue or an
  ADR". `executionMode` reads "'process' for a bundle that is not yet a
  guest". The zod, JSON Schema, cluster.toml schema and Go projections are
  regenerated, and the hand-mirrored type matches.
- ADR-0062's remaining lines of the old framing carry inline withdrawal
  notes, and CLAUDE.md records the principle: a placement a bundle cannot use
  yet is an engineering effort, not an impossibility.

### 2026-11 — the host runs the platform; every bundle is a guest

- ADR-0080, with Proxmox VE as prior art. The host runs only the platform: the
  host runtime and ley-line-open's execution daemon, the broker and the signing
  helpers. Every bundle is a guest, the gateway included, as a router VM
  fronts a Proxmox cluster. What Proxmox gives every guest is listed as a
  need cloister owes: volumes that outlive a run, services with no wall-clock
  ceiling, channels between guests, and a socket handed into the guest.
- It amends ADR-0062, withdrawing its one "structural and permanent"
  exemption and the two rejections that rested on it. The gateway is workerd,
  which starts no microVMs, so it can be a guest of one.
- `process` now means a bundle that is not yet a guest. Inv 13 refuses a
  `process` rationale that names no exit (a bead, an issue in a named
  repository, or an ADR), or that opens with a retired label: STRUCTURAL,
  PERMANENT, CONTINGENT or UNDECIDED. The four rationales now say what each
  bundle needs to run as a guest.

### 2026-11 — every isolation exemption says what blocks it now

- Two exemptions cited `krunvm.rs:769` as their structural blocker long after
  #262 deleted it and replaced it with ley-line-open's execution API, which
  carries socket channels. Inv 15 (`lint/bundle-isolation.mjs`) now refuses
  a bundle description or rationale that cites a file this repository does
  not have, or a line past its end; another repository's file is cited
  `<repo>:<path>`.
- The four `process` exemptions are rewritten as CONTINGENT, each naming the
  engineering that retires it:
  - the gateway: its record said permanent, on the grounds that a hypervisor
    cannot run inside its own guest. Those are two hypervisors. The gateway
    is the V8-isolate one, a microVM's is libkrun, and workerd in a microVM
    keeps its isolates;
  - notme-identity: more than the missing entryPoint it named, which is now
    known;
  - notme-proxy: it already listens on TCP, which is how the microVM tier
    presents a channel;
  - rosary: it spawns agents, which becomes a request to cloister, and its
    transport listens only on a Unix socket (ley-line-open#601).
- `lint/lib/tracked-files.mjs` is the one `git ls-files` helper the
  conflict-marker rail and Inv 15 share.

### 2026-11 — a bundle declares its needs once, and every placement provides them

- mache was counted as cloister's one isolated bundle, and it could not run as
  one. It said `executionMode = "microvm"` with its listener and its
  `/workspace` path declared as `confinement` grants. The microVM tier applies
  neither, so the host runtime refused its plan at launch, and no gate said so
  earlier: no CI job launches a microVM.
- `cluster.toml` now refuses a bundle placed `microvm` that declares a
  confinement grant (`fs.allow`, `network.allowHosts`, `port`,
  `credentialSource`), naming each and what to declare instead. Which grants a
  facet declares is defined once (`cli/lib/cluster/confinement.mjs`), read by
  the round trip too, and held by a test to the generated schema.
- `cloister-host-runtime validate` now refuses the plans `run` refuses. It
  used to answer "valid" for a microvm plan with a raw listener. One check
  (`Confinement::check_microvm_grants`) serves both, and the launch path.
- ADR-0078: a bundle declares what it needs once, not one tier's grants, and
  every placement gives it each need or refuses by name. Nothing starts a
  bundle without a need it declared, and no need is deleted to fit a tier.
- The workspace is the first such need: `workspace = "read" | "write"` under
  `[bundles.external]`, given at `/work`. Compose bind-mounts
  `${CLOISTER_WORKSPACE:-.}` there; the dev launcher maps `/work` to the
  workspace on the host. A microvm plan carries it as `workspaceAccess`, and
  the host runtime refuses that plan by name until it can give a guest a
  workspace (`cloister-dc4a53`), rather than dropping it as it did.
- mache stays a `microvm` bundle. Its listener is a `[[bundles.ports]]` entry,
  lowered to a `bind` grant on guest port 7532, and it declares its workspace.
  Its compose service now mounts the workspace, which it never had: its
  `--path /workspace` pointed at an empty path in the container.
- The external facet is no longer rebuilt from a hand list of fields
  (`cloister-8ae1f2`): the fields the operator wrote pass through, the schema
  gives the rest their defaults, and a wrong type is refused instead of
  becoming a default. The round trip drops any field left at its default by
  one rule, not a list.
- Filed ley-line-open#600: a service run in a microVM has nowhere to keep state
  across runs, which the identity authority and the gateway both need.

### 2026-11 — the docs are held to the CLI

- `lint:doc-invocations` (in `task lint`) reads every shell fence in the
  docs, ADRs, the CHANGELOG and dated plans excepted, and holds each
  `cloister …` and `task …` line to `cli/surface.mjs` and to Task's own task
  list. It is mache's doc-vs-CLI gate. 128 documented invocations hold.
- It found `cloister runtime import`'s flags declared as `"--layout <dir>"`
  rather than `--layout` with a `value`, which no parser could match; fixed,
  with a test that every declared flag is a bare `--name`.
- `cli/lib/flags.mjs` reads a declared `--` as the end of options and returns
  what follows as `passthrough`.

### 2026-11 — every vendored LLO file is the pinned release's, and CI checks it

- Two vendored copies of ley-line-open spec files were behind the v0.30.0
  cloister pins: the confinement/v1 schema (v0.21.1's, without `guestPort`,
  which cloister's own `runtime plan` emits) and the execution/v1 vectors
  (v0.29.0's, rootfs manifest v1 only). Nothing re-vendored them on a bump,
  and the check that compared them by tag ran only beside an LLO checkout,
  which CI never has. Both are now v0.30.0's; cloister's tests pass against
  them unchanged.
- `gen/vendor-llo-spec.mjs` is the one way to vendor an LLO spec file: from
  git at the pinned commit, checked against LLO's own `VECTORS.sha256`, into
  a directory whose generated `VECTORS.sha256` is headed by the release.
  `task llo:bump` runs it; `task llo:vendor:check` compares; each fixture
  directory is a `lint:upstream-pins` channel.
- The new CI job `llo-checked` clones LLO at the pinned tag and runs the
  vendor check, `lint:spec-citation` and `lint:sibling-bead-refs` with
  `CLOISTER_LLO_REQUIRED=1`, under which a missing checkout fails instead of
  skipping. The harness confinement test reads the vendored schema and no
  longer skips.

### 2026-11 — the CLI's outputs are declared (ADR-0077)

- `manifest/cli.capnp` declares the CLI's JSON outputs; schema-bridge
  generates `src/generated/cli.zod.ts` and the published
  `schema/cli.schema.json` (`task cli:schema`, gated by `cli:schema:check`).
- Every output carries `formatVersion` ("MAJOR.MINOR", after Terraform's
  `format_version`). `schema/cli-formats.lock.json` records each version with
  its shape; `node gen/cli-schema.mjs --bump <Output>` decides the bump from
  the change (minor for an addition, major otherwise), and the gate fails a
  shape that changed without one.
- The CLI parses each output with its generated schema before printing it,
  and refuses one that differs. First: `cluster graph --json`, at 1.0. A
  `minStrength` of no minimum now reads `none` rather than an empty string.
- `--help` always answers, from the declaration, before any command code
  (`cli/help.mjs`).
- `cluster graph` is the first command whose flags are parsed from its
  declaration in `cli/surface.mjs` (`cli/lib/flags.mjs`). It now refuses a
  flag it does not declare (`cluster graph --destroy` used to be accepted and
  ignored), a flag given twice, and a switch given a value. A declared
  default is shown in help from the same entry.
- `inspect --json` is declared too (`InspectReport`, 1.0), as a projection
  chosen field by field (`cli/lib/facts/report-json.mjs`) rather than the
  internal report: nothing from a provider's document passes through
  unchosen. Each finding is `{kind, subject, basis}`, with one variant in each
  union, so its shape no longer depends on which keys happen to be present.
  With no Terraform document, `document.kind` is `""`.

### 2026-11 — cloister is one file

- `task bundle` builds the cloister CLI as `dist/cloister.mjs`, one file that
  needs only Node 22. It replaces the plan-only `dist/cloister-plan.mjs`
  before either was released, so there is one thing to download, not a
  checker beside a CLI.
- It runs the commands `cli/surface.mjs` marks `standalone` (`inspect`,
  `cluster graph`, `cluster lower`, `cluster k8s`): each is run from an empty
  directory by `gen/test/bundle.test.mjs` and must match the CLI's output and
  files exactly. Every other command refuses by name, and answers `--help`
  from its declaration rather than its own code.
- Releases are `cli/v*` tags (`release-cli.yml`); `actions/plan-check` is
  pinned to one and runs `cloister.mjs inspect`.

### 2026-11 — the plan checker in CI

- `cloister inspect --fail-on undeclared,contradicted,unknown` exits 3 when a
  finding of a named kind is reported. A finding never changed the exit code
  before, so a CI check could only grep the text. It refuses to run without a
  cluster.toml, where it would pass having checked nothing.
- `actions/plan-check` runs the check in a GitHub workflow. The result is the
  job's status and summary; it comments on nothing. CI runs it on a plan that
  matches its file and one that does not.
- A `plan-checker/v*` tag publishes `cloister-plan.mjs` and its sha256 as a
  release (`release-plan-checker.yml`), after testing the bundle. Nothing is
  published until a tag is pushed.
- The bundle test runs every sample plan through the bundle and through
  `cloister inspect`, report and draft, and requires identical output.

### 2026-11 — cloister's wire codecs run LLO's own test vectors

- ley-line-open owns the ToolCall / ToolResult / Manifest wire
  (`leyline-net/v1`) and pins twelve vectors in two byte forms, saying
  decoders must accept both. cloister's cross-check loaded only one form.
  Run against both, its decoders refused a Manifest with sequence 0 and a
  ToolCall with no arguments in canonical form (the form rosary writes).
  Both now read an absent field as its default, and the encoder writes an
  empty `argumentsJson` as LLO does.
- The vectors are vendored, digest-checked, into
  `test/wire/fixtures/llo-net-vectors.json` and run by
  `test/wire/llo-net-vectors.test.ts`. `task llo:bump` re-vendors them, and
  `lint:upstream-pins` counts their version as a channel, so a bump cannot
  leave them behind.

### 2026-11 — the plan checker is one file

- `task plan:bundle` builds `cloister inspect` as `dist/cloister-plan.mjs`:
  one file that needs only Node 22. No checkout, no Rust, no Cap'n Proto, no
  Task. [docs/plan-checker.md](docs/plan-checker.md) is a guide to that one
  job, with a sample plan to try.
- What made one file possible, each kept by a test:
  - every "was I started as a script" check goes through
    `cli/lib/started-as-script.mjs`. Thirteen modules compared
    `process.argv[1]` with their own path, which is true for all of them once
    bundled, so a bundle ran every module's `main`;
  - mappings, specs and the published `cluster.toml` schema are JSON imports,
    not files read from beside the module;
  - the generated cluster schema loads through
    `cli/lib/cluster/cluster-schema.mjs`, which a bundle imports directly
    instead of through tsx.
- `gen/test/bundle-plan.test.mjs` builds the file, runs it from an empty
  directory, drafts a `cluster.toml` from the sample, checks the plan against
  it, and flags a call the file does not declare.
- esbuild is now a dev dependency, pinned to 0.28.1, the version tsx and
  wrangler already use. The lockfile had two versions resolved; vite moves
  from 0.28.2 to 0.28.1 with it.
- Not published anywhere yet.

### 2026-11 — cloister can read what rosary sends

- **Fixed:** `decodeToolResult` refused every result rosary returns. rosary
  writes canonical capnp, which drops an all-zero data section
  (`isError = false`, and the tag of a `text` content item). The decoder now
  reads a missing section, or a null pointer, as its default, as the capnp
  spec requires. Found by sending a cloister-encoded tool call through
  notme-proxy into rosary, both built from source; their real reply bytes are
  now a test fixture.
- ADR-0076 (Proposed) records why the companion does not start under compose,
  and what it would take: the socket bridge should start without a bridge
  credential, and the credential itself is notme's to settle.

### 2026-11 — joining a network namespace is declared

- `[[bundles.placements]]` gains `sharesNetworkOf`: the bundle whose network
  namespace this one's container joins under compose, so the two share
  `127.0.0.1`. It replaces a test in the emitter for a bundle named `mache`.
- This repository's mache declares `sharesNetworkOf = "cloister-router"`. The
  compose file it yields is unchanged.
- A cluster with no placement row anywhere is emitted as before, mache
  included. Once a cluster declares placements, a bundle named mache has a
  network of its own unless it says otherwise.
- A new rail holds the declaration to the gateway's image: a compose bundle
  whose `httpPort` is one `config.capnp` dials at loopback must join the
  gateway's namespace.
- Not settled, and written down in ADR-0075 §8: how the gateway reaches
  rosary, the companion and the identity service under compose.

### 2026-11 — a connection between two compose bundles is lowered

- A `[[connections]]` row with a target for env `compose` between two
  compose bundles gets a network of its two ends, and an env row bound to it
  is set to its address. It can ask for a `minStrength`, held to what that
  edge delivers. `cluster graph` reports it like a wire over HTTP.
- Refused by name: such a connection for any other env, one with an end
  compose does not run, and one to a bundle with no name of its own on a
  network.
- **Fixed:** an env row that takes its value from a secret, or from a
  connection, was written into the compose file as an empty value. A
  connection row is now the address. A secret row is refused, because compose
  has no secret store cloister writes to.
- The gateway's own edges are still `[[wires]]`.

### 2026-11 — `compose` is a placement kind

- A bundle is placed `compose` in an env like any other placement:
  `[[bundles.placements]] env = "compose", kind = "compose"`. The compose
  file runs the external bundles placed `compose` for env `compose` and no
  others, and its header names each one it does not run and why.
- An external bundle with no placement rows that is not a microvm is placed
  `compose` implicitly, as a microvm bundle with no rows is placed `microvm`.
- **Compatibility:** a cluster in which no bundle declares any placement row
  is emitted as before, with every external bundle run. The first placement
  row anywhere ends that. From then on a microvm bundle is a compose service
  only if it has a `compose` row, and a wire to one that does not is refused,
  naming the row to add.
- In this repository mache now says both: `microvm` for `local`, `compose`
  for `compose`.
- Several refusal messages changed wording.
- `cluster up` and `runtime plan` name a compose bundle as one when they skip
  or refuse it.

### 2026-11 — compose publishes a port only when it is declared `edge`

- **Changed:** `emit-compose` no longer publishes a bundle's `httpPort` on
  its own. A port reaches the host only if a `[[bundles.ports]]` row declares
  it `expose = "edge"`, the rule every other placement already follows
  (ADR-0069 §2). The compose file carries a comment on each service whose
  `httpPort` is not published, naming the row that would publish it.
- To keep a port on the host, declare it:

  ```toml
  [[bundles.ports]]
  name = "mcp"
  port = 8787
  appProtocol = "art.http"
  expose = "edge"
  ```

  The gateway's 8787 is declared this way in this repository's `cluster.toml`
  and in every recipe. The identity service's 8788 is not, and is no longer
  published.
- A port may now be declared on any external bundle. It was refused on a
  `process` bundle with no placement. A connection to or from such a bundle
  is still refused.
- `task smoke:compose-hold` adds a target with no `edge` port: its caller gets
  a page, and the host cannot reach it.

### 2026-11 — a wire over HTTP is held under compose, and ports publish on loopback

- **Changed:** every published port is now on `127.0.0.1`. It was on every
  interface. A cluster that should be reachable from other machines needs a
  compose overlay that says so.
- **Changed:** no container is on compose's shared `default` network. Each
  wire carried over HTTP is a network of its two ends, and a service on no
  such wire has a network to itself. A bundle that reached another over HTTP
  with no wire between them no longer can.
- `cloister cluster graph` reports such a wire as `capability`, and as `none`
  when a container shares the network namespace of one of its ends. Both HTTP
  wires in this repository's own cluster are `none` for that reason: mache
  runs in the gateway's namespace (ADR-0075 §6).
- `cloister init --port` now fails if the compose file publishes nothing it
  can move. After the port format changed it would have replaced nothing and
  reported success.
- `task smoke:compose-hold` adds an HTTP target and tries it from every
  container by name, by address, and through the host.

### 2026-11 — one tenant's instance cannot open another's socket

- A `perTenant` bundle's instances each bind in a directory of the tenant's
  own, mounted into that instance and the bundles whose wire reaches that
  tenant. `cluster graph` reports such a wire as `capability`.
- **Moved:** `TENANT_SOCKET`, and the address a wire to one tenant hands its
  source, are now `<dir>/<tenant>/<file>`. They were `<dir>/<stem>.<tenant><ext>`
  in a directory every instance shared. An instance that binds
  `TENANT_SOCKET` needs no change.
- A tenant name that cannot be a directory name is refused.
- `task smoke:compose-hold` now starts two tenants and has each try the
  other's socket.

### 2026-11 — a wire to a socket is held under compose

- `emit-compose` gives each socket directory its own volume and mounts it
  only into the bundles that bind there or have a wire to one that does. A
  bundle with no socket and no such wire mounts none. The one `cloister-uds`
  volume in every container is gone; volumes are named for their directory.
- `cloister cluster graph` reports a wire as `capability` when only the
  target and its declared callers hold the directory, and otherwise `none`
  with the bundle that can also open the socket named.
- **Moved:** rosary binds `/run/cloister-uds/rosary/rosary.sock`, and the
  companion's dial of it is declared as a wire (`notme-proxy → rosary`). In
  `recipes/multi-tenant-smoke` each tenant has a directory of its own, so one
  tenant can no longer open the other's socket.
- A cluster that keeps every socket in one directory still works, and is told
  per wire who else can open it. A socket path that is relative, directly
  under `/`, or in a directory compose's mount syntax would misread is now
  refused.
- `task smoke:compose-hold`, a new CI job, starts an emitted cluster and has
  every bundle try every wired socket (ADR-0075 §5).

### 2026-11 — the architecture document says one thing

- `docs/ARCHITECTURE.md` opens with the one idea (declare which part may
  reach which; the place each part runs enforces it, at a stated strength),
  a table of what holds an edge in each placement, and a list of where the
  code is not yet one thing.

### 2026-11 — an address kept in a secret can be declared

- An env row may set `secret` and `connection` together: the value comes
  from the secret, and the secret holds that connection's address. This is
  how a database URL, which carries a password, becomes an edge of the graph.
- Nothing is written as the address and no secret is ever read. `cluster k8s`
  and `inspect` report the edge as declared, not observed; the finding stays
  `unknown`.
- The edge is enforced the same as any other: the policy comes from the
  connection.

### 2026-11 — who may call a service is compared with the declared connections

- `inspect --env` holds each declared connection beside the plan's access
  rows. A row that grants the caller's own service account is `evidenced`; a
  public row is `contradicted`; a row for a workload that declares no
  connection is `undeclared`; no row is `unknown`.
- A caller is matched by the service account the plan says it runs as, never
  by a similar name.
- An evidenced grant does not raise an edge's strength. A plan shows who is
  granted, not that nobody else is.

### 2026-11 — an https address to a Knative bundle is no longer "the wrong port"

- `cluster k8s` accepts a manifest that dials a knative-placed bundle as
  `https://<name>.<namespace>.svc` (or `wss://`). A Knative Service answers
  on 443 where the cluster's Knative has internal encryption turned on, so
  the address names the same connection. The command says that it depends on
  that setting, which no manifest shows.
- Port 443 with no scheme, https on another port, and https to a plain
  Kubernetes bundle are still held to the declared port.

### 2026-11 — a bundle may be called something else where it is deployed

- `[[bundles.placements]]` rows take a `name`: what the bundle is called in
  that environment's plan or manifest. `inspect --env <name>` matches a
  rendered resource to the bundle by it, so a service that is `orders`
  locally and `orders-api-prod` in the cloud is compared as one thing.
- Nothing is matched by likeness. Two bundles that would share a name in one
  environment are refused, and without `--env` the report says the names
  were not applied.
- The schema's description of a placement's `manifest` no longer says it is
  required.

### 2026-11 — a connection's address reaches a microVM

- An env row bound to a connection is lowered for a microVM placement: the
  launch plan sets it to `<scheme>://127.0.0.1:<guestPort>` plus the row's
  path. That is the address a dial grant presents in the guest
  (confinement/v1 §6). The port comes from the same pass that builds the
  grant, so the two cannot disagree.
- A protocol with no URL form is refused, and the refusal says where the
  channel is presented. A row bound to a secret is still refused for a
  microVM: a launch plan carries no secret.

### 2026-11 — Kubernetes resources declared in Terraform are read

- `cloister inspect --terraform` reads Deployments, StatefulSets, DaemonSets,
  Jobs, Services and Namespaces declared with the Kubernetes provider. It is
  a mapping file (`cli/lib/facts/mappings/kubernetes.json`): no code names
  the provider.
- The reader gained three things any mapping can use: a scalar inside a
  single nested block (`metadata.name`), an address built from what a
  resource reads (a cluster DNS name), and a resource that stands for
  another (a Service, for the workload its selector matches). A Service that
  matches no workload, or two, stands for neither.
- A mapping entry may be `like` another, with its differences laid over.
  The Kubernetes mapping writes the pod template once; the other workload
  types refer to it, and a test runs every one of them.
- A literal env value that is the address of a workload is drafted as a
  binding to its connection, with the path after it.
- A `kubernetes` or `knative` placement row may omit `manifest`: the
  placement is then described by a plan. `cluster lower` and `cluster k8s`
  refuse such a row by name, and `cluster graph` shows its edges as `none`.

### 2026-11 — an upstream's own error text reaches the caller

- When a proxied tool fails with a plain-text message, the caller now gets
  that message (up to 2000 characters). It used to get `tool <name> failed`,
  which hid remedies the upstream had written out. The `leylineNet` backend
  already passed the text through.

### 2026-11 — one graph: wires and connections together, each with what holds it

- `cloister cluster graph --env <name>` prints every declared edge: each
  `[[connections]]` row with a target in the environment, and each `[[wires]]`
  row. For each it says what carries it, its strength, and the mechanism in a
  sentence. An edge nothing enforces is shown as `none`, with the reason
  (ADR-0075).
- A wire under `cluster up` is `none`: compose gives every container the one
  socket volume. That was true before and is now stated. A test ties the
  statement to the compose emitter.

### 2026-11 — every diagram is parsed, and the gate covers every job

- `mermaid:lint` runs mermaid's own parser over every diagram in every
  tracked markdown file (34 in 17 files). It was a hand check of two named
  files. `mermaid` and `jsdom` are pinned dev dependencies.
- `ci-ok` needs every CI job and is the one check to require. A push to
  `main` no longer cancels the run before it.
- The full-stack smoke's binaries are checked against pinned digests: the
  engine through `schema-bridge.lock.json`, mache (v0.22.0) in the workflow.
  The smoke starts mache with `--path`. A mache newer than v0.19.0 needs a
  project pinned when the client declares no roots: cloister passes on only
  the roots a client declared on `initialize`, and mache now treats an empty
  answer as an error.
- `task test:lint-scripts` is now `task test:node`.
- `dev/lowered-kind.sh drafted` runs the whole path on a real cluster: a
  rendered Terraform plan is drafted into `cluster.toml`, lowered unedited,
  applied to kind, and the graph is observed. It runs in the `lowered-kind`
  CI job.
- `docs/ARCHITECTURE.md` covers describing and checking a system, and was
  corrected where it had drifted.

### 2026-11 — the Knative lowering is applied to a real cluster in CI

- **`task smoke:lowered-knative`**, and a CI job of the same name, installs
  Knative Serving and Kourier on a kind cluster (pinned by release and by
  digest), lowers `test/e2e/lowered-knative/cluster.toml`, applies it, and
  observes: the Knative Service has no route from outside; a kubernetes pod
  gets an HTTP answer from it through Knative's ingress; its own pod reaches a
  kubernetes Service; and an undeclared pod is refused there.
- `dev/lowered-kind.sh` takes the scenario as its argument (`kubernetes` or
  `knative`).
- **`cluster k8s` writes a directory for a knative bundle too**: its manifest,
  copied unchanged, and the Namespace its Service names when the manifest does
  not declare it. Before, every bundle had a directory to `kubectl apply`
  except the knative ones, and nothing created their namespace. No
  NetworkPolicy is written for one. The printed apply lines now name each
  directory's namespace.

### 2026-11 — `expose` per placement

- **A placement row may set a port's `expose` for that placement only**
  (`[[bundles.placements.ports]]` gains `expose`; `port` is now optional).
  A service that is public in production can be declared internal on a local
  cluster. A row may not open a port the bundle keeps to itself.
- **`inspect --draft --local <env>` writes that row** when the plan says a
  service can be reached from outside. Without it, such a draft could not be
  lowered: Cloud Run's default `ingress` admits outside traffic, the draft
  says `edge`, and `cluster k8s` does not publish an edge port on Kubernetes.
- `inspect --env <name>` compares the plan with the port as that
  environment's placement declares it.

### 2026-11 — `inspect` compares a port's `expose` with the plan

- **`expose` is checked against what the plan says about reaching a workload
  from outside.** For Cloud Run that is `ingress`. Each exposed port of a
  bundle is `evidenced`, `unknown` (the plan does not state the setting, or
  states a value the mapping does not sort), or **`contradicted`**: the two
  disagree. A port declared `expose = "cluster"` on a service whose `ingress`
  admits outside traffic is the case this exists for.
- **A draft takes `expose` from the plan.** A service that can be reached from
  outside is drafted `expose = "edge"`, and the draft says so. When the plan
  does not say, it is drafted `cluster` and flagged to check.
- A provider mapping names the setting and sorts its values
  (`report.bundle.exposure`). The comparison names no provider.

### 2026-11 — lowered manifests are applied to a real cluster in CI

- **`task smoke:lowered-kind`**, and a CI job of the same name, lowers
  `test/e2e/lowered-kind/cluster.toml`, applies the result to a kind cluster,
  and observes three things: a declared caller reaches the server at the
  address lowering wrote, a declared Job runs to completion, and an undeclared
  pod is refused. The refusal is the point: it is the first time strength
  `policy` is seen and not asserted. The job fails if the cluster does not
  enforce NetworkPolicy.

### 2026-11 — a port is listened on and dialled; Knative lowering

- **`[[bundles.placements.ports]]`** sets the number a port is DIALLED on in
  one placement, when it is not the number the workload listens on. A Knative
  Service is dialled on 80 whatever its container binds. A port with no row is
  dialled on its own number, so existing files are unchanged. Forwarded
  placements only.
- **`cluster lower` writes a Knative Service** for a bundle placed `knative`,
  from the same bundle a Kubernetes manifest is written from. On Kubernetes a
  dialled port becomes the Service `port` and the bundle's port the
  `targetPort`.
- **`inspect --draft --local <env> --local-kind knative`** places services on
  Knative with the dialled port set. A job stays a Kubernetes Job.
- **`expose` is held to Knative's route visibility.** A knative bundle whose
  port is `expose = "cluster"` must carry
  `networking.knative.dev/visibility: cluster-local`; one that is
  `expose = "edge"` must not. `cluster lower` writes the label. **This is a
  new failure for an existing Knative manifest that lacks the label**: without
  it the Service has a route from outside the cluster. `expose = "edge"` on a
  knative bundle was refused and is now checked.
- **Edges between `kubernetes` and `knative` are lowered.** They were refused.
  A Knative caller is admitted by the Kubernetes target's NetworkPolicy
  (strength `policy`); a Kubernetes caller reaches a Knative target that has
  none (strength `none`). So a plan with services and a job lowers whole to
  Knative.
- **`cluster lower` is all-or-nothing.** If one bundle cannot be lowered, no
  manifest is written.
- `cluster k8s` on a Knative bundle whose port is not dialled on 80 now says
  which row to add.

### 2026-11 — one description, lowered to each placement

- **`cluster.toml` carries what a workload is started with.** An env row takes
  its value from exactly one of `value` (a literal), `connection` (the address
  of one of the bundle's connections, with an optional `path`) or `secret` (a
  reference, with an optional `secretKey`). `[bundles.external] runs` is
  `service` or `job`. All appended fields; existing files are unchanged.
- **`cloister cluster lower --env <name>`** writes each kubernetes-placed
  bundle's manifest from `cluster.toml`: a Deployment and a Service, or a Job.
  A `connection` row is set to that connection's address in this placement. A
  `secret` row becomes a `secretKeyRef`. It reads nothing but `cluster.toml`,
  never overwrites a manifest, and applies nothing.
- **`inspect --draft` fills the bundle from a plan**, and `--local <env>` adds
  a kubernetes placement for a second environment. A value taken from a
  variable is not drafted and is named at the top.
- **Env is read from the plan's configuration.** A provider may mark a whole
  env block sensitive because one variable is, which withheld every row. The
  configuration still tells a constant from an address from a variable.
- **`cluster k8s` accepts a bundle with no exposed port and no Service.**
- **`runtime plan` refuses a `connection` or `secret` env row by name.** The
  microVM lowering of a binding is not built.

### 2026-11 — `inspect --draft` writes a first cluster.toml from a plan

- **`cloister inspect --terraform <file> --draft --env <name>`** prints a
  `cluster.toml`: one bundle per workload (name, image, ports, placement) and
  one connection per edge the plan implies. It is printed, never written, and
  an existing `cluster.toml` is not read.
- **The draft says what it could not see**, at the top: an env block marked
  sensitive, a port that was assumed from the provider's default, an edge
  whose target is not a workload, a resource type no mapping reads.
- **Any forwarded placement may be a connection end** (ADR-0074 §6), with
  strength `none` unless an emitter enforces it. Before, a bundle placed
  `cloudRun` could not be one, so a Cloud Run deployment could not be
  declared. A `minStrength` above what the two ends provide still fails the
  build.
- **A provider mapping declares how its workloads become bundles**
  (`report.bundle`: placement kind, image, ports, and which `appProtocol` each
  wire maps to). The draft names no provider.

### 2026-11 — `inspect` compares a hand-written cluster.toml with the graph a plan implies

- **Declared connections are checked.** With a `cluster.toml`, each declared
  connection is `evidenced` (its source is started with something that names
  its target) or `unknown`. An edge the plan implies from a declared bundle,
  with no connection for it, is `undeclared`.
- **Services nobody added are listed.** Workloads in the inputs that
  `cluster.toml` has no bundle for.
- **A bundle and a resource are the same thing when they have the same name**,
  exactly. Nothing else joins them.
- **`--env <name>`** narrows the comparison to one environment's targets.
- ADR-0074 (Proposed) says where this is going: the graph is derived from
  rendered output, and `cluster.toml` holds intent.

### 2026-11 — `inspect --terraform` reads what a Cloud Run container is started with, and what it dials

- **Nested blocks are read.** A Cloud Run service's or job's containers, env,
  args, command and ports sit in nested blocks. A mapping's `lists` path may
  now walk through blocks and through lists of lists. The spec projection
  includes a block only where a mapped path goes through it.
- **The report shows what each service or job dials.** In a state document, a
  string that holds another service's address. In a plan, where the address is
  unknown until apply, what the configuration says the value is taken from,
  named by env var: `dials: reconciler (Cloud Run services; referenced by
  configuration in env RECONCILER_URL)`.
- **Sensitive values are not read, and the report says when a list was
  withheld.** Terraform marks a whole env set sensitive when one value is.
  The edge is still found from the configuration.
- **Tested on a document the real tool wrote.**
  `test/fixtures/terraform/google-plan.show.json` is `tofu plan` and `tofu
  show -json` output for `google-plan.tf`, produced offline and trimmed.
- ADR-0073 §3 describes it.

### 2026-11 — cluster.toml has a published JSON Schema

- **The schema.** `schema/cluster.toml.schema.json`, generated from
  `manifest/cluster.capnp` by LLO's schema-bridge (its JSON Schema output, now
  pinned beside the zod and Go ones) and then reshaped for TOML. An editor can complete and check a `cluster.toml` with it, and
  another tool can read one without copying the parser. See
  `docs/reference/cluster-toml-schema.md`.
- **Fields have descriptions.** `cluster.capnp` now carries a one-line
  `$Traits.doc("...")` on the structs and fields an operator writes most (88
  of them). LLO's generator turns each into a `description` in the schema,
  which an editor shows on hover, and into a doc comment in `cluster.zod.ts`
  and `pkg/cluster/cluster.go`. LLO's annotation file is vendored unchanged at
  `manifest/_traits.capnp`.
- **It is written the way an operator writes TOML.** A union is `kind =
  "external"` beside a `[bundles.external]` table, and inputs are keyed by
  name.
- **The parser now refuses any key the schema does not define.** Several
  tables were rebuilt field by field, so a typo'd key in `[gateway.policy]`, a
  vault proxy service, a skill, an edge, or under `[bundles.confinement.*]`
  parsed clean and was dropped. Each is now an error that names the key. This
  can refuse a file that was accepted before.
- **Kept in step.** `task cluster:jsonschema` and `task cluster:toml:schema`
  regenerate it, and each has a drift check in `task lint`. A test holds every
  `cluster.toml` in the tree, and everything the writer emits, to it.
- The repo's JSON Schema validator read a schema-valued
  `additionalProperties` as "anything goes". It now applies it, and it reads a
  boolean as a schema.
- **Checked against Ajv and taplo.** Both accept every `cluster.toml` in the
  tree. A typo'd key is named by taplo, which is why a union's tables sit on
  the struct and not inside `oneOf` branches.
- **`cluster k8s` reads manifests as they are exported.** A `kubectl get -o
  yaml` List is unwrapped, and one file holding several Knative Services can be
  shared by the bundles in it: each takes the Service with its name. Found by
  running the upstream Knative samples through it.

### 2026-11 — Platform admission is answered by LLO, not mirrored (`cloister-b94b14`)

- **New host-runtime verb.** `cloister-host-runtime platform-admits --platform <p> <candidate>...`
  prints which candidates LLO's `Platform::admits` admits, and which overlap
  (either admits the other).
- **The JS mirror is gone.** `platformAdmits` and `platformsOverlap` are deleted
  from `cli/lib/runtime/platform.mjs`; `selectRootfs` and `recordRootfs` take an
  `admits` function, which the commands wire to the verb.
- **Needs a current runtime.** An installed runtime that predates the verb is
  refused with `Run: cloister runtime install`.
- **A rail keeps it out.** A test fails if any file under `cli/` defines or calls
  a platform-admission function.

### 2026-11 — quinn-udp 0.5.16 (`cloister-a0a6c0`)

- RUSTSEC-2026-0538 (a receive loop can spin after a truncated datagram) is
  fixed in quinn-udp 0.5.16. It reaches the host runtime through LLO's
  runtime and its sigstore dependencies. Both lockfiles move to 0.5.16;
  nothing else changes, and `ureq` stays at 3.3.0.

### 2026-11 — `cluster k8s` holds a manifest's addresses to the declared connections (#311)

- **What is read.** The strings a container actually starts with: its
  environment, `args` and `command`, for `kubernetes` and `knative` placements.
- **The environment is resolved, not just scanned.** `envFrom`, then `env`
  with later entries overriding earlier ones, `valueFrom` keys of ConfigMaps
  and Secrets in the manifest, and variable references expanded. Only the
  value that wins counts. A reference to a ConfigMap or Secret outside the
  manifest is reported as unread.
- **Addresses, not URLs.** A URL, a bare `host:port` and a DSN all name a
  host. The cluster DNS name of a placed bundle's Service is recognised
  anywhere; a short name only in host position.
- **Refused by name.** An address naming another bundle that `cluster.toml`
  declares no connection to, and an address on a port no declared connection
  reaches. This can refuse a manifest that was accepted before.
- **Reported, not refused.** A cluster DNS name that is no placed bundle, and
  a declared connection that no value names.
- A value is never printed, only the host and port recognised in it.
- ADR-0070 §2 carries the amendment.

### 2026-11 — `knative` placement: connections checked, nothing lowered (#311)

- **A new placement kind, `knative`.** Its strength is `none`. A connection
  that sets `minStrength` above `none` on a knative end fails the build by
  name; one that does not is checked.
- **Why a kind and not a mode of `kubernetes`.** An edge's strength is computed
  from the placement kind before any manifest is read. A Knative Service under
  a `kubernetes` placement would be reported as `policy` with nothing
  enforcing it.
- **What `cluster k8s` checks for it.** Exactly one Knative Service in the
  manifest; the declared port is 80, the port a peer dials; the declared
  `appProtocol` fits the wire the Service serves (`http1` or `h2c`).
- **What it writes for it: nothing.** No copy, no namespace, no policy. A
  cluster of only knative bundles leaves `--out` untouched and prints what was
  checked and the address each bundle is reached at.
- Several knative bundles may share a namespace. An edge between a
  `kubernetes` and a `knative` bundle is refused.
- ADR-0070 §2 carries the amendment.

### 2026-11 — `cluster k8s` identifies objects by API group and kind (`cloister-991e65`)

- **The bug.** The manifest reader matched `kind: Service` without looking at
  `apiVersion`. A Knative Service has the same kind, so it was read as a core
  Service and refused for having no `spec.selector`, which a Knative Service
  never has. Beside a core Service it was counted as a second one.
- **The fix.** An object is identified by API group and kind; the version is
  not part of identity. Only a core `v1` Service and Namespace are read.
- **Knative is refused by name.** A `serving.knative.dev` Service is not
  lowered yet, and the refusal says why: its requests go through Knative's own
  ingress and activator, which the NetworkPolicies this command writes do not
  describe. ADR-0070 §2 said Knative was supported; it now records that it is
  not built.
- A document with no `apiVersion` is refused.

### 2026-11 — `inspect --terraform`: Cloud Run invoker rows join from state (#308)

- **The bug.** In a state document a Cloud Run IAM binding names its service
  by full path (`projects/P/locations/L/services/S`; the v1 binding type adds a
  `v1/` prefix) and the service keeps its short name. The two were compared as
  strings, so a state document reported no invokers at all.
- **The fix, with no identifier parsing.** A relation may now list several
  target attributes to try, scope attributes that must agree, and a prefix to
  strip. The Cloud Run bindings join on the service's full `id` first, then on
  its `name` within the same project and location. All three options are
  mapping data and work for any provider (ADR-0073 §3).
- **Same-named services are not confused.** Two services called `api` in
  different regions each get only their own bindings. When a short name fits
  several services and nothing says which, the relation stays unresolved.
- **Cloud Run jobs are read.** `google_cloud_run_v2_job` and its IAM member
  rows are mapped, so jobs appear with their invokers instead of being counted
  as skipped.
- **Report sections are declared in the mapping.** A type's `report` block
  names its section and the attributes to show; an `access` block says which
  roles to show, under what label, and which principals mean "anyone". The
  report names no Google type or role in code. The JSON report's `cloudRun`,
  `databases` and `queues` keys are replaced by one `sections` list, and the
  text says `(public)` where it said `(publicly invocable)`.
- A synthetic state fixture covers it: `test/fixtures/terraform/google-state.show.json`.

### 2026-11 — Confinement digest no longer depends on a serde_json feature (`cloister-d95ff5`)

- The §7 canonicalizer now sorts object keys explicitly instead of relying on serde_json's `Map` being a sorted `BTreeMap`, which only holds while `preserve_order` is off.
- A workspace-wide build turned `preserve_order` on and broke two `confinement_digest` tests; the published digest is unchanged.
- One shared `cloister_cas::canonical_confinement_json` replaces three copies (test, example, dev-cert minter); it is native-only, so the wasm artifact is unchanged.
- `task rs:verify` now also runs the whole workspace with `llo-execution`, so feature unification is covered by the gate.
- `cargo test -p cloister-cas` (in `task lint`) now builds serde_json with `preserve_order` on for tests, so the explicit sort is exercised in the fast gate too. Before, deleting the sort left that run green.

### 2026-11 — Declared environment reaches the microVM (`cloister-2af426`)

- **Env is lowered into the plan.** A bundle's `[bundles.external]` `env`
  entries (`name`, `value`) now appear in `cloister runtime plan` output as a
  top-level `environment` array, in declaration order.
- **No env, no key.** A bundle that declares none produces a plan
  byte-identical to before.
- **The host runtime sends it.** `LaunchPlan` carries `environment`, and the
  execution request fills LLO's `public_environment` from it instead of
  sending an empty map.
- **Refusals before start.** The plan emitter and `LaunchPlan::validate` refuse
  an empty name, `=` or NUL in a name, NUL in a value, a non-string value and a
  duplicate name. The error names the bundle and the variable, never the value.
  `KRUN_`-prefixed names are left to LLO's worker to refuse.
- **Values are not secrets.** They are stored in the plan in clear. Credentials
  go through vault slices.
- **A mis-shaped `env` is refused, not dropped.** `cluster.toml` parsing used
  to turn anything but a list into an empty list, so `[bundles.external.env]`
  with `KEY = "value"` pairs parsed clean and the workload started without the
  variables. That shape, a list of strings, and a non-string name or value are
  now refused by bundle and variable name.

### 2026-11 — `cloister inspect` ignores an inherited git environment (`cloister-10804d`)

- `cloister inspect` refuses a rendered Terraform document that git tracks.
  The check ran git with the caller's environment. Inside a git hook that
  environment names the hook's repository, so the check answered for the
  wrong repository and could report a tracked document as untracked. Git's
  own variables are now removed before git is run.
- The check's tests had the same fault. Run from the pre-push hook, their
  `git add state.json` staged that file into the index of the repository
  being pushed, and every second push failed the gate. They now run git
  with a clean environment, and a new test proves another repository's
  index is left alone.

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
  [`scripts/lint-lockfile-drift.mjs`](lint/lockfile-drift.mjs)
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
  [`scripts/lint-doc-links.mjs`](lint/doc-links.mjs) walks
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
