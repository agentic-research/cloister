@0xb8e3f1a2c4d5e6f7;
using Go = import "/go.capnp";
$Go.package("identity");
$Go.import("github.com/agentic-research/notme/gen/go/identity");

# identity.capnp — Cross-language type definitions for the signet identity stack.
#
# ── VENDORED COPY ─────────────────────────────────────────────────────────
# Canonical source: ~/remotes/art/notme/schema/identity.capnp (notme repo).
# Vendored here by cloister-77172d (ADR-0036 Phase 1 piece E) as the second
# schema-bridge proving-ground beyond cluster.capnp. The notme repo remains
# authoritative; this copy is for the schema-bridge drift gate
# (task identity:zod:check-drift / identity:go:check-drift). When notme
# updates identity.capnp, sync the copy here and regenerate.
# ──────────────────────────────────────────────────────────────────────────
#
# Every type here is code-generated for TypeScript (types + Zod), Go, and Rust.
# This is the SINGLE source of truth for TYPE DEFINITIONS — do not manually
# define these types in any language; import the generated code instead.
#
# Wire formats are NOT defined here. This file is type sync only.
# See signet ADR-002 §2.3 + notme ADR-010 for the wire-format split:
#
#   - Transport / storage / HTTP API: JSON
#   - Cryptographic canonical bytes (Ed25519 sign/verify input): canonical
#     CBOR per RFC 8949 §4.2, integer-keyed map matching
#     signet/pkg/revocation/checker.go:168-188.
#
# Capnp is the schema language for cross-language type sync; the wire format
# of any given message is governed by the protocol implementation
# (signet for revocation/policy bundles, RFC 5652 DER for CMS, etc.).

# ── Revocation ──

struct CABundle {
  epoch     @0 :UInt64;    # Incremented on CA key rotation — mass-revokes old certs
  seqno     @1 :UInt64;    # Monotonic — rollback detection (must always increase)
  keys      @2 :List(KeyEntry);  # Active CA public keys
  keyId     @3 :Text;      # Current signing key identifier
  prevKeyId @4 :Text;      # Previous key (graceful rotation window)
  issuedAt  @5 :Int64;     # Unix timestamp (seconds) — staleness check
  signature @6 :Data;      # Ed25519 signature over canonical bundle (excludes this field)
}

struct KeyEntry {
  kid       @0 :Text;
  publicKey @1 :Data;      # Raw Ed25519 public key (32 bytes)
}

struct TokenClaims {
  keyId @0 :Text;
  epoch @1 :UInt64;
}

enum RevocationReason {
  epochMismatch  @0;
  unknownKey     @1;
  rollbackAttack @2;
  bundleInvalid  @3;
  bundleStale    @4;
}

struct RevocationResult {
  revoked @0 :Bool;
  reason  @1 :RevocationReason;
}

# ── Certificates (008) ──

# Legacy single cert result — kept for backward compat with DispatchPredicate
struct BridgeCertResult {
  certificate @0 :Text;    # PEM-encoded X.509 bridge cert
  privateKey  @1 :Text;    # DEPRECATED — always empty in 008+. Kept for wire compat.
  expiresAt   @2 :Int64;   # Unix timestamp (seconds)
  subject     @3 :Text;    # CN from cert (principal UUID or OIDC sub)
  scope       @4 :CertScope;
}

# 008: Dual cert pair — P-256 (mTLS) + Ed25519 (signing)
struct BridgeCertPair {
  mtlsCert     @0 :Text;   # PEM — P-256 cert for mTLS transport auth
  signingCert  @1 :Text;   # PEM — Ed25519 cert for git commits + APAS attestations
  identity     @2 :Text;   # WIMSE identity URI (wimse://notme.bot/{context}/{id})
  scopes       @3 :List(Text);  # Granted capabilities (string-based, not enum — extensible)
  expiresAt    @4 :Int64;  # Unix timestamp (seconds)
  subject      @5 :Text;   # Principal UUID or OIDC sub
  binding      @6 :Text;   # SHA-256(P-256 SPKI || Ed25519 SPKI) hex — proves both certs from same exchange
  epoch        @7 :UInt64; # CA epoch at issuance
  authMethod   @8 :Text;   # How the caller authenticated (gha-oidc, passkey, bootstrap)
}

enum CertScope {
  bridgeCert       @0;     # sign commits, auth to MCP, standard agent operations
  authorityManage  @1;     # rotate epoch, register credentials, manage authority
  certMint         @2;     # mint certs for others (delegated authority)
}

struct AuthorityState {
  epoch @0 :UInt64;
  keyId @1 :Text;
}

# ── Authentication ──

# 008: PoP cert exchange request — caller proves possession of both keys
struct CertPairRequest {
  proof      @0 :Proof;                # How the caller authenticated
  publicKeys @1 :CertPairPublicKeys;   # P-256 + Ed25519 SPKI PEMs
  proofs     @2 :CertPairPoP;          # Signatures over binding payload
}

struct CertPairPublicKeys {
  mtls    @0 :Text;   # P-256 SPKI PEM
  signing @1 :Text;   # Ed25519 SPKI PEM
}

struct CertPairPoP {
  mtls    @0 :Data;   # ES256 signature over binding payload
  signing @1 :Data;   # EdDSA signature over binding payload
}

# Legacy request format
struct CertRequest {
  scopes @0 :List(CertScope);
  proof  @1 :Proof;
}

struct Proof {
  union {
    ghaOidc       @0 :GHAClaims;
    passkey        @1 :Data;    # credential ID
    bootstrapCode  @2 :Text;
  }
}

struct GHAClaims {
  iss              @0  :Text;
  sub              @1  :Text;   # "repo:{owner}/{repo}:ref:refs/heads/{branch}"
  aud              @2  :Text;   # Requested audience (e.g. "notme.bot")
  exp              @3  :Int64;
  iat              @4  :Int64;
  jti              @5  :Text;   # JWT ID — used for replay protection
  repository       @6  :Text;   # "owner/repo"
  repositoryOwner  @7  :Text;
  ref              @8  :Text;   # "refs/heads/main"
  sha              @9  :Text;
  actor            @10 :Text;
  workflow         @11 :Text;
  jobWorkflowRef   @12 :Text;
  runId            @13 :Text;
  eventName        @14 :Text;
  environment      @15 :Text;
}

# ── APAS Attestation ──

struct DispatchPredicate {
  beadRef      @0 :BeadRef;
  agent        @1 :AgentIdentity;
  pipeline     @2 :PipelineContext;
  signingCert  @3 :BridgeCertResult;   # the cert that signed this attestation (legacy format)
  certPair     @4 :BridgeCertPair;     # 008: full cert pair with WIMSE identity
}

struct BeadRef {
  repo         @0 :Text;
  beadId       @1 :Text;
  contentHash  @2 :Text;   # sha256:{hex}
}

struct AgentIdentity {
  name         @0 :Text;
  provider     @1 :Text;   # anthropic, openai, etc.
  model        @2 :Text;
  definition   @3 :Text;   # sha256 hash of agent definition file
}

struct PipelineContext {
  phases       @0 :List(Text);
  currentPhase @1 :UInt32;
  pipelineId   @2 :Text;   # UUID
}

struct HandoffPredicate {
  fromPhase         @0 :Text;
  toPhase           @1 :Text;
  summary           @2 :Text;
  filesChanged      @3 :List(Text);
  commitShas        @4 :List(Text);
  previousChainHash @5 :Text;
  chainHash         @6 :Text;
  signingCert       @7 :BridgeCertResult;
  certPair          @8 :BridgeCertPair;  # 008: full cert pair
}

# ── Signing Oracle (ssh-agent pattern) ──
#
# Protocol between agent and key holder. The agent does its own TLS handshake
# but delegates the private key operation (CertificateVerify signature) to the
# oracle. The key never enters the agent's process.
#
# Transport: UDS, service binding, or HTTP — the protocol is the same.
# Wrapper: Go crypto.Signer, Rust rustls::sign::SigningKey, etc.

struct SignRequest {
  digest    @0 :Data;    # The bytes to sign (typically a TLS CertificateVerify hash)
  algorithm @1 :Text;    # "Ed25519" or "ECDSA-P256"
  purpose   @2 :Text;    # "tls-client-auth", "git-commit", "dsse-attestation" — for audit
}

struct SignResponse {
  signature @0 :Data;    # Raw signature bytes
  identity  @1 :Text;    # wimse:// URI of the signer (for audit correlation)
}

struct OraclePublicKey {
  key       @0 :Data;    # Raw public key bytes (32B Ed25519 or 65B P-256 uncompressed)
  algorithm @1 :Text;    # "Ed25519" or "ECDSA-P256"
  certPem   @2 :Text;    # Bridge cert PEM (public data — the cert that binds this key to an identity)
  identity  @3 :Text;    # wimse:// URI
  expiresAt @4 :Int64;   # Cert expiry (unix seconds)
}

# Oracle capabilities — what signing operations are available
struct OracleInfo {
  keys      @0 :List(OraclePublicKey);  # Available signing keys (typically 2: P-256 + Ed25519)
  scopes    @1 :List(Text);             # Granted capabilities
  epoch     @2 :UInt64;                 # CA epoch
}
