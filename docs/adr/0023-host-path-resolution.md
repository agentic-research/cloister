# ADR-0023 — Host path resolution: `CLOISTER_DO_PATH` env-var override

- **Status:** Accepted (2026-05-16)
- **Tracking bead:** `cloister-addcdd`
- **Triggers:** macOS users hit `mkdir: /data: Read-only file system` on
  first `task serve:local`. Apple's signed system volume (SIP, since
  10.15 Catalina) disallows writes under `/` outside specific
  firmlinks. The repo's documented `sudo mkdir -p /data/do` workaround
  fails for every macOS reader.

## Context

`/data/do` is the host-side DO SQLite storage path. It lives in two
places:

- `apko.yaml:50` — declares the OCI image's expected mount point.
- `config.capnp:71` — declares the `do-storage` disk service workerd
  reads at boot.

The path was chosen to match the apko/OCI image's writable-by-uid-65532
mount point. On Linux + inside the container that path is writable;
on macOS hosts running `task serve:local` directly (not via docker)
the path is on the read-only system volume and can't be created.

Today's only workarounds are (a) install via docker so `/data/do` is
inside the container's writable filesystem, (b) edit
`/etc/synthetic.conf` + reboot to create a firmlink, or (c) hand-edit
`config.capnp` (creates a per-machine fork, drift-lints fail). None of
these are good for an OSS project's "git clone, task dev, it works"
target.

## Decision

Introduce a single host-side env-var indirection:
**`CLOISTER_DO_PATH`** (default: `/data/do`). The
`scripts/emit-workerd-config.mjs` build step substitutes the resolved
value into `dist/config.capnp`'s `do-storage` service entry at build
time. workerd reads the substituted value; nothing in the source
config.capnp changes.

### Resolution contract

| Priority | Source | Notes |
|---|---|---|
| 1 | `CLOISTER_DO_PATH` env-var | Must be an absolute path. Build fails fast with a clear error if relative. |
| 2 | `/data/do` (fallback) | Matches `apko.yaml`. OCI image + Linux hosts that set up `/data/do` keep working unchanged. |

### Non-goals (deliberately deferred)

- **Full XDG migration** — `$XDG_DATA_HOME/cloister/do`, `$XDG_CONFIG_HOME/cloister/`, etc. This ADR is the *mechanism*; XDG-resolution defaults are a follow-on decision once the path indirection lands. Operators today can already set `CLOISTER_DO_PATH="$XDG_DATA_HOME/cloister/do"` if they choose.
- **Per-bundle path overrides** — every bundle in cluster.capnp has its own state; making each independently overridable is part of the Layer-2 addressability work (cloister-ae4ed2 / the pending network-identity ADR), not this one.
- **Auto-migration from `/data/do`** — operators with existing `/data/do` state who switch to a new path are on their own; documented as a manual `cp -r` step.

## Consequences

- macOS hosts can run `task serve:local` directly with one env-var: `export CLOISTER_DO_PATH="$HOME/.local/share/cloister/do"` (or anywhere writable). No `sudo`, no firmlinks, no docker required for the dev path.
- The OCI image keeps working unchanged: `apko.yaml`'s `/data/do` mount + `config.capnp`'s default fallback align.
- `lint:paths` still passes — the drift linter reads source files, not emitted `dist/`. Override is build-time only.
- `task build:local`'s cache key doesn't include env vars, so changing `CLOISTER_DO_PATH` requires `task build:local --force` (documented in the script's startup log + README). The trade-off: CI repeatability stays clean (env-var noise doesn't trigger spurious rebuilds), at the cost of one extra `--force` flag for operators changing the path. Acceptable; the more expressive option (full env-var fingerprinting in task sources) is over-engineering for a single var.

## Implementation

`scripts/emit-workerd-config.mjs` extension — locator-pattern
substitution matching the existing modules-array substitution shape:

1. Read `CLOISTER_DO_PATH` from env, default `/data/do`.
2. Validate it's an absolute path (die early with a clear error if not).
3. Locate the `do-storage` service entry in the loaded template, then walk forward to its `disk = ( path = "...", ... )` string literal.
4. Replace the string body with the resolved value.
5. Validate the substitution landed (the resolved path must appear inside the do-storage entry; guards against locator regressions silently emitting unfixed config).
6. Log the resolved path on success, annotating `(default)` vs `(via CLOISTER_DO_PATH)`.

The source `config.capnp` keeps `/data/do` as a literal — it remains valid capnp, parseable by `capnp eval`, lintable by `lint-paths.mjs`, and matchable against `apko.yaml` per the existing drift checks. The substitution happens only on the emit path to `dist/config.capnp`.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Hand-edit `config.capnp` per-machine | Creates per-host forks; breaks `lint:paths`; not a clean OSS story. |
| Synthetic firmlink (`/etc/synthetic.conf` + reboot) | Heavy: requires reboot, edits `/etc`. Documented as a last-resort workaround, not the default. |
| Run via docker (`task image && docker run`) | Works but doubles the dev-loop cycle time (image build + container start) for what should be a `task dev`-equivalent action. Kept as a documented alternative. |
| Two config files (`config.capnp` + `config.local.capnp`) | Doubles the drift-lint surface; doesn't honor env-var. |
| Full XDG resolution module at task-start | Larger scope; this ADR is the minimum-viable indirection that unblocks macOS today. XDG is a defaults decision built on top of this mechanism. |
| Capnp imports / preprocessor | Capnp has no env-var substitution. Either we generate the file or we hand-edit it. We chose to generate. |

## Migration path forward

Future XDG ADR (if/when we adopt it) would change the **default** from `/data/do` to `$XDG_DATA_HOME/cloister/do` (with the documented XDG fallback chain). The env-var name `CLOISTER_DO_PATH` and the substitution mechanism stay; only the fallback changes. Operators with `/data/do` mounted (OCI deployments) would set `CLOISTER_DO_PATH=/data/do` explicitly to keep the old behavior, or rely on the apko image continuing to set that env-var inside the container.

The Layer-2 addressability work (cloister-ae4ed2) may extend this to per-bundle overrides (`CLOISTER_<BUNDLE>_DO_PATH` or similar) once the bundle-identity schema additions land.

## Tracking

- Bead: `cloister-addcdd` (this ADR's implementation).
- Follows: doc-only `cloister-a3681d` / PR #5 (macOS SIP warnings) — that PR's verbose macOS-specific callout can shrink to "set `CLOISTER_DO_PATH`" once this ADR lands.
- Future: XDG defaults ADR (number TBD); Layer-2 per-bundle overrides ADR (number TBD).
