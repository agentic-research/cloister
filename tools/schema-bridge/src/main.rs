// capnpc-schema-bridge — capnp compiler plugin.
//
// Invoked by `capnp compile -oschema-bridge:<out_dir> <schema.capnp>`.
// Reads a `CodeGeneratorRequest` from stdin, lowers to IR via
// inputs::capnp, emits zod TS via outputs::zod, writes one .ts file
// per requested capnp source.
//
// All real logic lives in the library at src/lib.rs so that tests can
// drive it directly without needing the `capnp` CLI installed.

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use capnp::schema_capnp;
use capnp::serialize;

use schema_bridge::error::SchemaBridgeError;
use schema_bridge::{inputs, outputs};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // Plugin errors must go to stderr — stdout is reserved for
            // the response capnp message, even though our v1 plugin
            // doesn't emit one.
            eprintln!("schema-bridge: {e}");
            // Print the chain too, since `SchemaBridgeError::Capnp(_)`
            // can wrap deeper detail.
            let mut source = std::error::Error::source(&e);
            while let Some(s) = source {
                eprintln!("  caused by: {s}");
                source = s.source();
            }
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), SchemaBridgeError> {
    let out_dir = parse_out_dir();

    let mut stdin = io::stdin().lock();
    let message = serialize::read_message(&mut stdin, capnp::message::ReaderOptions::new())?;
    let request = message.get_root::<schema_capnp::code_generator_request::Reader>()?;

    // Derive the output filename from the first requested file in the
    // CodeGeneratorRequest. `capnp compile -oschema-bridge:dir
    // manifest/cluster.capnp` puts `manifest/cluster.capnp` as the
    // first requested file's name → output is `<dir>/cluster.zod.ts`.
    let out_name = derive_out_name(request)?;

    let schema = inputs::capnp::parse(request)?;
    let emitted = outputs::zod::emit(&schema)?;

    let out_path = out_dir.join(&out_name);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::File::create(&out_path)?;
    f.write_all(emitted.as_bytes())?;

    Ok(())
}

fn derive_out_name(
    request: schema_capnp::code_generator_request::Reader<'_>,
) -> Result<String, SchemaBridgeError> {
    let requested = request.get_requested_files()?;
    if requested.is_empty() {
        // Fallback for hand-driven invocations that don't set a
        // requested file (e.g. ad-hoc fixtures during debugging).
        return Ok("schema.zod.ts".to_owned());
    }
    let filename = requested.get(0).get_filename()?.to_str()?;
    // basename without the `.capnp` extension
    let basename = std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("schema");
    Ok(format!("{basename}.zod.ts"))
}

// Capnp passes the plugin's output directory as the first argv entry
// when invoked as `-o<plugin>:<dir>`. Fall back to CWD when run
// manually for debugging.
fn parse_out_dir() -> PathBuf {
    std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
