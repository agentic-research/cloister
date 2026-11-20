---
title: "ADR-0076: The companion gets its bridge credential from the cluster's own authority, and renews it"
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

# ADR-0076: The companion gets its bridge credential from the cluster's own authority, and renews it

## Status

Proposed. Nothing is implemented. Most of the change is in notme
(`notme-proxy` and the authority's `/cert` exchange), not in cloister, so this
records what cloister needs and what it asks of notme. It is written before
any code, as CLAUDE.md asks for anything that touches the trust boundary.

## Context

The gateway is workerd, and workerd cannot open a Unix socket. Every backend
the gateway reaches over a socket is reached through the **companion**: the
`notme-proxy` bundle, which takes a plain HTTP request from the gateway, opens
the socket the request names, and relays the bytes (ADR-0005, ADR-0051). The
same process is notme's local plane: it holds a **bridge certificate** and its
private key, and presents them on outbound mTLS so that no Worker ever holds a
credential.

`cloister cluster up` under compose starts the companion, and it does not work.
Reading the source of the images rather than guessing (ADR-0075 §8):

| | What the cluster does | What the image needs |
|---|---|---|
| Arguments | `cluster.toml` gives `notme-proxy` none | `--cert`, `--key`, `--listen` (`notme/proxy/src/main.rs:431-447`) |
| Listen address | the gateway dials `127.0.0.1:8385` (`config.capnp`, `COMPANION_URL`) | the default is `127.0.0.1:1080`, in the proxy's own namespace |
| Credential | none is provided | it loads `bridge-cert.pem` and `bridge-key.pem` from files at startup, and exits if they are missing |

So the companion exits on start, and with it every socket backend the gateway
has. Rosary is one: its image speaks only the capnp protocol over a Unix
socket (`rsry mcp --ipc-socket`). Its HTTP mode will not start without a
`rosary.toml` the image does not ship (`rosary/src/serve/mod.rs:584`).

The obvious fix is to mount a certificate file into the companion. **It does
not work, and would fail quietly.** A bridge certificate lives five minutes
(`expires_in: 300`, `notme/worker/src/cert-exchange.ts:296`). The proxy reads
it once and never renews it, so a mounted certificate breaks five minutes
after `cluster up`, with no error at start. It would also put the private key
on disk, which notme's own design rules out ("the private key never enters any
Worker, never touches disk, never leaves this process": `notme/proxy/README.md`;
design 007 and 008). The proxy's `--key <file>` is the one place that contract
is not yet met.

And the certificate has to come from somewhere. notme issues one only for a
proof: a passkey session, a GitHub Actions OIDC token, or a **bootstrap code**,
which is consumed on use (`cert-exchange.ts:130-143`). There is no renewal
proof, so even a proxy that knew how to ask could not ask twice.

The cluster already runs its own identity authority: the `notme-identity`
bundle. The pieces exist. What is missing is how they meet.

## Decision

The companion obtains its bridge credential from the cluster's own
`notme-identity` at startup, holds the key in memory only, and renews before
expiry. Concretely:

1. **The key is born in the proxy.** On start, `notme-proxy` generates its
   keypair in memory. `--cert` and `--key` remain for the deployments that use
   them today, but the cluster does not pass them.
2. **The first certificate is bought with a bootstrap code.** The cluster's
   `notme-identity` is configured with a bootstrap code, and the companion is
   given the same code. The proxy exchanges it once, with proof of possession
   of its new key, for its first bridge certificate. The code is a credential,
   so it reaches both bundles as a **vault slice** (ADR-0010), never as an env
   value in `cluster.toml` or the compose file.
3. **Renewal is proved with the certificate being renewed.** notme gains a
   renewal proof: a request signed by the key in a current, unexpired bridge
   certificate, which returns the next one for the same key and identity,
   with scopes no wider. The proxy renews when a fraction of the lifetime
   remains. A lapse (the authority was down past expiry) needs a new bootstrap
   code; the proxy says so and exits, rather than run without a credential.
4. **The companion runs where the gateway dials it.** Its compose placement
   joins the gateway's network namespace (`sharesNetworkOf`, ADR-0075 §8) and
   listens on `127.0.0.1:8385`, the address `config.capnp` names. The rail in
   `lint/test/compose-reach.test.mjs` is extended to cover it, since it has no
   `httpPort` today.
5. **The edges are declared.** The companion's call to `notme-identity` for
   its certificate is a wire, so it is an edge of the graph, as the
   companion's dial of rosary already is (ADR-0075 §5).

Rosary is then reached as its image intends: through the companion's socket
bridge, with no config file. Which gateway backend kind carries that
(`udsForward` today), and whether the gateway's `ROSARY_BUNDLE` path changes,
is the next decision, and it waits on this one: without a running companion
there is nothing to route through.

## What is asked of notme

This ADR cannot be implemented in cloister alone. It asks notme for:

- `notme-proxy`: generate the key in memory; exchange a bootstrap code for the
  first certificate; renew; exit with a clear message on a lapse.
- The authority: a renewal proof (item 3). Its rules are notme's to set; the
  one cloister depends on is that renewal can never widen scope.

Both are filed against notme when this is accepted. Cloister's own part,
items 2, 4 and 5, can be built against the new proxy behind those.

## Alternatives considered

- **Mount a certificate and key into the companion.** Rejected above: it
  expires in five minutes, and it puts the key on disk.
- **A longer-lived certificate for the companion.** It moves the failure from
  five minutes to however long, and makes a stolen key worth more. notme keeps
  lifetimes short on purpose.
- **Skip the companion under compose**, as `dev/e2e-smoke.sh` does for dev mode.
  Then nothing reaches a socket backend, which is what is broken now.
- **Give rosary an HTTP config and dial it directly.** It works around the
  companion for one backend and leaves the others. The gateway and rosary
  would also each hold their own idea of where rosary lives.

## Consequences

- `cluster up` brings up a companion that holds a credential and keeps it, with
  no step for the operator. That is the onboarding this is for.
- No private key is written anywhere by the cluster.
- One new credential handoff: the bootstrap code, through the vault. The threat
  model gains a row for it (`docs/security/threat-model.md`), before code.
- Until notme ships its half, nothing here changes. The compose cluster stays
  as it is, and ADR-0075 §8 still says which backends are not reached.

## Open questions

- Who generates the bootstrap code for a fresh local cluster: `cloister init`,
  `cluster up`, or the vault on first use. It must be single-use and must not
  appear in any committed file.
- How the renewal fraction and the lapse behaviour are reported, so a cluster
  whose authority was down is told why the companion stopped.
