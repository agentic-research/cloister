// capnpc-schema-bridge — capnp compiler plugin.
//
// Invoked by `capnp compile -oschema-bridge:<dir> <schema.capnp>`.
// The output format is selected via the `SCHEMA_BRIDGE_FORMAT` env
// var (default `zod`). capnp's `-oPLUGIN:DIR` syntax reserves the
// colon-suffix for a real directory that capnp validates + chdirs
// into, so format selection lives out-of-band — per
// cloister-7585bc / ADR-0036 Phase 1 piece A.
//
// Reads a `CodeGeneratorRequest` from stdin, lowers to IR via
// inputs::capnp, dispatches to the format's emitter, writes one file
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
use schema_bridge::{emit, inputs, OutputFormat};

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
    let (format, out_dir) = parse_plugin_arg()?;

    let mut stdin = io::stdin().lock();
    let message = serialize::read_message(&mut stdin, capnp::message::ReaderOptions::new())?;
    let request = message.get_root::<schema_capnp::code_generator_request::Reader>()?;

    // Derive the output filename from the first requested file in the
    // CodeGeneratorRequest. `capnp compile -oschema-bridge:dir
    // manifest/cluster.capnp` puts `manifest/cluster.capnp` as the
    // first requested file's name → output is `<dir>/cluster.<suffix>`
    // where the suffix is format-driven (zod → `zod.ts`).
    let out_name = derive_out_name(request, format)?;

    let schema = inputs::capnp::parse(request)?;
    let emitted = emit(&schema, format)?;

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
    format: OutputFormat,
) -> Result<String, SchemaBridgeError> {
    let suffix = format.file_suffix();
    let requested = request.get_requested_files()?;
    if requested.is_empty() {
        // Fallback for hand-driven invocations that don't set a
        // requested file (e.g. ad-hoc fixtures during debugging).
        return Ok(format!("schema.{suffix}"));
    }
    let filename = requested.get(0).get_filename()?.to_str()?;
    // basename without the `.capnp` extension
    let basename = std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("schema");
    Ok(format!("{basename}.{suffix}"))
}

// Capnp passes the plugin's `-o<plugin>:<dir>` directory as argv[1]
// (after validating it as a real directory + chdir-ing into it).
// Format selection rides on `SCHEMA_BRIDGE_FORMAT` because capnp owns
// the `:<dir>` slot — there's no spare argv slot for an in-band
// selector. Default: Zod, so pre-multiplexer callers (Taskfile.yml
// `cluster:zod`) keep working untouched. Bogus values fail loud
// (UnknownOutputFormat) per the crate's "every gap is loud" invariant.
// Fall back to CWD when no arg is given (manual debugging).
const FORMAT_ENV: &str = "SCHEMA_BRIDGE_FORMAT";

fn parse_plugin_arg() -> Result<(OutputFormat, PathBuf), SchemaBridgeError> {
    let format = match std::env::var(FORMAT_ENV) {
        Ok(name) => OutputFormat::parse(&name)?,
        Err(_) => OutputFormat::Zod,
    };
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    Ok((format, dir))
}
