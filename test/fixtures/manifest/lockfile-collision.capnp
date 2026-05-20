# test/fixtures/manifest/lockfile-collision.capnp
#
# Phase 1 of the LLO arc (cloister-05334b) — exercises the collision
# precedence rule. This shell declares a backend named "lsp" with
# hand-declared `tools = []` + `dynamicTools = false`. The companion
# lockfile-collision.lock.toml ALSO declares a generated backend named
# "lsp" (different shape: dynamicTools = true + non-empty claims).
#
# The emitter MUST resolve the collision by preferring the GENERATED
# backend (the lockfile is the source of truth for upstream-derived
# shape) and emit a stderr warning so the operator notices the drift.
#
# This is the documented Phase 1 behavior — the goal is gradual
# migration: operators delete the hand-shell once the generated
# backend works, and the warning serves as the prompt.

@0xa1c0157e1a1f9002;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "lockfile-collision-e2e", version = "0.0.0"),

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
    ( path = "/mcp",
      kind = (mcp = (
        backends = [
          # Hand-declared shell with the SAME name as a generated
          # backend in lockfile-collision.lock.toml. The emitter MUST
          # prefer the generated row + warn.
          ( name          = "lsp",
            handlesPrefix = "lsp_",
            kind = (mcpProxy = (
              urlBinding     = "HAND_BINDING",
              serviceBinding = "",
              tools          = [],
              dynamicTools   = false,
            )),
          ),
        ],
      )),
    ),
  ],
);
