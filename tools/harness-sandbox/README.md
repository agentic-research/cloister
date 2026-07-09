# harness-sandbox — kernel-level harness confinement (macOS Seatbelt)

This is the **pluggable sandbox behind cloister's UDS/HTTP seam**
(cloister-24717d, ADR-0040/0024 credential-isolation plane). The agent
harness runs kernel-confined; its only way out is the seam cloister
already exposes — localhost HTTP (`http://127.0.0.1:<port>/vault/proxy`)
and unix sockets. That confinement **is** the isolation: v8's isolate
boundary protects cloister's inside; this protects the host from the
harness.

- **Today: `sandbox-exec` (Seatbelt).** Native macOS, kernel-enforced via
  TrustedBSD MAC, no VM, ships on every Mac. `harness.sb` is a
  **deny-default** profile — everything is forbidden unless listed.
- **Later: libkrun (ADR-0044).** The stronger swap-in — a hardware-backed
  microVM behind the *same* seam. Nothing about the shim, the vault
  proxy, or the transport changes when the provider swaps; only the
  confinement mechanism does.

## What the profile enforces

| Surface | Policy |
|---|---|
| File reads/writes | **`WORKDIR` only.** `~/.ssh`, `~/.aws`, and everything else outside the four parameterized paths are denied *by default*, not by enumeration. |
| Harness runtime | `HARNESS_RUNTIME` read-only (the binary can't modify its own code). |
| Harness state | `HARNESS_STATE` dir + `HARNESS_STATE_FILE` rw (its own config/session state — e.g. `~/.claude` + `~/.claude.json`). |
| Network | localhost TCP + unix sockets **only**. External connects fail with `EPERM` before a packet leaves. The Anthropic API is reachable solely through cloister's vault proxy, which holds the credentials (custody) or receipts the harness's own auth (audit). |
| System | dyld shared cache, `/System`, toolchain trees, timezone db, per-user darwin temp — code and OS plumbing, never user data. |

Denials are kernel `EPERM` ("Operation not permitted"), not `ENOENT` —
the confined process can see that a path exists (metadata stays broad so
path resolution works) but cannot read its content.

## Usage

Wired into the ADR-0042 turnkey run:

```sh
SANDBOX=sandbox-exec task harness:dev
```

launches cloister (:8787) + the lease shim (:8799), then the harness
(`HARNESS_CMD`, default `claude`) under `sandbox-exec` with
`ANTHROPIC_BASE_URL` pointed at the shim. `SANDBOX` unset keeps the
existing print-the-export-line behavior. `HARNESS_WORKDIR` overrides the
workdir (default: cwd).

Standalone:

```sh
sandbox-exec \
  -D WORKDIR=/abs/workdir \
  -D HARNESS_RUNTIME=/abs/runtime-tree \
  -D HARNESS_STATE=$HOME/.claude \
  -D HARNESS_STATE_FILE=$HOME/.claude.json \
  -f tools/harness-sandbox/harness.sb \
  <command>…
```

All four `-D` params are required (an undefined `(param …)` reference
aborts profile compile). Subprocesses inherit the sandbox — confinement
is transitive.

## Tests

`test/seatbelt-isolation.test.mjs` (node:test, darwin-guarded, part of
`task lint` via `test:lint-scripts`) proves each row of the table above
against a real `node` binary, a decoy secret that provably exists, and
live localhost/UDS listeners. A denial only counts when it's a nonzero
exit **plus** the sandbox `EPERM` message — empty output is never
accepted as evidence, and `ENOENT` fails the test (the target must
exist for the denial to mean anything).

## Known limits (deliberate)

- `sandbox-exec` is deprecated-but-ubiquitous Apple CLI; the underlying
  Seatbelt/`sandbox_init` machinery is what every macOS app sandbox uses.
  When Apple moves it, the libkrun provider (ADR-0044) is the successor.
- The per-user darwin temp (`/var/folders/…/T`) is allowed rw — runtimes
  hard-require `os.tmpdir()`. Don't stage secrets there.
- Metadata (stat/readlink) is broad: a confined harness can learn that
  paths exist. Contents are what's protected.
- The confined harness reads rc files it can't access (e.g. `~/.zshrc`
  for shell snapshots) as EPERM; features degrade to workdir-only scope.
  That's the contract working, not a bug.
