# `_traits.capnp` — canonical trait annotations

**Status:** Draft (2026-05-18)
**Tracking bead:** `cloister-94cf13` (L2 of the substrate-IDL track)
**Pairs with:** [ADR-0022](../docs/adr/0022-schema-bridge-substrate-positioning.md)
§3, [ADR-0028](../docs/adr/0028-capability-scheme.md) §3,
[`_capability-mapping.md`](_capability-mapping.md)

This is the human-readable companion to
[`_traits.capnp`](_traits.capnp). The `.capnp` file IS the contract;
this `.md` walks through *when* to reach for each annotation, with
worked examples.

## §1 What annotations are for

Capability specs under `cloister-spec/<cap>/<v>/` need a vocabulary
for marking fields and structs with substrate-relevant semantics
that the wire bytes don't carry but every emit target (zod, Rust,
JSON Schema) needs to honor consistently:

- "This field is sensitive — never log its value."
- "This field's value names a capability interface — lint it."
- "This struct represents an operation — emit RPC scaffolding for
  it."
- "This field was added at version X — readers below that version
  must tolerate its absence."

Annotations are the trait-shape borrow from Smithy / Buf / WIT
(ADR-0022 §3) without inheriting any of those toolchains' broader
IDL choices. They are compile-time vocabulary; schema-bridge walks
them and teaches each downstream emitter how to lower them.

## §2 The catalog

Each annotation appears in `_traits.capnp` with its ordinal +
docstring. Use this table to find the right one quickly; read the
docstring for full semantics.

| Trait | Target | What it carries | Typical use |
|-------|--------|-----------------|-------------|
| `$Sensitive` | field | (no value — flag only) | Credential bytes, KEK material, OIDC bearer tokens |
| `$Scope(value)` | field | scope-family name (`"interlace"` / `"vault"` / `"disclosure"` / `"capability"`) | Lease scope strings, vault allowedSubs globs |
| `$Capability(ref)` | field | capability interface name (`cloister/<name>/v<n>`) or `""` for any | `Bundle.provides` / `Wire.requires` slots |
| `$Since(version)` | field, struct | version string (`v1` or `0.1.0`) | New fields added in a minor bump |
| `$Deprecated(replacement)` | field, struct | replacement pointer or `""` | Fields/structs scheduled for removal |
| `$Unstable` | field, struct | (no value — flag only) | Provisional shapes that may change |
| `$Op(input, output, errors)` | struct, interface | operation triple | Tool calls, vault-proxy calls, sign-helper RPCs |

## §3 Worked examples

### §3.1 Marking a credential field sensitive

```capnp
struct VaultProxyEnvelope {
  service           @0 :Text;
  upstreamPath      @1 :Text;
  injectedHeader    @2 :Text $sensitive;   # API key — never log
  injectedHeaderName @3 :Text;             # safe: just the header name
}
```

Downstream lowering:
- **zod:** `injectedHeader: z.string().describe('REDACTED').refine(_ => true, { message: 'sensitive' })`
- **Rust:** `#[derive(Debug)]` impl that prints `injectedHeader: "***"`
- **JSON Schema:** `"description": "(value omitted — sensitive)"`

### §3.2 Constraining a scope field

```capnp
struct ProxyCallReceipt {
  peerFp @0 :Text;
  scope  @1 :Text $scope("interlace");   # must match the Interlace
                                          # scope vocabulary (e.g.
                                          # "vault-proxy:foo-service")
}
```

The scope-family name tells emitters which validation to wire in.
`$Scope("interlace")` doesn't change the wire bytes — it constrains
which strings are *allowed* and tells lint how to spot non-matches.

### §3.3 Declaring an op

```capnp
struct VaultProxyCallInput {
  service       @0 :Text;
  upstreamPath  @1 :Text;
}

struct VaultProxyCallOutput {
  statusCode    @0 :UInt16;
  bodyDigest    @1 :Text;
}

struct VaultProxyCallError {
  code          @0 :Text;      # "not_found" | "unauthorized" | ...
  retryAfterMs  @1 :UInt32;
}

# The op annotation declares the triple.
struct VaultProxyCall $op(VaultProxyCallInput, VaultProxyCallOutput, [VaultProxyCallError]) {
  # Empty body — annotation is the whole declaration; concrete
  # implementations bind input/output/errors at substrate
  # composition time.
}
```

Downstream lowering (Rust):
```rust
#[async_trait]
pub trait VaultProxyCall {
    async fn invoke(&self, input: VaultProxyCallInput)
        -> Result<VaultProxyCallOutput, VaultProxyCallError>;
}
```

### §3.4 Version-staging a new field

```capnp
struct ProxyCallReceipt {
  peerFp   @0 :Text;
  scope    @1 :Text;
  cursorId @2 :Text $since("0.2.0") $unstable;
}
```

`$Since("0.2.0")` signals "if you're a 0.1.0 reader, tolerate this
field's absence." `$Unstable` signals "we may change this field's
shape inside 0.2.0; don't pin." Remove `$Unstable` when the shape
locks; keep `$Since` permanently.

### §3.5 Deprecating a field

```capnp
struct ProxyCallReceipt {
  peerFp  @0 :Text;
  scope   @1 :Text;
  legacyB @2 :Text $deprecated("use `scope` instead — was used pre-0.2.0");
}
```

`$Deprecated` does not remove the field — that would renumber. The
field stays at @2 forever (capnp wire-compat rule); only its
documented status changes. Removal is a major-version bump (new
`<vnext>` directory; the field is simply absent from the new schema).

## §4 What NOT to annotate

- **Don't $Sensitive a struct.** Sensitivity is per-field. A struct
  marked sensitive would force every downstream lowering to opt
  every field into redaction, which is usually wrong (the
  envelope's identifying metadata is fine to log; only the payload
  bytes are sensitive).
- **Don't $Scope without a family value.** `$scope("")` defeats the
  point. If you don't know which family the field belongs to, the
  field shouldn't carry a substrate-recognized scope — declare it
  as plain text and document the value space in prose.
- **Don't $Capability with a URN or WIMSE shape.** Per ADR-0028 §3,
  the lane-3 (`cloister/<name>/v<n>`) shape is the only legal value.
  The future lint catches this; before the lint, code review does.
- **Don't $Deprecated a field you'll remove tomorrow.** Deprecation
  is the migration ramp — readers need at least one version of
  warning before the next major bump removes the field. If you
  want it gone immediately, you want a major bump, not deprecation.

## §5 Adding a new trait

When the substrate needs a new annotation (e.g. `$RateLimit(bucket, rps)`
for the capability matchmaker, or `$Audit(level)` for tunable
receipt-emission verbosity):

1. **Open a bead.** New traits are substrate-wide vocabulary; the
   decision should be visible in the work-tracker, not invented in
   a feature branch.
2. **Pick the next ordinal.** Range `@0xd3b652fd6a4debe7..@0xd3b652fd6a4debff`
   is the trait file's 16-slot reserve. Allocate sequentially; when
   the range fills, run `capnp id` for a new file. (We are at
   `@0xd3b652fd6a4debed` as of `cloister-94cf13`; 10 slots remain.)
3. **Declare in `_traits.capnp`.** Follow the docstring conventions
   in `_traits.capnp` §Naming.
4. **Document the lowering.** Every emit target schema-bridge knows
   about MUST grow a handler for the new annotation, OR explicitly
   document that the annotation is a no-op for that target.
5. **Worked example here.** Add a §3.X subsection to this doc.

## §6 Why these names and not Smithy's

ADR-0022 §3 commits the substrate to *borrow the trait shape, not
the IDL.* Smithy's `@sensitive`, `@deprecated`, etc. shaped this
file. Differences:

- **No `@` sigil.** Capnp annotations use `$name` syntax in source;
  the `@` collides with capnp's ordinal sigil (`@N`).
- **`$Scope` is one annotation with a family value**, not separate
  annotations per scope vocabulary. We have four families today;
  adding a fifth doesn't grow the annotation count, just the value
  vocabulary.
- **`$Capability` is its own annotation**, separate from `$Scope("capability")`.
  Per ADR-0028 §3 forbidden-patterns, the capability-interface
  lane is distinct enough from generic scope strings to warrant
  its own annotation with its own lint behavior.
- **`$Unstable` carries no value.** Smithy's `@unstable` is also
  flag-only; we follow.

## §7 Where this doc lives, and where it might move

Same as `_capability-mapping.md` §8 — today this lives at
`cloister-spec/_traits.md`. If a shared ART substrate repo
materializes (per `docs/cross-repo-audit.md` findings #2 + #5), the
canonical trait library moves there alongside other cross-repo
substrate concerns, and notme/signet can reference it directly
instead of vendoring. Until then, cloister-spec is the home.
