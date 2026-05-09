# wire/cloister.capnp — cloister↔companion wire schema (ADR-0005 Phase 2A).
#
# This is the THIRD capnp file in this repo, by deliberate intention:
#
#   - manifest/cloister.capnp  (ADR-0004) — declarative gateway config
#   - config.capnp             (ADR-0001) — workerd runtime config
#   - wire/cloister.capnp      (ADR-0005) — over-the-wire frames between
#                                            cloister (workerd) and
#                                            cloister-companion (Rust)
#
# Each owns a distinct concern; sharing the schema language keeps the
# toolchain and error format unified.
#
# ── What this file describes ─────────────────────────────────────────────
#
# Cloister forwards incoming MCP `tools/call` requests to cloister-companion
# over loopback HTTP, where the BODY is a leyline-net frame:
#
#     [manifest length :2 bytes BE]
#     [manifest bytes  :variable]    -- a serialized `Manifest` struct
#     [aead nonce      :12 bytes]    -- ChaCha20-Poly1305 nonce
#     [aead ciphertext :variable]    -- AEAD(payload) where payload is a
#                                       serialized `ToolCall` (or the
#                                       response carries a `ToolResult`)
#
# AEAD authenticated-data binds the manifest bytes so a man-in-the-middle
# can't swap a manifest onto a stale ciphertext. The manifest's
# `contentHash` is SHA-256 of the AEAD plaintext (i.e. the un-encrypted
# capnp-encoded ToolCall/ToolResult); receivers verify it after decryption
# as a defense-in-depth check.
#
# ── Encoding implementation (workerd side) ───────────────────────────────
#
# Decision (2026-04-29, cloister-5183bc Phase 2D-codec): hand-rolled
# encoder/decoder in TypeScript. Reasons:
#
#   - capnp-ts (npm) is unmaintained — last release 2021, 9 dependents,
#     workerd compatibility unverified.
#   - capnp-es / 8thwall forks are single-maintainer; outsourcing wire-
#     format correctness for cross-host RPC is too much surface to delegate.
#   - Our schema is bounded: 5 structs, no nested lists, no inline structs
#     in lists, no parameterized generics. ~600 LOC of careful TS for
#     encode + decode on this surface.
#   - Hand-rolled = zero deps, no bundling surprises in workerd, exact
#     byte control, audit-friendly for security review.
#
# Format flags — cloister requires **canonical** Cap'n Proto encoding
# per capnproto.org/encoding.html#canonicalization. Canonicalization
# fixes the bytes for a given value; without it, capnp encoders are free
# to vary padding, segmentation, and unused-pointer truncation.
# Cloister's encoder rejects non-canonical shapes loudly:
#
#   - **Single segment** per message. encoding.html says "Ideally, every
#     message would have only one segment" and canonical form requires it.
#     Multi-segment input is rejected by the decoder
#     (src/wire/codec.ts:readSegmentStart) — implementations MAY emit
#     multi-segment for unbounded messages, which is why we narrow to a
#     bounded schema and demand canonical form.
#   - **Unpacked** binary encoding. Canonical form forbids the "packed"
#     zero-elision. cloister-companion runs on loopback HTTP where the
#     bandwidth savings of packing are not worth the layout variability.
#   - **Composite-list size code 7** for List(struct). Required by
#     canonical form (encoding.html#lists).
#   - **Stream framing** is OUR responsibility, not capnp's. The outer
#     wire frame (manifest-length / manifest-bytes / nonce / ciphertext)
#     lives above the capnp encoder; the encoder produces a single
#     contiguous byte slice per message.
#
# Cross-side equivalence: cloister-companion (Rust, when 2B lands) uses
# the official `capnp` crate. When both sides emit canonical form, the
# byte sequence is determined by the value. The cross-check tests at
# test/wire/cross-check.test.ts validate **structural equivalence**
# (round-trip preserves the value) rather than byte equality, since
# even canonical-form encoders may differ in implementation-defined
# corners; the substrate-equivalence proof is value-deterministic, not
# byte-deterministic. See encoding.html#canonicalization for the spec
# we're holding ourselves to.

# ── Schema-evolution discipline ──────────────────────────────────────────
#
# Cap'n Proto wire-compat rules apply here too. Quoted from
# capnproto.org/language.html § "Evolving Your Protocol":
#
#   - "New fields, enumerants, and methods may be added… as long as each
#     new member's number is larger than all previous members." — adding
#     fields and union variants at higher ordinals is safe.
#   - "You cannot change a field, method, or enumerant's number." —
#     renumbering @N tags is NEVER safe; reassigning a retired ordinal is
#     equivalent to renumbering. Retire a field by leaving its ordinal in
#     place and stopping population.
#   - "Any symbolic name can be changed, as long as the type ID / ordinal
#     numbers stay the same." — renaming a field is safe; names live in
#     codegen, never on the wire.
#
# When in doubt: add new fields, never remove or renumber. This file is
# load-bearing for cross-host wire compatibility once cloister-companion
# is shipping in deployed images; old companions must keep parsing new
# manifests and vice-versa.

@0xa1c0157e2a1e0001;

# ── Manifest: the unforgeable per-message header ─────────────────────────

# Every wire frame carries one of these. The signature binds the message's
# content + sequence number to a public key, so a receiver can authenticate
# every frame independently — no per-session secret, no replay window
# exposure beyond what the sequence counter enforces.
struct Manifest {
  # Monotonic per-(publicKey) counter. Receivers maintain a per-pubkey
  # last-seen value and reject any frame whose sequence is ≤ last-seen.
  # The window for legitimate retransmits is the sender's responsibility
  # (don't reuse a sequence on retry — issue a new one).
  sequence    @0 :UInt64;

  # Ed25519 public key, 32 bytes. Pinned by configuration on the receiver:
  # cloister-companion knows which pubkey cloister was provisioned with,
  # and rejects any other.
  publicKey   @1 :Data;

  # Ed25519 signature, 64 bytes, over the canonical concatenation:
  #     sequence (LE 8 bytes) ‖ contentHash (32 bytes)
  # NOT over the AEAD ciphertext — the contentHash binding is what guarantees
  # the signed plaintext matches what's in the AEAD payload.
  signature   @2 :Data;

  # SHA-256 of the AEAD plaintext (the serialized ToolCall or ToolResult,
  # before encryption). 32 bytes.
  contentHash @3 :Data;
}

# ── ToolCall: the request payload (encrypted) ────────────────────────────

# Cloister sends one of these to cloister-companion when a client calls
# `tools/call`. The companion routes to the configured upstream by
# `upstreamId`, decodes the result, and returns a ToolResult.
struct ToolCall {
  # Logical upstream identifier — names which backend the companion forwards
  # to (e.g. "rosary", "mache", "leyline"). Maps to companion-side config,
  # not user-controlled. The cloister-side `LeylineNetBackend` capnp spec
  # carries this value statically.
  upstreamId @0 :Text;

  # MCP tool name (e.g. "rsry_decompose", "lsp_hover"). The companion may
  # validate that this tool is actually advertised by the upstream, but
  # cloister has already done that check at manifest-build time.
  toolName   @1 :Text;

  # Tool arguments encoded as canonical JSON bytes (cloister already
  # canonicalizes incoming args via canonical(). Encoding as Data here
  # lets us preserve the exact bytes the cloister-side digest was computed
  # over without re-canonicalizing on the companion).
  #
  # Future evolution: a `args :ArgsUnion` field with one variant per known
  # tool would give end-to-end type safety, but requires a tool-schema
  # registry shared between cloister and companion. JSON bytes is the
  # simplest correct first cut.
  argumentsJson @2 :Data;
}

# ── ToolResult: the response payload (encrypted) ─────────────────────────

# What cloister-companion sends back. Mirrors the MCP `tools/call` result
# shape — content array + isError flag — so cloister can re-emit it as
# JSON-RPC at the public face with no semantic translation.
struct ToolResult {
  content @0 :List(Content);
  isError @1 :Bool;
}

# Per-MCP-spec, content items have a discriminated `type`. We encode that
# as a capnp union so each variant carries exactly the right shape.
struct Content {
  body :union {
    text     @0 :Text;            # type:"text"     — JSON-stringified or prose
    binary   @1 :BinaryContent;   # type:"image"    — bytes + MIME
    resource @2 :Data;            # type:"resource" — opaque to cloister; the
                                  # client decodes it. Forwarded verbatim.
  }
}

struct BinaryContent {
  data     @0 :Data;
  mimeType @1 :Text;
}
