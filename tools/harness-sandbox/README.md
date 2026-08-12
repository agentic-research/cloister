# harness-sandbox — kernel-level harness confinement via nono

This is the **pluggable sandbox behind cloister's UDS/HTTP seam**
(cloister-24717d, ADR-0040/0024 credential-isolation plane). The agent
harness runs kernel-confined; its only way out is the seam cloister
already exposes — localhost HTTP (`http://127.0.0.1:<port>/vault/proxy`)
and unix sockets. That confinement **is** the isolation: v8's isolate
boundary protects cloister's inside; this protects the host from the
harness.

- **Today: the [nono](https://nono.sh) CLI.** Constellation-native (LLO's
  `ll-open/sign` already depends on the `nono` crate), capability-based,
  kernel-enforced — Seatbelt on macOS, Landlock on Linux, one flag
  surface for both. No VM.
- **Later: libkrun (ADR-0044).** The stronger swap-in — a hardware-backed
  microVM behind the *same* seam. Nothing about the shim, the vault
  proxy, or the transport changes when the provider swaps; only the
  confinement mechanism does.

## What the confinement enforces

| Surface | Policy |
|---|---|
| `$HOME` | **Denied by default** — `~/.ssh`, `~/.aws`, dotfiles, everything. Kernel `EPERM`, not convention. |
| Workdir | `-a <workdir>` — the rw workspace (recursive). |
| Harness state | `-a ~/.claude` + `--allow-file ~/.claude.json` — its own config/session state and (audit mode) its OWN credentials. |
| Network (outbound) | `--block-net` + `--open-port <shim port>` — external connects fail `EPERM` before a packet leaves. Port-filtered on both platforms. `--allow-unix-socket <path>` for UDS seams. |
| Network (bind/inbound) | **macOS: NOT restricted.** Seatbelt cannot filter bind or inbound by port, so nono emits an unqualified `(allow network-bind)` + `(allow network-inbound)` whenever localhost TCP is permitted at all — verified in the locked nono 0.70.0, `src/sandbox/macos.rs:812`. A confined harness may open a listener on any port and accept from any source; that is a channel out of the sandbox which does not traverse the vault proxy and emits no receipt. Linux (Landlock V4+) does restrict it. Tracked as `cloister-2d420c`. |
| System | nono default-allows system/toolchain paths + `/tmp` so binaries load. Don't stage secrets in `/tmp` — `$HOME` is the protected surface. |

## Usage

Wired into the ADR-0042 turnkey run:

```sh
SANDBOX=nono task harness:dev
```

launches cloister (:8787) + the lease shim (:8799), then the harness
(`HARNESS_CMD`, default `claude`) under `nono run` with
`ANTHROPIC_BASE_URL` pointed at the shim and `ANTHROPIC_API_KEY`/
`AUTH_TOKEN` stripped from the confined env. `SANDBOX` unset keeps the
existing print-the-export-line behavior. `HARNESS_WORKDIR` overrides the
workdir (default: cwd).

Standalone shape:

```sh
nono run -a <workdir> --allow-cwd \
  -a ~/.claude --allow-file ~/.claude.json \
  --block-net --open-port <cloister-port> \
  [--allow-unix-socket <sock> | --allow-unix-socket-dir-bind <sockdir>] \
  -- <harness cmd>
```

## Deliberate non-overlap: nono's credential proxy is NOT used

nono ships its own credential-injection reverse proxy (`--credential`,
`--proxy-port`) plus rollback + audit. Cloister already IS the
credential plane here — `/vault/proxy` holds custody (or receipts the
harness's own auth in audit mode). **Do not double-proxy.** nono is used
strictly for filesystem + process confinement. Whether cloister should
some day *delegate* credential injection to nono's proxy (or keep its
own) is an open design question — a future ADR, not this wiring.

## §8 confinement commitment (cloister-c80953)

The policy may carry an optional `confinement` block — the confinement/v1
manifest this workload is bound to, plus its Interlace identity cert and the CA
master pubkey:

```json
"confinement": {
  "manifest": { "version": "cloister/confinement/v1", "fs": { … }, … },
  "cert_der_b64url": "…",
  "master_pub_b64std": "…"
}
```

When present, the runner — **before** the irreversible `Sandbox::apply` —
`verify_cert_chain`s the cert against the master, extracts the committed
`confinementDigest` (Interlace extension OID `.1.7`), recomputes the BLAKE3-256
of the §7-canonical manifest it is about to enforce, and **refuses to confine on
any mismatch**. This is fail-closed: a cert that commits *no* digest, a cert that
doesn't verify, or a manifest that digests differently all `bail!` before the
harness ever execs.

**Digest-required is expressed by presence of the block.** A policy that carries
a `confinement` block requires a valid, digest-committing cert — there is no
opt-out once it's declared. A policy *without* the block runs the harness
confined but un-attested: that is a deliberate deployment choice (dev / legacy),
the same **deployment-binding granularity** the lease gate uses with
`INTERLACE_ROOT_PUBKEY` — NOT a per-request bypass. `scripts/harness-dev.mjs`
always emits the block, so `task harness:dev` is attested end-to-end. A
per-bundle "digest mandatory in non-dev mode" knob is a future ADR concern
(multi-bundle confinement), not this wiring.

## Tests

`test/nono-isolation.test.mjs` (node:test, part of `task lint` via
`test:lint-scripts`; skips when the nono CLI isn't installed, otherwise
runs on darwin AND linux) proves each row of the table above against a
real `node` binary, a `$HOME` decoy secret that provably exists, and
live localhost/UDS listeners. A denial only counts when it's a nonzero
exit **plus** the kernel `EPERM`/`EACCES` message — empty output is
never accepted as evidence, and `ENOENT` fails the test (the target must
exist for the denial to mean anything). The decoy deliberately does NOT
live under `os.tmpdir()`: nono default-allows the temp dirs, so a decoy
there would prove nothing.

## History: the hand-rolled Seatbelt profile

The first iteration of this directory was a hand-written deny-default
`sandbox-exec` profile, proven working against real Claude Code
(macOS-only). It was retired in favor of nono — same Seatbelt mechanism
under the hood, but nono owns the low-level allowances (dyld cache,
`file-map-executable`, mach-lookup, the `/private/var/db/timezone` chain
that SIGTRAPs bun binaries…) and adds Linux. If you ever need the raw
profile + its test, they live at commit `12f4442`.
