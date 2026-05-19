# test/fixtures/manifest/vault-proxy-bad-url.capnp — UNHAPPY path.
#
# `upstreamBaseUrl` is not a parseable URL. The validation in
# `buildServiceRegistry` MUST reject this at build time.

@0xa1c0157e1a1f8003;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "vault-proxy-e2e-bad-url", version = "0.0.0"),
  actor = (
    fingerprint = "", algorithm = "ed25519", pubkeyBinding = "",
    attestationRepo = "", tunnelEndpoint = "",
  ),
  policy = (
    maxCertLifetimeSeconds = 300, requireInterlock = true, minAlgorithm = "ed25519",
  ),

  vaultProxyServices = [
    (
      name = "broken",
      upstreamBaseUrl = "definitely-not-a-url",
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
