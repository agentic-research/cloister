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
    Go,
}

impl OutputFormat {
    // Per-format binary name prefix. argv[0] basenames look like
    // `capnpc-schema-bridge-<format>`; `from_binary_name` strips this
    // prefix before delegating to `parse`. Cargo `[[bin]]` entries
    // declare one binary per format under this prefix.
    pub const BIN_PREFIX: &'static str = "capnpc-schema-bridge-";

    // List of known format names, for both `parse` matching and the
    // error message body. Single source of truth so adding a variant
    // doesn't drift the parser away from the error hint.
    const KNOWN: &'static [(&'static str, OutputFormat)] = &[
        ("zod", OutputFormat::Zod),
        ("go", OutputFormat::Go),
    ];

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

    // Resolve format from the plugin binary's argv[0] basename, e.g.
    // `capnpc-schema-bridge-zod` → `Zod`. Errors loudly if the basename
    // doesn't carry the `capnpc-schema-bridge-` prefix or names an
    // unknown format. Used by main.rs so the OS process is the
    // authoritative source of format selection (mirrors how
    // `capnpc-rust` / `capnpc-go` / `capnpc-c++` self-identify).
    pub fn from_binary_name(basename: &str) -> Result<Self> {
        let suffix = basename.strip_prefix(Self::BIN_PREFIX).ok_or_else(|| {
            SchemaBridgeError::UnknownOutputFormat {
                name: basename.to_owned(),
                known: format!(
                    "binary name must start with `{}` (got `{basename}`); known suffixes: {}",
                    Self::BIN_PREFIX,
                    Self::KNOWN
                        .iter()
                        .map(|(n, _)| *n)
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            }
        })?;
        Self::parse(suffix)
    }

    // Filename suffix written after the schema basename, e.g.
    // `cluster.capnp` + Zod → `cluster.zod.ts`. Excludes the leading
    // dot so `derive_out_name` can compose it.
    pub fn file_suffix(self) -> &'static str {
        match self {
            Self::Zod => "zod.ts",
            Self::Go => "go",
        }
    }
}

// IR → emitted source, dispatching on the selected output format.
// One arm per variant — the match is exhaustive so a new variant
// without an emit wiring is a compile error, not a runtime fall-
// through.
//
// `schema_basename` is the schema file's basename without the
// `.capnp` extension (e.g. `cluster` from `manifest/cluster.capnp`).
// Some emitters need it (Go uses it as the package name); others
// ignore it (Zod). main.rs derives this from the
// CodeGeneratorRequest's first requested file.
pub fn emit(schema: &Schema, format: OutputFormat, schema_basename: &str) -> Result<String> {
    match format {
        OutputFormat::Zod => {
            // Zod doesn't need the schema basename — TS imports resolve
            // by path, not by package name.
            let _ = schema_basename;
            outputs::zod::emit(schema)
        }
        OutputFormat::Go => outputs::go::emit(schema, schema_basename),
    }
}
