// Public library surface for schema-bridge.
//
// The binary at src/main.rs is a thin shim over this library. Tests
// drive the library directly with hand-built inputs so that golden +
// fail-case coverage doesn't depend on having the `capnp` CLI
// installed.

pub mod error;
pub mod inputs;
pub mod ir;
pub mod outputs;

pub use error::SchemaBridgeError;
pub use ir::{
    Const, ConstValue, Enum, FieldType, ScalarType, Schema, Struct, StructField, Union,
    UnionVariant,
};

use error::Result;

// Output language selector for the plugin's `<format>:<dir>` argv
// shape. Today only `Zod`; bead cloister-75f6d5 adds `Go`. New
// variants land here + an arm in [`emit`] + a suffix in
// [`OutputFormat::file_suffix`] — fail-fast keeps the seam honest.
// Per cloister-7585bc / ADR-0036 Phase 1 piece A.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Zod,
}

impl OutputFormat {
    // List of known format names, for both `parse` matching and the
    // error message body. Single source of truth so adding a variant
    // doesn't drift the parser away from the error hint.
    const KNOWN: &'static [(&'static str, OutputFormat)] = &[("zod", OutputFormat::Zod)];

    pub fn parse(s: &str) -> Result<Self> {
        for (name, fmt) in Self::KNOWN {
            if s == *name {
                return Ok(*fmt);
            }
        }
        Err(SchemaBridgeError::UnknownOutputFormat {
            name: s.to_owned(),
            known: Self::KNOWN
                .iter()
                .map(|(n, _)| *n)
                .collect::<Vec<_>>()
                .join(", "),
        })
    }

    // Filename suffix written after the schema basename, e.g.
    // `cluster.capnp` + Zod → `cluster.zod.ts`. Excludes the leading
    // dot so `derive_out_name` can compose it.
    pub fn file_suffix(self) -> &'static str {
        match self {
            Self::Zod => "zod.ts",
        }
    }
}

// IR → emitted source, dispatching on the selected output format.
// One arm per variant — the match is exhaustive so a new variant
// without an emit wiring is a compile error, not a runtime fall-
// through.
pub fn emit(schema: &Schema, format: OutputFormat) -> Result<String> {
    match format {
        OutputFormat::Zod => outputs::zod::emit(schema),
    }
}
