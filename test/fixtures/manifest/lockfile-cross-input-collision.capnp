# test/fixtures/manifest/lockfile-cross-input-collision.capnp
#
# cloister-2d987e — reproduces the cross-input backend-name collision:
# two DIFFERENT [inputs.*] (llo, mache) each declare a
# _meta.art.cloister/v1 group named "lsp". meta-groups.md only promises
# name-uniqueness WITHIN one server.json's groups[], not across inputs.
# Before cloister-2d987e's fix, overlayLockfileBackends's shellsByName
# index was keyed by name only, so the second input's "lsp" row silently
# clobbered the first's (misreported as a "hand-shell collision" even
# though neither row is a hand-shell).
#
# The shell here carries no hand-written backends — same shape as
# lockfile-mcp-shell.capnp — so the only backends that end up in the
# emitted manifest come from the paired lockfile fixture.
#
# Companion fixture: lockfile-cross-input-collision.lock.toml in the same dir.

@0xa1c0157e1a1f9002;
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
    ( path = "/mcp",
      kind = (mcp = (
        backends = [],
      )),
    ),
  ],
);
