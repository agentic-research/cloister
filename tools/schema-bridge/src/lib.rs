// Public library surface for schema-bridge.
//
// The binary at src/main.rs is a thin shim over this library. Tests
// drive the library directly with hand-built inputs so that golden +
// fail-case coverage doesn't depend on having the `capnp` CLI
// installed.

pub mod error;
pub mod ir;
pub mod inputs;
pub mod outputs;

pub use error::SchemaBridgeError;
pub use ir::{FieldType, ScalarType, Schema, Struct, StructField};
