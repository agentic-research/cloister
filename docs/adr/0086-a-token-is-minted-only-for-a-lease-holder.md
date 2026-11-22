---
title: "ADR-0086: A token is minted only for a lease holder, in that holder's name"
status: Accepted (2026-11-22)
date: 2026-11-22
tags: [identity, tokens, oauth, notme, lease, trust-boundary]
tracking-bead: cloister-ca2582
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0053-lease-gate-authority-resolution.md
  - 0085-every-lease-refusal-is-recorded.md
external_refs:
  - https://www.rfc-editor.org/rfc/rfc6749#section-4.4
  - https://www.rfc-editor.org/rfc/rfc8705
  - https://www.rfc-editor.org/rfc/rfc9449
---

# ADR-0086: A token is minted only for a lease holder, in that holder's name

## Status

Accepted (2026-11-22). It restores the endpoint's design: an identity a
provider established (notme) becomes a token the cluster mints for its own
services.

## Context

The identity bridge (`cloister-c9922f`) serves `POST /oauth/token`, a
`client_credentials` grant. notme signs the JWT on a key it holds for cloister
alone (notme ADR-015). That ADR confines what the key signs to cloister's trust
domain, and leaves who receives a token to cloister. It calls minting tokens for
the issuer's own subjects a delegated issuer's whole job.

The design said the endpoint required a lease (`docs/tenants/identity-bridge.md`).
The code did not:

- **It checked no client.** Any caller got a token.
- **Every token named the cluster.** Its subject was the cluster's own
  fingerprint, so a token could not say who asked for it, and any caller could
  speak as the cluster.
- **Nothing tested either way, and the threat model had no section on it.**

Mapping how each route checks its caller found it. The first fix removed the
endpoint, on the grounds that notme's own token endpoint could serve instead.
That dropped the design along with the defect, so this ADR restores the design
and makes the code keep it.

Prior art:

- RFC 6749 §4.4: the client credentials grant is for confidential clients, which
  authenticate to the authorization server. The token is issued to the client,
  for itself.
- RFC 8705 authenticates a client with a certificate, and can bind the token to
  that certificate. A lease is a certificate plus a signature over the request.

## Decision

1. **`/oauth/token` requires a lease, always.** The lease gate (ADR-0053) checks
   it like any lease-gated route, with `denyWhenOff`: in dev mode with no
   authority, the gate is off and this endpoint still refuses, because the token
   would have no caller to name. A refusal is `401 invalid_client`
   (`WWW-Authenticate: Signet`). A CA bundle outage is
   `503 temporarily_unavailable`. Each refusal is recorded (ADR-0085).
2. **The token's subject is the caller.** `sub` is the verified lease's peer
   fingerprint. The cluster's fingerprint stays the key id (`kid`), because it
   names the issuer's key.
3. **One scope per token, covered by the lease.** The request names exactly one
   scope, and the gate checks the lease covers it, as it checks a route's scope.
   The token carries that scope and no other. A token can hand on authority the
   caller already holds, never widen it. A request without exactly one scope is
   `400 invalid_scope`, before any gate work.
4. **Discovery stays.** `/.well-known/openid-configuration` and
   `/.well-known/jwks.json` describe an issuer that issues again. With a signer
   bound, JWKS publishes the key notme signs with, asked of notme each time.

## Consequences

- A caller that used the endpoint without a lease is now refused.
- **The token is a bearer token, for 300 seconds.** notme's delegated signer
  refuses `cnf` (ADR-015), so cloister cannot bind the token to the lease's key,
  although it verified that key itself. Binding it, as RFC 8705 and RFC 9449 do,
  needs notme to accept a key binding the delegated issuer verified. That is an
  ask for notme, recorded as residual in the threat model (§6.6.5).
- The endpoint calls the lease gate itself, like the four other lease-gated
  routes. Moving every route's check into the router is separate work.

## Alternatives considered

- **Remove the endpoint, and let internal services take notme's tokens
  directly.** That was this change's first version. It drops the cluster's hop,
  which the design wants: a token the cluster mints for its own services.
- **Keep the cluster as the subject.** Every lease holder could then speak as
  the cluster.
- **Accept several scopes, each checked against the lease.** The gate checks
  one scope per request. A token per scope keeps every grant checked by the same
  code that checks every route.
