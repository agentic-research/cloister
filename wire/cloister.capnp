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
# ── Schema-evolution discipline ──────────────────────────────────────────
#
# Cap'n Proto wire-compat rules apply here too:
#
#   - Adding a new field at the end of a struct is safe.
#   - Adding a new variant to a union is safe IFF you bump union ordinals
#     contiguously and never reuse a retired one.
#   - Removing a field is NOT safe — mark it deprecated and stop populating it.
#   - Renumbering @N tags is NEVER safe — capnp identifies fields by ordinal.
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
