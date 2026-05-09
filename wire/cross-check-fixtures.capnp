# cross-check-fixtures.capnp — reference encodings for the substrate-equivalence
# proof in Phase 2D-codec.D (cloister-5183bc).
#
# Usage:
#   capnp eval -I .. --no-standard-import \
#     wire/cross-check-fixtures.capnp <name> -b
#
# Compiled bytes for each const are saved as a TS Uint8Array literal in
# test/wire/fixtures/canonical.ts via scripts/gen-wire-fixtures.mjs.
# Tests in test/wire/cross-check.test.ts decode those bytes with our hand-
# rolled decoder; if values match, our reader interoperates with the
# capnp reference encoder.

@0xc1c0c0c0c0c0c1c0;
using Wire = import "/cloister/wire/cloister.capnp";

# ── Manifest fixtures ─────────────────────────────────────────────────────

const manifestCanonical :Wire.Manifest = (
  sequence    = 42,
  publicKey   = 0x"1111111111111111111111111111111111111111111111111111111111111111",
  signature   = 0x"22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222",
  contentHash = 0x"3333333333333333333333333333333333333333333333333333333333333333",
);

const manifestZeroSequence :Wire.Manifest = (
  sequence    = 0,
  publicKey   = 0x"0000000000000000000000000000000000000000000000000000000000000000",
  signature   = 0x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  contentHash = 0x"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);

# ── ToolCall fixtures ─────────────────────────────────────────────────────

const toolCallBasic :Wire.ToolCall = (
  upstreamId    = "rosary",
  toolName      = "rsry_status",
  argumentsJson = 0x"7b7d",  # "{}"
);

const toolCallEmpty :Wire.ToolCall = (
  upstreamId    = "",
  toolName      = "",
  # argumentsJson omitted intentionally. Acceptance of literal-empty Data
  # forms (`0x""`, `[]`) varies between capnp compiler versions and isn't
  # mandated by the spec (capnproto.org/language.html § Constants shows
  # only non-empty `0x"…"` examples). The portable form is to omit the
  # field; defaulted Data is the empty list, which is what we want here.
);

const toolCallWithArgs :Wire.ToolCall = (
  upstreamId    = "leyline",
  toolName      = "lsp_hover",
  # canonical JSON: {"col":5,"file":"/x/foo.rs","line":10}
  argumentsJson = 0x"7b22636f6c223a352c2266696c65223a222f782f666f6f2e7273222c226c696e65223a31307d",
);

# ── ToolResult fixtures ──────────────────────────────────────────────────

const toolResultEmpty :Wire.ToolResult = (
  content = [],
  isError = false,
);

const toolResultErrorEmpty :Wire.ToolResult = (
  content = [],
  isError = true,
);

const toolResultText :Wire.ToolResult = (
  content = [
    (body = (text = "hello world")),
  ],
  isError = false,
);

const toolResultResource :Wire.ToolResult = (
  content = [
    # raw bytes "opaque"
    (body = (resource = 0x"6f7061717565")),
  ],
  isError = false,
);

const toolResultBinary :Wire.ToolResult = (
  content = [
    (body = (binary = (
      data     = 0x"89504e47",  # PNG signature first 4 bytes
      mimeType = "image/png",
    ))),
  ],
  isError = false,
);

const toolResultMixed :Wire.ToolResult = (
  content = [
    (body = (text = "first")),
    (body = (binary = (data = 0x"010203", mimeType = "application/octet-stream"))),
    (body = (resource = 0x"6f706171756532")),
    (body = (text = "last")),
  ],
  isError = false,
);

const toolResultErrorWithText :Wire.ToolResult = (
  content = [
    (body = (text = "tool failed: missing 'file' argument")),
  ],
  isError = true,
);
