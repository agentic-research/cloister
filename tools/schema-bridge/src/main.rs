// capnpc-schema-bridge-<format> — capnp compiler plugin family.
//
// One binary per output format, dispatched by argv[0] basename — same
// shape as `capnpc-rust` / `capnpc-go` / `capnpc-c++`. capnp's PATH
// search resolves `-o<plugin>` to `capnpc-<plugin>`, so invoking
// `capnp compile -oschema-bridge-zod:<dir> <schema.capnp>` picks the
// zod emitter via the binary's name. The colon-suffix is reserved by
// capnp for a real directory (validated + chdir'd) so format
// selection MUST live out of band; the binary name is the canonical
// out-of-band channel for capnp plugins. Per cloister-7585bc /
// ADR-0036 Phase 1 piece A.
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

    // Derive the schema basename + output filename from the first
    // requested file in the CodeGeneratorRequest. For
    // `manifest/cluster.capnp` the basename is `cluster`; output is
    // `<dir>/cluster.<format.file_suffix()>` (zod → `cluster.zod.ts`,
    // go → `cluster.go`). The basename also flows into format
    // emitters that need it — Go uses it as the package name.
    let basename = derive_schema_basename(request)?;
    let out_name = format!("{basename}.{}", format.file_suffix());

    let schema = inputs::capnp::parse(request)?;
    let emitted = emit(&schema, format, &basename)?;

    let out_path = out_dir.join(&out_name);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::File::create(&out_path)?;
    f.write_all(emitted.as_bytes())?;

    Ok(())
}

fn derive_schema_basename(
    request: schema_capnp::code_generator_request::Reader<'_>,
) -> Result<String, SchemaBridgeError> {
    let requested = request.get_requested_files()?;
    if requested.is_empty() {
        // Fallback for hand-driven invocations that don't set a
        // requested file (e.g. ad-hoc fixtures during debugging).
        return Ok("schema".to_owned());
    }
    let filename = requested.get(0).get_filename()?.to_str()?;
    // basename without the `.capnp` extension
    Ok(std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("schema")
        .to_owned())
}

// Capnp passes the plugin's `-o<plugin>:<dir>` directory as argv[1]
// (after validating it as a real directory + chdir-ing into it).
// Format selection comes from argv[0] basename via
// `OutputFormat::from_binary_name` — the binary's name IS the typed
// format identifier. Per-format Cargo `[[bin]]` entries declare the
// dispatch table; mismatched basenames fail loud
// (UnknownOutputFormat) per the crate's "every gap is loud"
// invariant. Fall back to CWD when no dir arg is given (manual
// debugging).
fn parse_plugin_arg() -> Result<(OutputFormat, PathBuf), SchemaBridgeError> {
    let argv0 = std::env::args().next().unwrap_or_default();
    let basename = std::path::Path::new(&argv0)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&argv0)
        .to_owned();
    let format = OutputFormat::from_binary_name(&basename)?;
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    Ok((format, dir))
}
