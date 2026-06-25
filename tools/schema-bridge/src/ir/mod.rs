// Intermediate representation.
//
// Inputs (capnp, JSON extensions, future formats) lower into this
// type-set. Outputs (zod, TS types, JSON Schema) read from it. New
// constructs land here first; an input that produces an IR node no
// output understands becomes a compile error, an output that asks for
// an IR variant no input emits is dead code that the compiler flags.
//
// V1 scope is deliberately narrow: structs of named fields, scalar
// or struct-ref typed. Enums, unions, lists, groups, generics,
// anyPointer — all `UnmappedConstruct` for now. See error.rs.

#[derive(Debug, Clone, PartialEq)]
pub struct Schema {
    pub enums: Vec<Enum>,
    pub structs: Vec<Struct>,
    // Top-level `const Name :Type = value;` declarations. Emitted as
    // named TS exports with `as const` literal types so call sites can
    // share the same value the capnp schema declares. Per cloister-946a59
    // (the L1 unblocker for `@notme/contract`'s capnp adoption).
    pub consts: Vec<Const>,
}

impl Schema {
    pub fn new() -> Self {
        Self {
            enums: Vec::new(),
            structs: Vec::new(),
            consts: Vec::new(),
        }
    }

    pub fn find_struct(&self, name: &str) -> Option<&Struct> {
        self.structs.iter().find(|s| s.name == name)
    }

    pub fn find_enum(&self, name: &str) -> Option<&Enum> {
        self.enums.iter().find(|e| e.name == name)
    }

    pub fn find_const(&self, name: &str) -> Option<&Const> {
        self.consts.iter().find(|c| c.name == name)
    }
}

impl Default for Schema {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Enum {
    pub name: String,
    // Position-stable: enumerants[i] has capnp ordinal i. Wire-format
    // safety is the user's job (ADR-0004's monotonic-ordinal rule);
    // schema-bridge just preserves what capnp gave it.
    pub variants: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Struct {
    pub name: String,
    // Always-present fields. Capnp lets a struct carry both base
    // fields and a union; both forms (`struct Foo { x @0 :Text;
    // kind :union { … } }`) map naturally.
    pub fields: Vec<StructField>,
    pub union: Option<Union>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Union {
    // `Some(name)` for the named-union-group form (`kind :union { … }`,
    // which capnp sugars to `kind :group { union { … } }`); the group's
    // name surfaces as the discriminant key so the JSON encoding nests
    // the variant under it (`"kind": {"durableObject": {…}}`).
    //
    // `None` for the anonymous-inline form (`struct Foo { union { … } }`);
    // variants encode flat — as siblings of the parent struct's base
    // fields, with the variant name as the key (`{"ghaOidc": {…}}`).
    // Per cloister-77172d.
    pub discriminant_name: Option<String>,
    pub variants: Vec<UnionVariant>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnionVariant {
    pub name: String,
    // Capnp permits `someVariant @N :Void` for tag-only variants
    // (no payload). Those represent here as `Scalar(Void)` and the
    // zod emitter knows not to include a sibling property for them.
    pub ty: FieldType,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StructField {
    pub name: String,
    pub ordinal: u16,
    pub ty: FieldType,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FieldType {
    Scalar(ScalarType),
    StructRef(String),
    EnumRef(String),
    // `List(List(Text))` is legal capnp; the box keeps the recursion
    // representable without making FieldType itself recursive at the
    // type level.
    List(Box<FieldType>),
}

// Top-level `const Name :Type = value;` declaration. The capnp parser
// surfaces these alongside structs/enums; the zod emitter writes them
// as `export const Name = <literal> as const;` so consumers get
// compile-time literal narrowing rather than `string` / `number`.
#[derive(Debug, Clone, PartialEq)]
pub struct Const {
    pub name: String,
    pub ty: FieldType,
    pub value: ConstValue,
}

// Decoded const literal. Mirrors capnp's `value` schema variants we
// support. Int/UInt/Float collapse the bit-width tiers because TS has
// one numeric type — the schema declaration (`ty`) carries the
// signedness/range, not the value variant. Struct values carry the
// field names in declaration order so emit can produce stable output
// without re-consulting the struct schema. List values nest naturally.
#[derive(Debug, Clone, PartialEq)]
pub enum ConstValue {
    Void,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Text(String),
    // Enum constants resolve to the variant name; the index is lost,
    // matching how the zod-emitted type uses string literals.
    Enum(String),
    List(Vec<ConstValue>),
    // Pairs preserve declaration order. Missing-from-the-value fields
    // are omitted entirely (they'll fall back to the field's default
    // in the consumer if it parses through a zod object schema).
    Struct(Vec<(String, ConstValue)>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarType {
    Void,
    Bool,
    Int8,
    Int16,
    Int32,
    Int64,
    UInt8,
    UInt16,
    UInt32,
    UInt64,
    Float32,
    Float64,
    Text,
    Data,
}
