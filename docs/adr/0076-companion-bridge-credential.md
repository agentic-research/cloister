---
title: "ADR-0076: The companion's socket bridge starts without a bridge credential; the credential is notme's to settle"
status: Proposed
date: 2026-11-20
tags: [companion, notme-proxy, bridge-cert, credentials, compose, onboarding, trust-boundary]
tracking-bead: cloister-ca2582
relates_to:
  - 0005-internal-wire-leyline-net.md
  - 0010-vault-and-bundle-clusters.md
  - 0018-notme-co-location.md
  - 0051-uds-input-transport.md
  - 0075-one-graph.md
---

# ADR-0076: The companion's socket bridge starts without a bridge credential; the credential is notme's to settle

## Status

Proposed. Nothing is implemented. Part A asks notme for one small change and
then needs a few lines of `cluster.toml`. Part B records what cloister needs
from a decision notme has not made yet, and does not make it for them.

Paths below are in the `notme`, `rosary` and `signet` repositories unless they
start with a cloister directory.

## Context

The gateway is workerd, and workerd cannot open a Unix socket. Every backend
the gateway reaches over a socket is reached through the **companion**: the
`notme-proxy` bundle, which takes a plain HTTP request carrying
`X-Cloister-Transport: uds` and `X-Cloister-Socket-Path`, opens that socket,
and relays the bytes (ADR-0005, ADR-0051). The same process has a second job,
notme's local plane: it holds a **bridge certificate** and presents it on
outbound mTLS, so no Worker holds a credential.

### What running the proxy showed

`notme-proxy` was built from source (`proxy/`, `cargo build --release
--locked`) and run.

| Started as | Result |
|---|---|
| No arguments, as `cluster.toml` starts it today | panics at `src/main.rs:93`: `open cert file: ... No such file or directory`, exit 101 |
| `--cert --key` with any certificate | listens on `127.0.0.1:1080`, not on `127.0.0.1:8385` where the gateway dials it (`config.capnp`, `COMPANION_URL`) |
| `--cert --key --listen 127.0.0.1:8385` | listens where the gateway dials |

With it listening, a request carrying the two headers was relayed to a Unix
socket and the socket's reply came back (`200`). A socket path outside the
allowed prefix was refused (`400`, `socket path outside allowed prefix`).
**The relay never used the certificate.** The certificate is read at startup
only because the mTLS half needs it, and the proxy will not start without it.
It also accepted a self-signed certificate it had no reason to trust: it does
not check what it was handed, at startup or later.

So under compose today the companion exits, and every socket backend goes
with it. Rosary is one: its compose command is `rsry mcp --ipc-socket`, socket
only (`rosary/src/main.rs:1768`).

### What the bridge credential involves

From notme's and signet's design documents and code:

- **A certificate lives five minutes.** The default `ttlMs` of
  `mintBridgeCertPair` (`worker/src/cert-authority.ts:294`); `/cert` passes no
  override. The proxy reads its certificate once and never renews, so any
  certificate handed to it stops working five minutes later, with no error at
  start.
- **A certificate is a pair.** Issuance needs a P-256 key for mTLS and an
  Ed25519 key for signing, each with a proof of possession (notme design 008).
- **Keys are meant to be born in memory.** "Private keys exist only in process
  memory unless explicitly encrypted at rest" (design 007). The proxy instead
  reads both from files (`proxy/src/main.rs:88-103`), and
  `packages/README.md` documents mounting the key file.
- **notme's documents disagree about renewal.** `SECURITY.md` says "5-minute
  token/cert TTL, no renewal, just expire". Design 009 renews by re-running
  the original proof before expiry ("cert TTL - 60s reached → re-authenticate
  → fresh PoP exchange"). Design 019 endorses "minutes-long credentials, a
  controller that renews only while the task is active". There is no renewal
  endpoint, and the client-certificate path was removed because its header
  could not be trusted (`worker/worker.ts:2862`).
- **The proxy is not meant to fetch credentials.** Its README: "no cert
  issuance — the proxy doesn't talk to the authority, doesn't request certs,
  doesn't rotate" (`proxy/README.md:186`).
- **A bootstrap code is an admin credential.** Exchanging one creates a new
  principal holding `bridgeCert`, `authorityManage` and `certMint`
  (`worker/src/cert-exchange.ts:130-147`, "deployer only"). The operator
  secret form is not single-use: it is also admin recovery
  (`worker/src/signing-authority.ts:1888-1895`).
- **The narrowest existing grant for a workload is an invite.** It carries
  only `bridgeCert`, is single-use, expires, and can be revoked. Redeeming it
  gives a 24-hour session, which can be exchanged for certificates
  (design 005; `worker/worker.ts:2066-2125`, `:2264`).
- **An authority restart strands every holder.** In ephemeral mode the CA key
  is born at startup and dies at exit (design 007), so restarting
  `notme-identity` invalidates the companion's certificate inside its five
  minutes.
- **Any new proof faces notme's own test.** Design 020: "which existing
  standard already does this, and why is it insufficient?"

## Decision

### Part A: the socket bridge starts without a bridge credential

The two jobs are separable, and only one of them needs a credential.

1. **Asked of notme:** `notme-proxy` starts without `--cert` and `--key`.
   With no credential it serves the socket bridge and refuses mTLS requests
   with an error that says it holds no credential. It does not reach for
   default file names. With a credential it behaves as today.
2. **In cloister,** once that ships: the companion's compose placement joins
   the gateway's network namespace (`sharesNetworkOf`, ADR-0075 §8) and is
   started with `--listen 127.0.0.1:8385`. The compose-reach rail
   (`lint/test/compose-reach.test.mjs`) is extended to bundles reached at a
   loopback address by argument, not only by `httpPort`, so this cannot drift.

That makes every socket backend reachable under compose with no credential in
the cluster at all, which is also the simplest onboarding.

Rejected for Part A: **handing the proxy a throwaway self-signed
certificate** so it starts. It works today, as the run above shows, but it
puts a fake credential in the place a real one goes, and the proxy cannot
tell them apart. The first time someone relies on its mTLS half, it presents
a certificate nothing trusts.

### Part B: the bridge credential is notme's to settle

Cloister needs the companion to hold a real credential for the mTLS half, and
to keep holding it. How is notme's decision, and its documents currently
disagree. This ADR asks notme to settle it, as an amendment to design 009 or
019, and records the constraints cloister depends on:

- No private key is written to disk by the cluster.
- The credential the cluster hands the companion is the narrowest that
  works. **Not a bootstrap code**, which would make the companion an admin.
  An invite, redeemed for a session and re-exchanged before each certificate
  expires, is the existing mechanism that fits design 009's renewal flow.
- Renewal never widens scope.
- A lapse, including one caused by an authority restart, stops the mTLS half
  with a message that says why. It does not take the socket bridge down with
  it.

Open for notme, not decided here: whether the proxy or a separate holder does
the exchange (its README rules out the proxy); whether renewal keeps the key
or generates a fresh pair (signet generates fresh keys on every renewal); and
whether a 24-hour session is the right ceiling for a long-running cluster.

When notme settles it, cloister's part is to hand the companion its
credential through the vault (ADR-0010) and to declare the companion's call to
`notme-identity` as a wire. Neither is built before then.

## Consequences

- With Part A, `cluster up` reaches rosary and every other socket backend
  without any credential being created, stored or handed over.
- The mTLS half stays off under compose until Part B. That is the state today
  in effect, and it is now said, not hidden behind a crash.
- No change in cloister lands before notme's change in Part A, because without
  it the companion still exits.

## What a full run showed

rosary was built from source and started as compose starts it
(`rsry mcp --ipc-socket`, no config). A tool call encoded by cloister's own
`encodeToolCall` was sent to the companion, relayed into rosary's socket, and
rosary's reply decoded by cloister's `decodeToolResult`.

- **rosary starts without a config** and answers over its socket.
- **cloister could not read any reply.** rosary writes canonical capnp, which
  drops an all-zero data section: `isError = false`, and the union tag of the
  `text` content variant, which is 0. `decodeToolResult` required those words
  and refused every reply ("Content element too small: 0d/1p"). The capnp
  spec requires a reader to treat a missing section as defaults. Fixed in
  `src/wire/tool-result.ts`, with rosary's real bytes as a test fixture
  (`test/wire/fixtures/rosary-tool-result.ts`).
- **With the fix, the chain works:** `rsry_active` returns its state.
- **Most of rosary's tools need a backend store**, which compose does not
  configure: they return "backend store not configured". That is the next gap
  for onboarding, after Part A, and is rosary's configuration to settle.

## Not verified

- The proxy and rosary were run as native processes built from source, not as
  their published images.
- The relay was run with a throwaway certificate, only so the proxy would
  start. That is the workaround Part A rejects for the cluster.
