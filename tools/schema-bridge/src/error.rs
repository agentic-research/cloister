use thiserror::Error;

#[derive(Debug, Error)]
pub enum SchemaBridgeError {
    // Fail-fast on any capnp construct we haven't taught the IR to
    // represent yet. CI surfaces this as a build break, forcing the
    // codegen to grow a mapping rather than silently emitting
    // `z.unknown()`. See README §"Self-maintenance invariant".
    #[error("unmapped capnp construct `{kind}` at {location}: {hint}")]
    UnmappedConstruct {
        kind: String,
        location: String,
        hint: String,
    },

    // A field references a struct/enum we never saw in this schema.
    // Usually means an `import` we didn't follow or a typo.
    #[error("unresolved type reference `{name}` at {location}")]
    UnresolvedReference { name: String, location: String },

    // Two input sources defined the same symbol with incompatible
    // shapes. Reserved for the aggregation path; not reachable yet.
    #[error("aggregation conflict on `{symbol}`: {detail}")]
    AggregationConflict { symbol: String, detail: String },

    #[error("capnp parse error: {0}")]
    Capnp(#[from] capnp::Error),

    // `which()` returns this when the discriminant on a capnp union is
    // outside the known variant set — i.e. the schema-bridge build was
    // linked against a different capnp std than the input. Treat as a
    // schema-shape failure rather than a missing mapping.
    #[error("capnp discriminant out of range: {0}")]
    NotInSchema(#[from] capnp::NotInSchema),

    #[error("capnp utf-8 error: {0}")]
    Utf8(#[from] std::str::Utf8Error),

    #[error("capnp schema not in expected shape: {0}")]
    SchemaShape(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    // Caller passed a plugin-arg prefix that doesn't name a known
    // output format (`<format>:<dir>`). Lists the formats we DO know
    // so a typo (`zod` vs `zods`) surfaces immediately rather than
    // silently routing to the default. Per cloister-7585bc.
    #[error("unknown output format `{name}`: known formats are {known}")]
    UnknownOutputFormat { name: String, known: String },
}

impl SchemaBridgeError {
    pub fn unmapped(kind: impl Into<String>, location: impl Into<String>) -> Self {
        let kind = kind.into();
        Self::UnmappedConstruct {
            hint: format!(
                "add a mapping for `{kind}` in schema-bridge, or open an issue"
            ),
            kind,
            location: location.into(),
        }
    }
}

pub type Result<T> = std::result::Result<T, SchemaBridgeError>;
