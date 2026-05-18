# test/fixtures/manifest/vault-proxy-good.capnp — happy-path e2e fixture
# for `vaultProxyServices` (cloister-8f57f0 / ADR-0024).
#
# All 5 injection variants exercised. `scripts/build-manifest.mjs` should
# parse this cleanly + the runtime `buildServiceRegistry` should accept
# every entry. Consumed by `scripts/test/e2e-manifest-pipeline.test.mjs`
# (cloister-8e40ad — Taskfile-as-source-of-truth audit).

@0xa1c0157e1a1f8001;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "vault-proxy-e2e-good", version = "0.0.0"),

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

  vaultProxyServices = [
    (
      name = "openai",
      upstreamBaseUrl = "https://api.openai.test",
      defaultAllowedSubs = ["sha256:bundle-a:*"],
      rateLimitPerMinute = 60,
      injection = (authorizationBearer = void),
    ),
    (
      name = "internal-basic",
      upstreamBaseUrl = "https://internal.test",
      defaultAllowedSubs = ["sha256:bundle-b:*"],
      rateLimitPerMinute = 120,
      injection = (authorizationBasic = void),
    ),
    (
      name = "anthropic",
      upstreamBaseUrl = "https://api.anthropic.test",
      defaultAllowedSubs = ["sha256:bundle-c:*"],
      rateLimitPerMinute = 60,
      injection = (headerNamed = (name = "x-api-key")),
    ),
    (
      name = "google-search",
      upstreamBaseUrl = "https://search.googleapis.test",
      defaultAllowedSubs = ["sha256:bundle-d:*"],
      rateLimitPerMinute = 30,
      injection = (queryParam = (name = "key")),
    ),
    (
      name = "oauth-svc",
      upstreamBaseUrl = "https://oauth.test",
      defaultAllowedSubs = ["sha256:bundle-e:*"],
      rateLimitPerMinute = 30,
      injection = (bodyField = (path = "auth.client_secret")),
    ),
  ],

  routes = [
    (path = "/health",      kind = (health      = void)),
    (path = "/vault/proxy", kind = (vaultProxy  = void)),
  ],
);
