---
title: "ADR-0055: RFC 9728 protected-resource metadata — cloister as a discoverable OAuth resource server"
status: Proposed (2026-07-22)
date: 2026-07-22
tags: [oauth, discovery, rfc9728, resource-server, well-known, lease, mcp]
threat_model: docs/security/threat-model.md
relates_to:
  - 0004-capnp-manifest.md
  - 0007-interlace-substrate.md
---

# ADR-0055: RFC 9728 protected-resource metadata

Tracking bead: `cloister-215ef2`. Sibling: `signet-222de8` (the same
capability in signet's Go resource-server middleware — the two are the TS and
Go halves of one discovery contract).

## Context

The MCP authorization spec defines a three-link cold-start discovery chain:

1. client hits a protected MCP endpoint with no credential → **401 with
   `WWW-Authenticate: Bearer resource_metadata="…"`**;
2. client fetches the resource server's **RFC 9728** metadata
   (`/.well-known/oauth-protected-resource`) to learn *which* authorization
   server to use;
3. client fetches that AS's **RFC 8414** metadata for `token_endpoint` +
   `jwks_uri` + DPoP algs, obtains a token, retries.

Link 3 is shipped: notme publishes RFC 8414 AS metadata (notme #26/#27/#28).
Links 1 and 2 do not exist on cloister. Today the lease gate emits a **bare
401** (`leaseErrorResponse`, `src/routes/lease-middleware.ts:216`) with no
`WWW-Authenticate`, and there is no `/.well-known/oauth-protected-resource`
route. So notme's discovery doc is reachable only by a client that already
knows notme's URL out-of-band — which is exactly the hardcoding the discovery
chain exists to remove. cloister is the **protected resource**; it currently
never says who authenticates for it.

## Decision

cloister becomes a discoverable RFC 9728 resource server, via two additions
that mirror the signet Go middleware (`signet-222de8`) so the TS and Go halves
stay one contract:

**1. A new route kind `wellKnownProtectedResource` (ordinal `@11`)** in
`manifest/cloister.capnp`'s route-kind union, appended per the ADR-0004
schema-evolution rules (append-only, monotonically increasing, never
renumber). It is a metadata-surface route, sibling to `wellKnownMcpRegistry`
and `wellKnownInterlace`, registered at `/.well-known/oauth-protected-resource`
and handled by a new `src/routes/well-known-protected-resource.ts`.

**2. A `WWW-Authenticate` challenge on the lease-gate 401.**
`leaseErrorResponse` adds `WWW-Authenticate: Bearer resource_metadata="<url>"`
(RFC 9728 §5.1) to its 401 responses when the protected-resource route is
configured. The challenge points at cloister's own well-known path.

### The served document

Per RFC 9728 §2 (verified against the RFC this session): `resource` is
REQUIRED and MUST equal the identifier a client used to reach the document
(§3.3) — so it is cloister's deployment origin, validated as an absolute URL.
Everything else is OPTIONAL:

- `authorization_servers`: `[<notme issuer>]` — the one AS that mints tokens
  cloister accepts. This is the load-bearing field: it is how a cold client
  learns to go to notme.
- `dpop_signing_alg_values_supported`: `["ES256"]` — the DPoP *proof* alg
  cloister's lease gate verifies, matching what notme's AS metadata publishes.
  Publishing it here closes the same interop gap that a silent value caused
  between cloister and notme earlier (a verifier assuming the wrong alg).
- `bearer_methods_supported`: `["header"]`.

The document is **public and unauthenticated** — RFC 9728 metadata is a map,
not a key; reading it grants nothing. This matches the existing
`wellKnownMcpRegistry` posture and is the opposite of the `disclosure`
route's constant-time-404 secrecy, which is deliberate: discovery must be
reachable pre-credential, whereas disclosure guards existence.

## Why this shape

- **A route kind, not an ad-hoc handler**, because cloister routes are
  declarative (CLAUDE.md; ADR-0004) and this is a first-class public surface a
  reviewer and the lint invariants must see.
- **`WWW-Authenticate` in `leaseErrorResponse`, not per-call sites**, so the
  challenge is attached wherever the lease gate emits a 401 — one seam, no
  drift, symmetric with how the signet Go half wraps its error handler once.
- **`authorization_servers` is operator-declared**, not inferred, so cloister
  advertises exactly the AS it trusts — the same closed-set discipline as the
  `INTERLACE_ROOT_PUBKEY` trust anchor.

## Scope + boundary

- **`kid`-independent.** This is discovery URLs + a challenge header, not key
  derivation — so it is NOT gated on the canonical-`kid` authority
  (`signet-248d17` / ADR to land in signet). It can ship against current main.
- **LLO uninvolved.** RFC 9728 is an OAuth/HTTP resource-server concern;
  LLO is the crypto/data substrate (no auth/HTTP layer) and cloister does not
  route this through it. Confirmed by the placement review this session.
- Host-level well-known form only (cloister's MCP surface is host-rooted);
  the RFC 9728 path-insertion form is out of scope, matching the signet half.

## Consequences

- The discovery chain is complete: a cold MCP client 401s → reads cloister's
  RFC 9728 doc → finds notme → reads notme's RFC 8414 doc → authenticates.
  Nothing hardcoded.
- One new append-only schema field (`@11`); one new route file; one header on
  the existing 401 path. No trust-boundary change — the metadata is public and
  the lease gate is unchanged in what it *accepts*.
- The `dpop_signing_alg_values_supported` value must stay equal to what the
  lease gate actually verifies and to notme's published value; a follow-up
  should source all three from one place rather than three literals (the
  scope/alg-drift lesson from the notme discovery work).

## Threat-model note

Adding a public metadata surface widens the unauthenticated attack surface by
one GET of caller-configured, non-secret data (no request reflection, no
existence oracle — it returns the same document to everyone or 404 when
unconfigured). The `WWW-Authenticate` value is built from the operator-supplied
resource identifier; it MUST be validated as an absolute URL with no
query/fragment/userinfo so it cannot inject header content — the exact LOW
finding the signet half's adversarial review caught and fixed, to be carried
into the TS implementation and its tests.
