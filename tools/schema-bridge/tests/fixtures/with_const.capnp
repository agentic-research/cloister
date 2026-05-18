# Fixture for schema-bridge's top-level `const` support (cloister-946a59 / L1
# of substrate-IDL). The integration tests build CodeGeneratorRequest
# messages by hand to keep the harness hermetic (no `capnp` CLI needed),
# but this file is the human-readable mirror of what those tests
# encode — write it like a real capnp schema so a future contributor
# can see the *shape* of supported const declarations without having to
# reverse-engineer the builder calls.
#
# When schema-bridge gains a CLI-driven test harness (or `task verify`
# learns to round-trip fixtures through `capnp compile -oschema-bridge`),
# this file becomes the input; for now it's documentation + a typing
# anchor for the bead-tracked feature.
#
# Per cloister-946a59. Unblocks @notme/contract migration to
# capnp-as-source-of-truth and L2's `_traits.capnp` value declarations.

@0xb5d4f3a7e21c8f02;

# Scalar consts — covered by `test_const_scalar`. Each maps to a
# `export const <NAME> = <literal> as const;` in the emitted .zod.ts.
const contractVersion :Int32 = 1;
const productName :Text = "notme";
const debugMode :Bool = false;

# List const — covered by `test_const_list`. List-of-Text is the
# common form (allowed scopes, trusted issuers, OIDC algs); list-of-
# numeric falls out of the same emitter path.
const allowedScopes :List(Text) = ["read", "write", "admin"];

# Struct const — covered by `test_const_struct`. The emit shape is
# `{ field: value, ... } as const`, with field names preserved in
# declaration order so the `as const` narrows each property to its
# literal type rather than the field's declared type.
struct ErrorStatus {
  code @0 :Int32;
  message @1 :Text;
  retryable @2 :Bool;
}
const notFoundStatus :ErrorStatus = (code = 404, message = "not found", retryable = false);
