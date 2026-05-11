# cloister-schema (Go)

Go bindings for cloister's public Cap'n Proto wire schema. This module
ships the generated `*.capnp.go` files so downstream Go consumers
(mache first, others later) can `import` the bindings instead of
forking `wire/cloister.capnp` and hand-rolling their own codegen.

Module path:

```
github.com/agentic-research/cloister/clients/go/cloister-schema
```

## Sub-packages

One per schema. The schema file itself lives at `wire/cloister.capnp`
at the repo root — that's the single source of truth, regenerated for
the Go side via `regen.sh` and consumed on the TypeScript side by a
hand-rolled encoder/decoder (`src/wire/codec.ts`).

| Package | Schema source | Notes |
|---------|---------------|-------|
| `wire` | `wire/cloister.capnp` | `Manifest`, `ToolCall`, `ToolResult`, `Content`, `BinaryContent` — the cloister ↔ companion wire frames per ADR-0005. |

Import the sub-package directly:

```go
import (
    capnp "capnproto.org/go/capnp/v3"

    "github.com/agentic-research/cloister/clients/go/cloister-schema/wire"
)

// Decode a ToolCall from raw bytes.
func decodeToolCall(buf []byte) (wire.ToolCall, error) {
    msg, err := capnp.Unmarshal(buf)
    if err != nil {
        return wire.ToolCall{}, err
    }
    return wire.ReadRootToolCall(msg)
}

// Encode a ToolResult to raw bytes.
func encodeToolResult() ([]byte, error) {
    msg, seg, err := capnp.NewMessage(capnp.SingleSegment(nil))
    if err != nil {
        return nil, err
    }
    result, err := wire.NewRootToolResult(seg)
    if err != nil {
        return nil, err
    }
    result.SetIsError(false)
    contents, err := result.NewContent(1)
    if err != nil {
        return nil, err
    }
    if err := contents.At(0).Body().SetText("hello"); err != nil {
        return nil, err
    }
    return msg.Marshal()
}
```

## Installing

```sh
go get github.com/agentic-research/cloister/clients/go/cloister-schema@v0.1.0
```

End consumers don't need any capnp toolchain — the generated
`*.capnp.go` is checked in.

## Schema-evolution contract

Every change to `wire/cloister.capnp` is governed by ADR-0004 (manifest
schema evolution) and ADR-0005 (wire contract). Highlights:

- Ordinals are stable. Append-only at the next ordinal; never rename or
  remove a field. Renumbering a `@N` tag — including reassigning a
  retired ordinal — is a wire break.
- New fields, enumerants, and union variants are safe at higher
  ordinals. Symbolic renames are safe (names live in codegen only).
- The schema is stable inside a minor version; breaking changes bump
  the major and ship as `v0.2.0`, `v0.3.0`, etc.

The Go side's `capnp` / `capnpc-go` toolchain is pinned in `go.mod`
(currently `capnproto.org/go/capnp/v3 v3.1.0-alpha.2`). Bumping it
requires re-running `regen.sh` and committing the diff.

## Regenerating

Whenever `wire/cloister.capnp` changes:

```sh
clients/go/cloister-schema/regen.sh
```

That script:

1. Verifies `capnp` and `capnpc-go` are on `$PATH` (clear error if not).
2. Re-runs `capnp compile -ogo` against `wire/cloister.capnp`.
3. Runs `GOWORK=off go build ./...` to catch import drift.

CI (`.github/workflows/cloister-schema-go.yml`) gates this:

1. Reruns `regen.sh`.
2. `git diff --exit-code clients/go/cloister-schema/` — fails if the
   committed Go file doesn't match what regen would produce. So
   *generated files are tracked*; do not gitignore them.
3. `go test ./...`.

## Toolchain

Required for regen (not for consumers):

- `go` ≥ 1.21
- `capnp` ≥ 1.3.0 (`brew install capnp` on macOS; `apt-get install
  capnproto` on Debian/Ubuntu)
- `capnpc-go` from `capnproto.org/go/capnp/v3@v3.1.0-alpha.2`:

  ```sh
  go install capnproto.org/go/capnp/v3/capnpc-go@v3.1.0-alpha.2
  ```

  `capnp compile -ogo` shells out to `capnpc-go`; make sure
  `$(go env GOPATH)/bin` is on `$PATH`.

## Why a separate module

Multi-module monorepo pattern (kubernetes/api, stripe-go, and ley-line-open's
`clients/go/leyline-schema`). One versionable contract, one tag per
release (`clients/go/cloister-schema/vX.Y.Z`), no `replace` directives
required for downstream consumers. The cloister TypeScript bundle has
no Go dependency; this Go module has no TypeScript dependency beyond
reading the canonical `.capnp` file at regen time.

## Pointers

- Upstream schema: [`wire/cloister.capnp`](../../../wire/cloister.capnp)
- Wire contract: [ADR-0005](../../../docs/adr/0005-internal-wire-leyline-net.md)
- Schema evolution: [ADR-0004](../../../docs/adr/0004-capnp-manifest.md)
- TypeScript counterpart (hand-rolled encoder/decoder): `src/wire/codec.ts`
