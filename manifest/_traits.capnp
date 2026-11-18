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

# `$Doc(text)` — human-facing documentation for a field, struct, enum,
# or enumerant. Capnp discards `#` comments at parse, so a spec that
# needs its documentation to survive into a generated schema carries it
# here. Targets that emit documentation-bearing schemas consume it:
#   - JSON Schema (schema-bridge jsonschema/tooldefs): `description`
#     keyword on the field's property object (and the tool-level
#     `description` for a `$Op`-annotated struct).
#   - zod/Go: NOT lowered today (zod could use `.describe(...)`, Go a
#     `//` line) — explicitly a no-op for those targets per §Naming 4.
#
# `text` is the raw description. For fields whose value is drawn from a
# fixed set, encode the choices in prose here (e.g. "Issue type: bug,
# feature, task, ...") — the same convention rosary's MCP tool registry
# uses (0 JSON `enum` arrays; choices live in the description).
annotation doc @0xd3b652fd6a4debee (field, struct, enum, enumerant) :Text;

# `$Optional` — field MAY be omitted by the producer. Capnp has no
# optional fields (a field always has a value on the wire), so a spec
# that models a curated required-subset — e.g. an MCP tool input where
# only `title` is mandatory — marks the omittable fields with this
# annotation. Targets that emit a required-set honor it:
#   - JSON Schema (schema-bridge): the field is DROPPED from the
#     `required` array. Un-annotated fields stay required.
#   - zod/Go: NOT lowered today (would be `.optional()` / a pointer
#     field) — explicitly a no-op for those targets per §Naming 4.
annotation optional @0xd3b652fd6a4debef (field) :Void;

# `$Default(json)` — field's default value, encoded as a JSON literal in
# `json` (the annotation text is injected verbatim as a JSON value, so
# it MUST be valid JSON: `2`, `false`, `"task"`, `""`, `[]`). Capnp's
# own `= value` field defaults are typed capnp literals the JSON-schema
# world can't consume directly, so the JSON form is carried explicitly.
# Targets that emit defaults honor it:
#   - JSON Schema (schema-bridge): the `default` keyword on the field's
#     property object, value = the annotation text verbatim.
#   - zod/Go: NOT lowered today — a no-op for those targets per §Naming 4.
annotation default @0xd3b652fd6a4debf0 (field) :Text;

# `$Map` — field is a string-keyed dictionary, not a list.
#
# Capnp has no map type. A schema that needs one models it as
# `List(Entry)` where `Entry` is a two-field struct of `key :Text` and
# `value :T`, and marks the field with this annotation. Targets that have
# a native map emit one:
#   - zod (schema-bridge): `z.record(z.string(), <T>)`
#   - Go (schema-bridge): `map[string]<T>`
#   - JSON Schema (schema-bridge): `{"type": "object",
#     "additionalProperties": <T>}`
#
# WHY AN ANNOTATION RATHER THAN SHAPE DETECTION
# ---------------------------------------------
# Inferring "this is a map" from a `List` of two-field `key`/`value`
# structs would silently reinterpret any struct that happens to have
# those field names. That is the guessing this crate's unmapped-construct
# invariant exists to prevent: a declaration and a shape that resembles
# one are different things, and only the author knows which they meant.
# The annotation makes it a statement.
#
# The wire is unaffected — capnp still carries `List(Entry)`. This
# changes only how the JSON-facing targets render it, which is the point:
# `resolution["git-url"]` is a lookup, and lowering it to an array turns
# every lookup into a scan.
annotation map @0xd3b652fd6a4debf1 (field) :Void;

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
  # `name` is the operation's externally-visible identifier — for an MCP
  # tool this is the exact `tools/list` name (e.g. "rsry_bead_create"),
  # which the schema-bridge tool-definitions emitter uses verbatim so the
  # generated `{name, description, inputSchema}` entry matches the
  # hand-written registry without a fragile CamelCase→snake heuristic.
  # Append-only (ordinal 3, a pointer field like the others) per the
  # SCHEMA-EVOLUTION RULES above.
  name    @3 :Text;        # externally-visible operation/tool name
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
