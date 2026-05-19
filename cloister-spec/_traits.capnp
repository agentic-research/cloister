@0xd3b652fd6a4debe6;

# _traits.capnp — canonical trait annotations for cloister capability specs.
#
# Status: Draft (2026-05-18).
# Tracking bead: cloister-94cf13 (L2 of the substrate-IDL track).
# Pairs with: ADR-0022 §3 (canonical traits land in L2), ADR-0028 §3
# (capability scheme — `$Capability` annotation uses lane-3
# `cloister/<name>/v<n>` shape).
#
# WHY THIS FILE EXISTS
# --------------------
# Capability specs under cloister-spec/<cap>/<v>/ need a vocabulary
# for marking fields and structs with substrate-relevant semantics:
# "this field is sensitive (must be redacted in logs)", "this
# struct represents an op with input/output/errors", "this field
# was added at version X". Without a canonical library, every spec
# invents its own conventions and schema-bridge's emitters can't
# lower them consistently.
#
# This file IS the canonical library. Spec authors import these
# annotations; schema-bridge teaches each emit target (zod today,
# Rust later, etc.) how to honor them.
#
# WHAT THIS FILE IS NOT
# ---------------------
# - Not a spec itself. The underscore prefix (`_traits.capnp` vs
#   `<cap>/v1/*.capnp`) signals "spec-tree-shared infrastructure"
#   per the same convention as `_capability-mapping.md`.
# - Not a runtime contract. These are compile-time annotations;
#   they shape the IR schema-bridge walks, not the bytes any wire
#   carries.
# - Not exhaustive. New traits land here when the substrate needs
#   them (e.g. a future `$RateLimit(bucket, rps)` for the
#   capability matchmaker). New names follow the rules in §Naming
#   at the bottom.
#
# SCHEMA-EVOLUTION RULES
# ----------------------
# Same as manifest/cloister.capnp + manifest/cluster.capnp per
# ADR-0004: append-only, monotonically-increasing ordinals, never
# renumber. A retired trait keeps its ordinal in place and stops
# being applied; the annotation declaration stays so old serialized
# schemas still parse.

# ── §Field-level annotations ──────────────────────────────────────────────

# `$Sensitive` — field carries credential or PII data. Targets that
# emit logging, debug-print, or schema-doc representations MUST redact
# the value (e.g. zod's `.describe('REDACTED')`, Rust's `Debug` impl
# that prints `***`, JSON Schema description "(value omitted)").
#
# Apply to: any field whose value should never appear in operator-
# facing log lines, error messages, or default Debug output. Examples:
# credential bytes, API keys, KEK material, raw cert private key,
# OIDC bearer tokens.
annotation sensitive @0xd3b652fd6a4debe7 (field) :Void;

# `$Scope(value)` — field's value MUST match the substrate scope
# vocabulary (Interlace scope strings, vault `allowedSubs` globs,
# disclosure cursor scopes). Targets that emit validation (zod
# refinement, Rust newtype with TryFrom, JSON Schema pattern) wire
# in the scope-vocabulary check.
#
# `value` names the scope family. Today's families:
#   "interlace"      — lease-bearer scope strings (cert scope claim)
#   "vault"          — allowedSubs glob (`*`, `**`, `tool/*`)
#   "disclosure"     — peer-fingerprint scoped cursor scope
#   "capability"     — cloister/<name>/v<n> (lane-3 per ADR-0028)
#
# Adding a new family requires this file's docstring + a row in
# `_capability-mapping.md` if it crosses lanes.
annotation scope @0xd3b652fd6a4debe8 (field) :Text;

# `$Capability(ref)` — field's value names a capability interface
# (lane 3 per ADR-0028). MUST be the `cloister/<name>/v<n>` shape;
# the future capability-scheme lint (per ADR-0028 §6) catches
# leakage of URN/WIMSE values into fields carrying this annotation.
#
# `ref` is the literal interface name (e.g. "cloister/bead-store/v1");
# the empty string means "any capability interface — value not
# constrained" (rare; useful for inline-typed capability lists where
# the operator names the interface dynamically).
annotation capability @0xd3b652fd6a4debe9 (field) :Text;

# `$Since(version)` — field was added in the named version of the
# enclosing spec. Targets that emit version-aware code (deprecation
# warnings, deserializer defaults, doc-version pickers) use this to
# decide field-presence behavior.
#
# `version` follows the cloister-spec/ versioning conventions in
# LAYOUT.md §Versioning (either `v<n>` or full semver `<maj>.<min>.<patch>`).
annotation since @0xd3b652fd6a4debea (field, struct) :Text;

# `$Deprecated(replacement)` — field or struct is deprecated; readers
# should switch to the named replacement. Targets that emit deprecation
# warnings (Rust `#[deprecated(note = "...")]`, zod `.describe('deprecated; use ...')`,
# JSON Schema `deprecated: true`) consume this annotation.
#
# `replacement` is a free-text pointer (e.g. "use field `newName` instead"
# or "use struct `NewShape`"). Empty string means "no replacement;
# deprecated for removal."
annotation deprecated @0xd3b652fd6a4debeb (field, struct) :Text;

# `$Unstable` — field or struct is provisional; consumers MUST treat
# it as may-change-without-notice across minor version bumps. Pairs
# with `$Since` for new-feature staging: ship as `$Since($v) + $Unstable`,
# remove `$Unstable` when the wire shape stabilizes.
#
# Differs from `$Deprecated`: deprecated means "going away",
# unstable means "may change shape but is not going away."
annotation unstable @0xd3b652fd6a4debec (field, struct) :Void;

# ── §Struct-level annotations ─────────────────────────────────────────────

# `$Op(input, output, errors)` — declares a struct represents an
# operation invocable through the substrate (e.g. an MCP tool call,
# a vault-proxy call, a sign-helper RPC). Targets that emit RPC
# scaffolding (Rust service traits, zod-routed handlers) consume the
# triple to generate input/output schemas + error variants.
#
# This is the borrow from Smithy `@http`-shaped operation annotations
# per ADR-0022 §3. The trade against Smithy was "we want the trait
# shape, not the IDL" — this annotation IS the shape.
struct OpInfo {
  input   @0 :Text;        # struct name of input shape
  output  @1 :Text;        # struct name of output shape
  errors  @2 :List(Text);  # struct/enum names of typed error variants
}

annotation op @0xd3b652fd6a4debed (struct, interface) :OpInfo;

# ── §Naming rules (for future trait additions) ────────────────────────────
#
# 1. Lower-case, no underscores or hyphens (capnp annotation convention).
#    Prefer single-word names; two-word names use `lowerCamelCase`.
#    Names appearing in spec source as `$Sensitive` etc. are the
#    capability spec convention — the underlying capnp annotation name
#    is `sensitive` (capnp doesn't carry the `$` sigil; that's prose-only).
#
# 2. Each annotation gets a unique 64-bit ordinal in the range
#    @0xd3b652fd6a4debe7..@0xd3b652fd6a4debff (16 slots reserved for
#    file 0xd3b652fd6a4debe6). When this range fills, allocate a new
#    file with `capnp id`.
#
# 3. Annotations that constrain values (`$Scope`, `$Capability`) MUST
#    document the value vocabulary in their docstring + cross-link to
#    `_capability-mapping.md` if they cross lanes.
#
# 4. Annotations that gate runtime behavior (validation, deprecation
#    warnings) MUST cite which emit target consumes them. Annotations
#    that exist only as documentation (currently none) MUST say so
#    explicitly in their docstring so future contributors don't add
#    runtime behavior to a doc-only trait.
#
# 5. Removal is a major-version bump (per LAYOUT.md §Versioning).
#    Annotations don't get retired in-place; deprecate first, remove
#    in the next major.
