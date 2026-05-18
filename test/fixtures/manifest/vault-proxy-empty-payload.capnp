# test/fixtures/manifest/vault-proxy-empty-payload.capnp — UNHAPPY path.
#
# `headerNamed.name = ""` — empty payload string. Validation MUST reject
# this at build time (the credential would be injected into an empty
# header name otherwise).

@0xa1c0157e1a1f8004;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "vault-proxy-e2e-empty-payload", version = "0.0.0"),
  actor = (
    fingerprint = "", algorithm = "ed25519", pubkeyBinding = "",
    attestationRepo = "", tunnelEndpoint = "",
  ),
  policy = (
    maxCertLifetimeSeconds = 300, requireInterlock = true, minAlgorithm = "ed25519",
  ),

  vaultProxyServices = [
    (
      name = "broken-named",
      upstreamBaseUrl = "https://x.test",
      defaultAllowedSubs = [],
      rateLimitPerMinute = 60,
      injection = (headerNamed = (name = "")),
    ),
  ],

  routes = [
    (path = "/health",      kind = (health      = void)),
    (path = "/vault/proxy", kind = (vaultProxy  = void)),
  ],
);
