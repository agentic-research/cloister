# Problem Statement: §13.2 Non-Repudiation Gap

> **Audience.** Math-friend / theoretical-foundations-analyst. This is a
> precise formulation of the cryptographic flaw in interlace-spec/0.1.0
> §13.2 ("silence is evidence") for adversarial review before the
> proposed 0.2.0 fix is locked into a specification.
>
> **Goal.** Confirm or refute: (a) the gap exists as formulated below;
> (b) the proposed fix (signed receipts) closes it; (c) the proposed
> fix introduces no new gaps. Edge cases and alternative attacks
> welcomed.

***

## 1. Setting and notation

Let *A* be an Actor (cloister in our reference implementation), and let
*P* be a Peer (any caller — another bundle, an external service, a
human). *A* publishes:

* A master Ed25519 keypair $(sk_A, pk_A)$. $pk_A$ is widely known; the
  fingerprint $fp_A = \text{SHA256}(pk_A)$ is published in *A*'s
  `.well-known/interlace/index.json`.
* A disclosure endpoint $D_A$ that serves *A*'s "chain": a hash-linked
  append-only log of (request_nonce, decision, timestamp) tuples for
  every authenticated request *A* admitted.

A *third-party auditor* $V$ has knowledge of $pk_A$ and can fetch $D_A$
at any time.

We use:

* Standard TLS 1.3 with mutually authenticated client and server
  (interlace lease cert presented by *P*; long-lived TLS cert presented
  by *A* — irrelevant to the threat below).
* All messages traverse a TLS session; no out-of-band channel exists.

We assume:

* The Ed25519 signature scheme is EUF-CMA secure.
* SHA-256 is collision-resistant.
* TLS provides confidentiality and integrity *during a session*. (We
  do **not** assume TLS provides non-repudiation post-session — that's
  the heart of the problem.)

## 2. The §13.2 invariant as currently stated

interlace-spec/0.1.0 §13.2 asserts:

> If peer P interacted with actor A and P's request was admitted (any
> HTTP 2xx from A), then P's chain in $D_A$ MUST contain an entry. If
> P later queries $D_A$ and finds no such entry, that absence is
> **cryptographic proof** A admitted the request off-record.

Operationally, the protocol intends:

1. *P* sends a request $r$ over TLS, signed under *P*'s ephemeral
   lease cert.
2. *A* validates the lease, runs the request, computes a response
   $resp$, commits an entry $(\text{nonce}(r), 2xx, t)$ to its
   chain $D_A$.
3. *P* receives $resp$ over the same TLS session.
4. At any later time, $V$ queries $D_A$ to verify the entry exists.

The §13.2 claim is that step 2 must happen if step 3 happens, and
absence-in-step-4 is mathematical proof of cheating.

## 3. The claim, formalized

For §13.2 to be "cryptographic proof," the following must hold:

> **Soundness (no false positives).** For any honest peer $P^\star$,
> if $V$ later observes "*P*$^\star$ holds a record of A's 2xx for
> request $r$, but $D_A$ has no entry for $\text{nonce}(r)$," then
> with probability $\geq 1 - \text{negl}(\lambda)$ in the security
> parameter $\lambda$, *A* did in fact admit $r$ off-record.

(Completeness — every actually-admitted request appears in $D_A$ — is
trivially achievable: $A$ just writes the entry. We're focused on
soundness, which is what makes the property useful to $V$.)

The soundness claim is equivalent to: **$P^\star$ can produce a
$V$-verifiable witness that $A$ generated the 2xx response for $r$.**

## 4. The flaw

Under standard TLS, $P^\star$ **cannot** produce such a witness. Here
is why, by adversarial construction.

### 4.1 Cheating Peer construction

Consider a dishonest peer $P^{\text{dishonest}}$ who never actually
interacted with $A$ but wants to falsely accuse $A$.

$P^{\text{dishonest}}$ does the following:

1. Generates a request $r$ with a fresh nonce.
2. Constructs a believable HTTP response transcript $resp$ that claims
   to be from $A$, with status 200 and some plausible body.
3. Presents to $V$ the pair $(r, resp)$ as "evidence A admitted my
   request and left it off-record."

The question is whether $V$ can distinguish $P^{\text{dishonest}}$'s
forgery from an honest $P^\star$'s real evidence.

Under standard TLS, **no**. The TLS transcript is bound to symmetric
session keys derived from ECDHE. After session close:

* Both parties hold the same key material.
* Either party can synthesize any transcript using those keys.
* No cryptographic primitive in the TLS session record binds the
  content to a specific party's long-term key.

So $P^{\text{dishonest}}$'s forged $resp$ is indistinguishable from
an honest $P^\star$'s real $resp$.

### 4.2 Cheating Actor construction

Symmetrically, consider a dishonest actor $A^{\text{dishonest}}$ who
did admit $r$ but wants to deny it.

$A^{\text{dishonest}}$ simply:

1. Admits $r$, returns 2xx as normal.
2. Omits the chain entry from $D_A$.
3. When confronted by $V$, claims "I never received request $r$."

Under standard TLS, $P^\star$'s response to "*A* received and admitted
$r$" is the response transcript — which §4.1 just showed is forgeable.
$A^{\text{dishonest}}$ can plausibly deny.

### 4.3 Conclusion

The §13.2 "cryptographic proof" claim is false in the current spec.
The property reduces to **honest-actor assumption at admission time** —
which is the assumption the threat model is supposed to relax.

## 5. The proposed fix

*A* signs each 2xx response with $sk_A$ over a canonical commitment to
the request and response:

$$
\text{canonical}(r, resp) = \text{CBOR}\big(\{
  \text{nonce} := \text{nonce}(r),
  \text{status} := 200,
  \text{body\_hash} := \text{SHA256}(\text{body}(resp)),
  \text{timestamp\_ms} := t,
  \text{actor\_fp} := fp_A
\}\big)
$$

$$
\text{receipt}(r, resp) = (\text{canonical}, \text{Sign}(sk_A, \text{canonical}))
$$

The receipt rides back in an `X-Interlace-Receipt` header. $P^\star$
retains it.

### Updated §13.2 (proposed)

> If peer $P$ holds a valid receipt $\text{receipt}(r, resp)$ — i.e., a
> signature under $pk_A$ over the canonical commitment to $r$ and
> $resp$ — and $D_A$ contains no entry for $\text{nonce}(r)$, then $A$
> admitted $r$ off-record.

Soundness now reduces to: a peer cannot forge a receipt without
$sk_A$. Under EUF-CMA security of Ed25519, this requires $A$'s
collaboration.

## 6. Open questions for review

Math-friend feedback is requested on:

### 6.1 Does the fix close the gap?

Is the receipt construction in §5 sufficient? Specifically:

* Are there transcript-equivalence attacks where two distinct $(r, resp)$
  pairs map to the same `canonical()`?
* Does CBOR canonicalization (per RFC 8949 §4.2) give us
  signature-stable encoding, or are there encoding ambiguities that
  could produce two valid receipts for two distinct response bodies?
* Is `body_hash` over the raw response body sufficient, or do we need
  to commit to response headers as well? (Cache-control, location,
  content-encoding all matter to a real consumer; should they be
  signed?)

### 6.2 New attack surfaces introduced by receipts

* **Receipt-replay**: if $P$ shares its receipt, can a third party use
  it against $A$? (We claim no — the receipt is evidence-of-admission,
  not a capability. But subtle attacks may exist.)
* **Selective disclosure**: $A$ refuses to sign receipts for selected
  requests, then drops them silently. Detection requires $P$ to fail
  the request on missing receipt — i.e., the protocol must make
  receipt-emission *mandatory* for 2xx responses, and $P$ must reject
  any 2xx without a verifiable receipt.
* **Timestamp manipulation**: $A$ could sign with a backdated
  timestamp to claim the request was processed earlier than it was.
  Does this matter for §13.4 ordering? Probably yes if cross-peer
  ordering matters; what's the right binding?
* **Key rotation race**: $A$ rotates $sk_A$ after signing a receipt;
  $V$ later cannot verify against the new $pk_A$. Mitigation: include
  $\text{epoch}$ in canonical and require $V$ to fetch the historical
  CA bundle.

### 6.3 Granularity question

Per-request signatures are sub-millisecond cost (~0.05ms on M1 for
Ed25519 sign). At 10k QPS that's 500ms of CPU per second per worker —
not free, but tolerable.

Alternative: Merkle-root receipts over batches. $A$ commits to a
Merkle root every $\Delta$ seconds; $P$ holds an inclusion proof
$(\text{nonce}, \text{proof}, \text{root}, \text{epoch})$. Cheaper at
high QPS, coarser-grained ($A$ can drop entries up to one batch in
the past without immediate detection if $P$ doesn't audit until later).

Question for math-friend: does the granularity matter for the
§13.4 invariant, or is per-request strictly stronger?

### 6.4 Comparison to alternative non-repudiation primitives

* **TLS-Notary / DECO** — third-party witnesses to TLS handshakes.
  Heavyweight; requires either trusted third party or zero-knowledge
  proof of session-key knowledge. Overkill.
* **Signed-transcript extension to TLS 1.3** — `signed_certificate_timestamp`
  is the closest precedent. Not standardized for this use case.
* **Counter-signed manifests** — both sides sign a periodic manifest.
  Already the §13.4 audit pattern. Doesn't close the per-request gap.

The proposal in §5 is the simplest mechanism that closes the gap.
Is there a leaner construction we're missing?

### 6.5 Threat model boundaries

The fix assumes:

* $A$'s master key is uncompromised. If $sk_A$ leaks, all receipts
  $V$ has ever seen become forgeable. This is the same trust root as
  the current §13.2; no change.
* $P$'s storage is honest. A malicious $P$ that destroys its own
  receipts cannot accuse $A$ — but cannot frame $A$ either. Receipt
  retention is on $P$.
* Time is reasonably synchronized between $A$ and $V$. Required for
  the timestamp field's semantic; we already require this elsewhere
  in the spec (clock-skew bounds in §6.2.7).

## 7. Adjacent concerns out of scope

These are flagged but not part of this review:

* **URL canonicalization at scale** (interlace-spec §3.2) — separate
  bead `cloister-aecd26`. Related because reverse proxies could
  rewrite the request path *before* $A$ sees it, leading to a
  request-nonce mismatch between $P$'s receipt and $A$'s chain entry.
  The canonicalization fix has to be compatible with the receipt
  construction — specifically, the nonce must be over content that
  survives proxy rewrites.
* **Receipt retention policy** — how long must $P$ hold receipts to
  honor §13.4? Operational concern, not cryptographic.
* **Performance** — covered in §6.3.

## 8. Request for math-friend

Please review §3–§5 for correctness of the formalization. The user
review that surfaced this gap was correct in its informal framing; we
want the formal version to be defensible against a security-paper
referee.

In particular, please challenge:

* The claim in §4 that TLS provides no non-repudiation. (Standard
  result, but please confirm against the exact TLS 1.3 spec we're
  targeting.)
* The reduction in §5 from "non-repudiation" to "EUF-CMA security of
  Ed25519." Are there issues with the message format under §6.1 that
  would weaken the reduction?
* The open questions in §6 — please rank them by criticality and flag
  any we missed.

Refute the proposal if it's wrong. The cost of getting this wrong in
the spec is much higher than the cost of revising the proposal.
