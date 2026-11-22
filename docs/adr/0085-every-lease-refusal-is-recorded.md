---
title: "ADR-0085: Every lease refusal is recorded"
status: Accepted (2026-11-22)
date: 2026-11-22
tags: [audit, lease, ingress, observability, trust-boundary]
tracking-bead: cloister-ca2582
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0053-lease-gate-authority-resolution.md
  - 0081-cloister-is-a-core-drivers-and-features.md
  - 0082-one-credential-injection-applied-by-the-vault-as-declared.md
external_refs:
  - https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
  - https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/
---

# ADR-0085: Every lease refusal is recorded

## Status

Accepted (2026-11-22). Mapping core's guarantees to tests (ADR-0081) found
that audit recorded only what was allowed. The §13.4 chain records an
authenticated write, and nothing recorded a refusal.

## Context

Every lease-gated route goes through `gateAndVerify` (ADR-0053): MCP, the
vault proxy, disclosure and the OCI registry. It refuses a request for one of
these reasons:

- the gate is off and the route denies when off (the vault);
- there is no CA bundle, so the gate fails closed;
- a verifier step fails: the header's shape, clock skew, the certificate
  chain, its epoch, its validity window, the request signature, the scope, or
  a replay.

Each refusal returned the constant-shape error the threat model requires, and
left no trace. An operator could not see probing, an expired certificate, a
scope that no longer fits, or a CA outage that refuses every request.

Prior art agrees on recording refusals. OWASP's Logging Cheat Sheet lists
authentication and authorization failures first among the events to record.
Kubernetes' audit log records every request, and a denied one with the
authorizer's reason.

## Decision

1. **`gateAndVerify` records each refusal, once.** It emits one structured
   event through `logEvent`: target `lease_gate`, op `verify`, outcome
   `refused`. The event carries the JSON-RPC code, the reason, the route's
   path without its query, the method, and the scope asked for. This is the one
   door every lease-gated route uses, so no refusal goes unrecorded and none is
   recorded twice.
2. **It never records what proves or carries authority.** No certificate,
   signature, nonce, timestamp header, body or credential appears in the
   event. The reasons name what was checked, not the bytes checked.
3. **The response does not change.** The verdict is the same, so each route
   still returns its constant-shape refusal, disclosure's 404 included. The
   event is for the operator, and the caller learns nothing new.
4. **A tenant router records nothing of its own.** `tenantDispatch` is a
   pre-auth dispatcher (threat model §13.7.1). The tenant's own gateway
   verifies the lease, after dispatch, and records its refusals. The
   dispatcher's comment said verification happened before dispatch, and is
   corrected.

## Consequences

- **Volume.** Each refused request is one event, so a flood of refused
  requests is a flood of events. The pre-auth budget bounds the expensive
  verify path, and the platform's log pipeline samples volume. The threat model
  records this as residual.
- **Scope.** Refusals outside the lease gate are not covered here. The
  vault's `credential_upstream_mismatch` is already audited (ADR-0082). The
  tenant router's unknown-tenant 404 is a throttled warning
  (`cloister-9339c0`).
- **Open.** A `tenantDispatch` target must be a gateway that verifies leases,
  but nothing declared says which bundles are gateways. A target that is not
  one verifies nothing. The declaration that marks a gateway, and the rail
  that refuses a tenant binding to anything else, are still to be chosen.

## Alternatives considered

- **Record in each route.** That is four copies of one rule, and the next
  gated route would forget it.
- **Record in the TrustStore, beside attestations.** A refusal is
  unauthenticated, so anyone could make the trust store write, which turns
  every refused request into a write.
- **Tell the caller more.** The constant-shape responses exist to deny
  oracles. Detail belongs in the operator's record, not in the response.
