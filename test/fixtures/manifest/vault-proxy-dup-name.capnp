# test/fixtures/manifest/vault-proxy-dup-name.capnp — UNHAPPY path.
#
# Same `name = "openai"` declared twice. `buildServiceRegistry` MUST
# throw at build time AND at boot time (mirrored via the build-manifest
# hook landed in PR #36 fixup).

@0xa1c0157e1a1f8002;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "vault-proxy-e2e-dup", version = "0.0.0"),
  actor = (
    fingerprint = "", algorithm = "ed25519", pubkeyBinding = "",
    attestationRepo = "", tunnelEndpoint = "",
  ),
  policy = (
    maxCertLifetimeSeconds = 300, requireInterlock = true, minAlgorithm = "ed25519",
  ),

  vaultProxyServices = [
    (
      name = "openai",
      upstreamBaseUrl = "https://api.openai.test",
      defaultAllowedSubs = [],
      rateLimitPerMinute = 60,
      injection = (authorizationBearer = void),
    ),
    (
      name = "openai",
      upstreamBaseUrl = "https://other.test",
      defaultAllowedSubs = [],
      rateLimitPerMinute = 60,
      injection = (authorizationBearer = void),
    ),
  ],

  routes = [
    (path = "/health",      kind = (health      = void)),
    (path = "/vault/proxy", kind = (vaultProxy = (bundleIdName = ""))),
  ],
);
