---
title: "ADR-0014: Pluggable vault KEK source (env / file / OS keystore via kek-helper sidecar)"
status: Accepted (2026-05-11)
date: 2026-05-11
tags: [security, vault, self-host, kek, keychain, libsecret, workerd, isolation]
supersedes_framing: []
threat_model: docs/security/threat-model.md
relates_to:
  - 0010-vault-and-bundle-clusters.md
  - 0013-slice-grant-enforcement.md
---

## Context

[ADR-0010](0010-vault-and-bundle-clusters.md) introduced the vault DO
as the cluster's credential primitive — envelope encryption with a
per-credential DEK wrapped by a singleton KEK. [ADR-0013](0013-slice-grant-enforcement.md)
ratified the enforcement model: the V8 isolate boundary plus
service-binding-as-syscall is what isolates the KEK from compromised
bundles. **Neither ADR specified where the KEK secret itself comes
from at boot time.**

Today (pre-0014) the answer is: `env.VAULT_KEK_SECRET` — a plaintext
workerd text binding declared in `config.capnp` and `wrangler.toml`. For
CI and disposable local dev this is fine. For the **OSS launch / r/mcp
self-host story** it's a footgun:

- The operator has to put a high-entropy secret in a file
  (`config.capnp` for workerd, `wrangler.toml`'s `[vars]` table for
  `task dev`, or a dotenv shimmed in via tooling). That file is
  trivially world-readable on a default `chmod` and tends to end up
  in `git status` two commits later.
- Cloudflare's prod path can use `wrangler secret put`, which avoids
  the plaintext-file problem, but the self-hoster on macOS or Linux
  has no equivalent.
- The macOS Keychain and Linux libsecret already solve "where do I
  store a 32-byte secret on this host" and integrate with the OS
  login session ACL. We should let operators use them.

## The workerd constraint

A naive design says: "have the vault DO read from `node-keytar` /
shell out to `/usr/bin/security` / link `libsecret`." This is
impossible:

> **The vault DO runs inside workerd, in a sandboxed V8 isolate.** It
> has no filesystem, no `child_process`, no native bindings, no FFI.
> [ADR-0013](0013-slice-grant-enforcement.md) makes this an
> *intentional* property — the isolation that protects the KEK from a
> compromised bundle is the same isolation that prevents the DO from
> shelling out to the host OS.

The only escape hatch the DO has, per ADR-0013, is **service bindings**
(`service-binding-as-syscall`). Anything the DO needs from the host
must be exposed via a Worker or external HTTP service the DO can
`fetch()`.

So the design has two parallel surfaces:

1. **In-DO `KekSource` interface.** A URL-driven resolver that handles
   anything the DO can fulfill via bindings it already has.
2. **Out-of-DO `kek-helper` sidecar.** A small Node process running on
   the cloister host, with OS-keystore access, exposed to the DO over
   a service binding.

## Decision

### KEK source is URL-driven via `VAULT_KEK_SOURCE`

A new env binding `VAULT_KEK_SOURCE` (text) is read at vault-DO
construction time and passed to `vault/src/kek-source.ts:buildKekSource()`.
The URL scheme picks the backend:

| Scheme | Where the secret lives | How the DO reaches it |
|---|---|---|
| `env://NAME` | workerd `text` binding `NAME` | direct env read |
| `file:///path/to/file` | a directory mounted into workerd as a `disk` service | `KEK_DISK.fetch()` |
| `keychain://service-name` | macOS Keychain | `KEK_HELPER.fetch()` → `security find-generic-password` |
| `secret-tool://service-name` | Linux libsecret | `KEK_HELPER.fetch()` → `secret-tool lookup` (NOT YET) |
| `http(s)://helper/...` | any HTTP-reachable secret service | `KEK_HELPER.fetch()` |

If `VAULT_KEK_SOURCE` is unset, the DO falls back to the legacy path:
behave as if `VAULT_KEK_SOURCE=env://VAULT_KEK_SECRET`. **Every existing
config.capnp, wrangler.toml, test, and CI invocation continues to work
unchanged** — the only thing this ADR adds is opt-in plurality.

### The `kek-helper` sidecar (scripts/kek-helper.mjs)

The helper is a single-file Node script — no dependencies, ~150 lines.
It listens on `127.0.0.1:<port>` (loopback only — refuses to bind to
anything else, because it has no auth and trusts everything on its
port). It exposes:

```
GET /healthz                      → { ok, platform, schemes }
GET /resolve?url=<encoded URL>    → 200 + raw bytes  (no JSON envelope)
                                   404 / 500 / 501 + { error: ... }
```

For `keychain://`, the helper shells to `/usr/bin/security
find-generic-password -a cloister -s <service> -w`. No quoting hazard
— `spawnSync` with argv, never `exec` with a string. The macOS
Keychain ACL does the right thing: the secret is readable by processes
running as the user who created the entry, prompting on first access
from a new binary.

For `secret-tool://`, the helper returns 501. A follow-up bead
(`cloister-…` — file before merging) will wire `secret-tool lookup
service <name>`.

### Service-binding wiring

`Env` gains two optional fetcher bindings:

- `KEK_DISK` — a `disk` service binding for `file://` URLs.
- `KEK_HELPER` — an HTTP service binding for `keychain://` /
  `http(s)://` URLs.

These are **optional**. When `VAULT_KEK_SOURCE` uses `env://`, neither
binding is consulted. When the operator sets up `keychain://`, they
wire `KEK_HELPER` (in `config.capnp` or `wrangler.toml`); when they
set up `file://`, they wire `KEK_DISK`. The DO throws at first read
if a required binding is missing, with a message that names the
binding.

## Security properties

This ADR does **not** change the isolation properties from
[ADR-0013](0013-slice-grant-enforcement.md):

- The KEK still never leaves the vault DO's V8 isolate. It is held as
  a `CryptoKey` with `extractable: false`.
- The KEK source resolution happens once at first
  encrypt/decrypt; the secret string passes from helper → DO → HKDF
  → CryptoKey and is dereferenced. There is no on-DO-disk plaintext.
- A compromised bundle still cannot reach `KEK_HELPER` or `KEK_DISK`
  — those bindings live on the vault DO, not on bundle isolates. The
  three-criterion isolation property from ADR-0011 holds.

What this ADR **does** add to the threat model:

- **The kek-helper is a new trust surface on the host.** Anything that
  can reach `127.0.0.1:<helper-port>` reads your KEK. Mitigation: the
  helper refuses to bind to non-loopback addresses. Threat model
  audience: if you run untrusted code as your UID on the cloister
  host, that code can already read your Keychain — this is a
  property of the macOS security model, not a new exposure.
- **The helper is the only thing that touches the OS keystore.** The
  DO never holds the keystore-locator string except in `KEK_HELPER`
  fetch URLs. The helper logs entry names only when started with
  `--verbose`.

## What this ADR does NOT cover (follow-up beads)

The recommended scope here is the **r/mcp launch-blocker minimum**.
Listed elsewhere; tracked separately:

- **Linux libsecret (P2)** — kek-helper `secret-tool://` backend.
- **Windows DPAPI (P3)** — kek-helper Windows backend.
- **TPM2 / hardware-backed KEK (P3)** — a `tpm://` scheme.
- **Cloud KMS** (AWS / GCP / Azure / HashiCorp Vault) — `kms://`
  schemes; these would use the existing `http(s)://` helper plumbing
  but with proper SDK-style auth instead of `security`/`secret-tool`.
- **KEK rotation / multi-key support** — the DO assumes a single
  current KEK forever. Rotation requires unwrapping every DEK with
  the old KEK and re-wrapping with the new — a separate orchestration
  problem.
- **HSM / hardware token** (YubiKey, Nitrokey) — would land as another
  helper backend.

## Status

- `vault/src/kek-source.ts` — interface + `env://`, `file://`,
  `keychain://`/`http(s)://` resolvers. 21 unit tests.
- `src/vault-store.ts` — vault DO calls `buildKekSource()`; legacy
  `VAULT_KEK_SECRET` path preserved.
- `src/types.ts` — `Env` extended with `VAULT_KEK_SOURCE`, `KEK_DISK`,
  `KEK_HELPER` (all optional).
- `scripts/kek-helper.mjs` — sidecar with macOS Keychain backend.
- `README.md` / `GETTING-STARTED.md` — self-host walkthrough.

Dogfood-validated 2026-05-11 on macOS: end-to-end round-trip from
`security add-generic-password` → kek-helper → curl reads the bytes
back verbatim.
