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
}

impl Schema {
    pub fn new() -> Self {
        Self {
            enums: Vec::new(),
            structs: Vec::new(),
        }
    }

    pub fn find_struct(&self, name: &str) -> Option<&Struct> {
        self.structs.iter().find(|s| s.name == name)
    }

    pub fn find_enum(&self, name: &str) -> Option<&Enum> {
        self.enums.iter().find(|e| e.name == name)
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
    pub fields: Vec<StructField>,
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
