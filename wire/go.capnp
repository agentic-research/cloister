@0xd12a1c51fedd6c88;

# Vendored go.capnp — defines the $Go.* annotations consumed by capnpc-go.
#
# Source: capnproto.org/go/capnp/v3@v3.1.0-alpha.2 (std/go.capnp).
# Mirrors ley-line-open/rs/ll-core/schema-capnp/schemas/go.capnp (LLO's
# leyline-schema Go-bindings pattern, which we mirror per cloister-b94ab0).
#
# This file is referenced by `using Go = import "go.capnp";` in the sibling
# cloister.capnp. It exists in this directory so:
#
#   - capnpc-go (regen.sh in clients/go/cloister-schema/) resolves the
#     import without needing a special -I path.
#   - `capnp eval` invocations against cross-check-fixtures.capnp continue
#     working — annotations are extensions; unknown ones are no-ops in the
#     eval path.
#   - The hand-rolled TypeScript encoder/decoder in src/wire/ is unaffected
#     — it doesn't parse the schema at all.

annotation package(file) :Text;
# The Go package name for the generated file.

annotation import(file) :Text;
# The Go import path that the generated file is accessible from.
# Used to generate import statements and check if two types are in the
# same package.

annotation doc(struct, field, enum) :Text;
# Adds a doc comment to the generated code.

annotation tag(enumerant) :Text;
# Changes the string representation of the enum in the generated code.

annotation notag(enumerant) :Void;
# Removes the string representation of the enum in the generated code.

annotation customtype(field) :Text;
# Changes the type of a field in the generated code.  The type must
# be able to be marshaled to and from the field's type using the
# encoding.BinaryMarshaler and encoding.BinaryUnmarshaler interfaces.

annotation name(struct, field, union, enum, enumerant, interface, method, param, annotation, const, group) :Text;
# Used to rename the element in the generated code.

$package("gocp");
$import("capnproto.org/go/capnp/v3/std/go");
