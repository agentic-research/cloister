# test/fixtures/manifest/lockfile-mcp-shell.capnp
#
# Phase 1 of the LLO arc (cloister-05334b) — the "shell" cloister.capnp
# that the build-manifest emitter augments with [[generated_backends]]
# rows from a sibling cluster.lock.toml fixture. The shell carries:
#
#   - one /mcp route with NO declared backends
#
# The emitter test seeds an adjacent lockfile fixture so that after
# `task manifest`, the emitted src/generated/manifest.ts contains the
# generated mcpProxy backend(s) injected from the lockfile.
#
# Companion fixture: lockfile-mcp-shell.lock.toml in the same dir.

@0xa1c0157e1a1f9001;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "lockfile-e2e", version = "0.0.0"),

  actor = (
    fingerprint     = "",
    algorithm       = "ed25519",
    pubkeyBinding   = "",
    attestationRepo = "",
    tunnelEndpoint  = "",
  ),

  policy = (
    maxCertLifetimeSeconds = 300,
    requireInterlock       = true,
    minAlgorithm           = "ed25519",
  ),

  routes = [
    ( path = "/health", kind = (health = void) ),
    # /mcp route with NO hand-declared backends — the emitter MUST
    # inject the generated backends from the sibling lockfile.
    ( path = "/mcp",
      kind = (mcp = (
        backends = [],
      )),
    ),
  ],
);
