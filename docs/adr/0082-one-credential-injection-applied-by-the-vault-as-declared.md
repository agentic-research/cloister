---
title: "ADR-0082: One credential injection, applied by the vault as declared"
status: Accepted (2026-11-21)
date: 2026-11-21
tags: [vault, credentials, credential-isolation, injection, trust-boundary, conformance, egress]
tracking-bead: cloister-7c9312
threat_model: docs/security/threat-model.md
relates_to:
  - 0013-slice-grant-enforcement.md
  - 0021-per-bundle-vault-instances.md
  - 0024-credential-isolation-capability.md
  - 0040-harness-in-cloister.md
  - 0058-vault-credential-source.md
  - 0081-cloister-is-a-core-drivers-and-features.md
external_refs:
  - ley-line-open:docs/adr/0046-connection-broker.md
  - ley-line-open:rs/ll-core/schema-spec/credential-isolation/v1/wire/injection-strategies.md
---

# ADR-0082: One credential injection, applied by the vault as declared

## Status

Accepted (2026-11-21). The owner made two decisions: a credential is injected
in exactly one place, and that is solved properly now, with an egress boundary
(the north star, below) as where it goes next. The design in Decision is the
implementer's.

## Context

ADR-0024 makes cloister an implementation of `cloister/credential-isolation/v1`:
a service declares how its credential is injected (`injection`), the vault holds
the credential, and the caller never sees it. LLO publishes ten files of test
vectors for that contract and says a second implementation is conformant when
it reaches the same bytes.

Mapping core's guarantees to the tests that check them (ADR-0081 §2) found that
the injection did not work the way the declaration said:

- **Production ignored the declared strategy.** A call went from the vault route
  to the vault's Durable Object, whose `buildProxyRequest` copied whatever
  headers were stored with the credential into the caller's request. It never
  read the service's `injection`. A service declared with `queryParam` or
  `bodyField` would have had headers injected instead. The shipped
  configuration declares only header strategies, so this was latent.
- **Production dropped the request's path.** The same function sent every call
  to the stored `upstream` URL with only the caller's query merged in. Every
  call to a service reached the same URL.
- **The five strategies lived where production never ran them.** They were
  implemented in `vaultProxyHandler`, which runs only when a test supplies an
  in-memory credential store. The tests, and the three vector files that did
  run, checked that code.
- **Two more copies.** The harness formatted the dev seed's headers itself
  (`credentialHeaders`, header strategies only). The vault library's own
  handler, which nothing calls, used the same builder as the Durable Object.
- **Seven of the ten vector files never ran.** A lint test said they ran in
  `test/routes/credential-isolation-conformance.test.ts`, which did not exist.

The same route had been here once before: the manifest's `allowedSubs` check
"was dead code in production" until it moved to the route.

LLO's connection broker proposal (`ley-line-open:docs/adr/0046-connection-broker.md`)
plans credential injection again, for microVM and native runs (its D4). So the
system was heading for a fourth place to inject a credential.

## Decision

### 1. One function computes the upstream request

`vault/src/inject.ts` is the only code that injects a credential. Given the
declared service (strategy and upstream base), the stored credential (the
secret, and a username for Basic), and the caller's request (method, the path
the route parsed, the raw query and the headers), it returns the upstream
request:

- **URL:** the declared base with trailing slashes trimmed, the parsed path,
  and the caller's query byte for byte. `queryParam` appends
  `&<name>=<credential>`.
- **Headers:** the caller's, minus one list of what never leaves: its own
  identity material (`authorization`, `cookie`, `dpop`, `x-client-cert`, every
  `x-interlace-*`), network facts the platform adds, and hop-by-hop headers.
  A header strategy then sets its header, overwriting any the caller sent.
- **Body:** untouched and streamed, except for `bodyField`. That strategy reads
  the caller's JSON object, sets the field at the declared path, and
  re-serializes it with sorted keys.

It uses no platform types and does no I/O. A small adapter in the same module
turns its result into a `Request`.

### 2. The vault applies it, on every forwarded call

The route passes the Durable Object what the declaration says: the strategy, the
upstream base and the parsed path. The Durable Object decrypts the credential
and applies §1. It refuses, with the same constant-shape 404 as every other
access failure, when the declared base differs from the upstream the credential
was stored for. A credential is only ever sent to the upstream it was stored
for. If a manifest moves a service to a new base, its credentials are stored
again.

### 3. A credential is stored as the secret

A credential row holds the secret and an optional username, sealed as before,
next to the upstream it is for and its `allowedSubs`. It no longer holds
ready-made headers: the declaration decides how the secret is presented.
`putCredential` takes `{ upstream, credential, username?, allowedSubs }`, and
ADR-0058's credential source resolves to that shape. The table is recreated on
first use, as it was when rows gained `subject_fp`. Nothing in production
writes credentials before ADR-0058 lands, and the dev seed writes its one again.

### 4. The copies go

`vaultProxyHandler` uses §1 for its in-memory path. `buildProxyRequest`, the
vault library's unused handler, and the harness's `credentialHeaders` are
deleted. The harness seeds the API key itself.

### 5. LLO's vectors are the acceptance test

`test/routes/credential-isolation-conformance.test.ts` runs every injection
vector through the Durable Object. The test upstream echoes back the request it
received, and the test compares that request with the vector's. Where LLO's
vectors and its spec text disagree, cloister follows the vectors, since LLO's
README makes them the bar, and reports the conflict upstream. There are two:

- **`queryParam` collision.** The spec text says the stored value replaces a
  parameter of the same name. The collision vector appends a second one.
- **`bodyField` key order.** The spec text says the rest of the document keeps
  its key order. The vectors' bodies have their keys sorted.

## The north star: one boundary, in both directions

The vault proxy is one instance of a more general boundary. On egress it injects
the credential, holds the bundle to its declared reach, and records the call. On
ingress it authenticates the caller, holds it to its declared scope, and records
the call. A bundle that can only leave through that boundary never needs a
credential. That puts ADR-0081's guarantees 2, 3 and 4 in one place.

The split that boundary suggests:

- **The transform is written once, in Wasm.** That covers the injection in §1,
  and later the per-protocol handshakes LLO's broker plans (its D3). Workerd runs
  Wasm, and the broker can embed it.
- **The hook is per placement.** On Linux hosts (compose, Kubernetes nodes, and
  LLO's native Linux runs), an eBPF program on the run's cgroup can redirect
  every connect to the boundary and refuse the rest. That makes the boundary
  unavoidable, and answers the broker's open question for native Linux (its
  Q2). The microVM and macOS channels are the broker's (its D5). The workerd
  hook is the outbound binding.
- **TLS stays at the boundary.** eBPF sees ciphertext when a workload does its
  own TLS. So the workload speaks plaintext only to the boundary, and the
  boundary opens TLS upstream, which is what the vault and the broker already do.

The boundary is likely its own component, belonging to neither cloister (policy)
nor LLO (substrate). This ADR's function and vectors are written to become its
specification and acceptance test: §1 uses no platform types, so the Wasm
module can be checked against the same vectors. Where the component lives, its
Wasm interface (proxy-wasm, which Envoy and Istio use, is the prior art), and
the protocol handshakes are not decided here.

## Consequences

- A service's declared injection is what production does, and a call reaches
  the path it asked for.
- A credential stored before this change is dropped when the table is
  recreated. The dev seed is ingested again on first use; there is no other
  writer yet.
- The harness's dev seed carries the API key, not headers.
- A manifest that changes a service's upstream base strands that service's
  stored credentials until they are stored again, by design.
- The other vector files run next. They cover the canonical bytes a request's
  signature covers, malformed lease headers, the receipt commitment and the
  error bodies.

## Alternatives considered

- **Keep stored headers, and refuse what production cannot do.** A service
  declared with `queryParam` or `bodyField` would fail the build by name, and
  the strategies production cannot apply would be deleted. That is smaller, but
  cloister would implement part of credential-isolation/v1, and injection would
  still live in two places.
- **Move injection into LLO's broker now.** Its D4 is not built, and workerd
  cannot host it. The function here is the step that both can share.
- **Keep the declared base and the stored upstream independent.** The
  declaration would then decide where a stored secret goes. One edit to a
  manifest could send every stored credential for a service to a new host.
