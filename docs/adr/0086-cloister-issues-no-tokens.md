---
title: "ADR-0086: Cloister issues no tokens; notme does"
status: Accepted (2026-11-22)
date: 2026-11-22
tags: [identity, tokens, oauth, notme, trust-boundary]
tracking-bead: cloister-ca2582
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0047-vault-bundle-identity.md
  - 0081-cloister-is-a-core-drivers-and-features.md
external_refs:
  - https://www.rfc-editor.org/rfc/rfc6749#section-4.4
  - https://www.rfc-editor.org/rfc/rfc9449
---

# ADR-0086: Cloister issues no tokens; notme does

## Status

Accepted (2026-11-22). The owner confirmed that nothing calls the endpoint
this removes.

## Context

The identity bridge (`cloister-c9922f`) was written to make cloister "a
working OIDC IdP". Beside WebFinger and NIP-05 it served three paths:

- `POST /oauth/token`, a `client_credentials` grant. notme signed the JWT on
  a key it holds for cloister alone (notme ADR-015).
- `GET /.well-known/openid-configuration`, which described that endpoint.
- `GET /.well-known/jwks.json`, which published the key to verify its tokens.

The endpoint authenticated no client. Its tenant doc said it required a
lease. The code never did, no test checked either way, and the threat model
had no section on it. notme ADR-015 confines what that key signs to
cloister's trust domain, and leaves who may receive a token to cloister.
Inside that domain, the endpoint was the only control.

Mapping how each network type checks its caller found it. Gating it would
have been the narrow fix. The question underneath is whether cloister should
issue tokens at all, and notme already answers it:

- notme is an OAuth authorization server over the same root that issues
  cloister's leases. Its `POST /token` issues sender-constrained tokens
  (RFC 9449) to a caller that proves an authentication it already passed.
  `/authorize` with PKCE serves apps.
- notme is deliberately not an OpenID provider. It never vends a third party
  a bearer claim about who someone is.
- notme ADR-020 asks the stack to compose the credentials that exist, never
  to introduce a new authorization token.

A cloister token endpoint was a second issuer beside notme's, issuing bearer
tokens notme's design refuses to issue. RFC 6749 §4.4 also requires the
client credentials grant to authenticate its client.

## Decision

1. **Cloister issues no tokens.** `POST /oauth/token`,
   `/.well-known/openid-configuration` and `/.well-known/jwks.json` are
   removed, with the `NOTME_JWT` binding that reached notme's signer. Each
   path now answers 404.
2. **A client gets its token from notme**: `POST /token` after proving who
   it is, or `/authorize` with PKCE for an app. Cloister verifies notme's
   credentials, a lease today and notme's sender-constrained tokens once
   `cloister-2b98c0` wires the verifier. It does not mint its own.
3. **WebFinger and NIP-05 stay.** They publish the actor's fingerprint and
   public key, which are identity, not credentials. WebFinger no longer names
   cloister as an OIDC issuer, since none is here.
4. **A token that a federation provider accepts is notme's to answer.**
   Workload identity federation wants bearer OIDC tokens. notme ADR-017
   (proposed) takes that up with holder-bound tokens. Cloister does not
   bridge the gap with an issuer of its own.

## Consequences

- A caller of any removed path gets a 404. The owner confirmed none exists.
- `actor.pubkeyBinding` names only the key the bridge publishes. notme
  ADR-015's migration note, to point it at the delegated key, no longer
  applies.
- notme's `DELEGATED_JWT_ISSUERS` no longer needs the gateway's origin, and
  removing it is the operator's step on the notme side. A deployment still
  running the earlier gateway should take it, because the signer answers for
  any origin on that list.
- The tests assert that each removed path answers 404 through the router,
  whatever the request carries.

## Alternatives considered

- **Require a lease, as the tenant doc said.** That closes the gap, and
  keeps a second token issuer beside notme's that issues bearer tokens.
- **Keep the discovery documents without the endpoint.** They would describe
  an issuer that issues nothing.
- **Forward `/oauth/token` to notme.** notme's token endpoint is `/token`, on
  its own origin, with its own client authentication. A forward under
  cloister's origin would present notme's issuer at an address that is not
  notme's.
