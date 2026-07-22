// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Structured operational logging for the trust/IO surface (cloister-bd7e51).
//
// ONE shape for every operational log: `{target, op, outcome, ...fields}` as a
// single JSON line. `target` = which component (ca_bundle, notme_fetcher,
// trust_store, vault); `op` = the operation in flight; `outcome` = its result,
// stable across emits so it stays greppable. This is the trust-store alarm
// convention, promoted to the whole trust surface so an operational-log audit
// (threat model §13.2 "silence is evidence") can query ONE schema instead of
// re-parsing prose strings — the cloister-3ad090 class, where an ad-hoc
// `console.warn("...")` buried WHY behind an unstructured message and cost a P2
// debugging session. `lint:log-shape` enforces that no new ad-hoc string log
// lands on the trust surface; this helper is the sanctioned way to emit one.
//
// Secret-material fields are redacted before emit (defense in depth): even
// though callers pass only public data today, a field later named `token` /
// `kek` / `secret` can never leak through this path. Public crypto material
// (pubkey, signature, fingerprint, certDer, kid, epoch) is NOT secret and is
// logged as-is — redaction is a curated denylist, never a guess.
//
// SCOPE — this is NOT the other structured-output domains, which keep their own
// schemas intentionally:
//   • Receipts / metrics — the `{kind:"receipt"|"metric"}` ReceiptEmitter /
//     MetricEmitter interface (a consumer contract).
//   • The §13.4 denial-audit plane — `buildDenialAuditEntry` from the vault
//     package (an attestable audit row).
//   • The `cloister/credential-isolation/v1` error schema (§13.7.6, versioned).
// Those are not operational logs and do not route through here.

/** Console sink to route to. `warn` = degraded, `error` = failure, `info` = normal. */
export type LogLevel = "info" | "warn" | "error";

/**
 * A structured operational-log event. `target`/`op`/`outcome` are the required
 * spine; any additional fields carry structured context and are redacted for
 * secret-material key names before emit.
 */
export interface LogEvent {
  /** Which component emitted this — a snake_case noun (e.g. `ca_bundle`). */
  readonly target: string;
  /** The operation in flight — a snake_case verb phrase (e.g. `fetch`). */
  readonly op: string;
  /** The result — snake_case, kept stable across emits so it stays greppable. */
  readonly outcome: string;
  /** Extra structured context. Secret-material field names are redacted. */
  readonly [field: string]: unknown;
}

// Field-NAME markers that carry secret material. Matched case-insensitively as
// a substring, so `masterKek`, `authToken`, `apiSecret`, `privateKey` all
// redact. Public crypto material (pubkey, signature, fingerprint, kid, cert*,
// epoch) is intentionally ABSENT — logging it is fine and often necessary for
// triage.
const SECRET_FIELD_MARKERS = [
  "secret",
  "token",
  "kek",
  "password",
  "passphrase",
  "credential",
  "privatekey",
  "private_key",
  "authorization",
  "cookie",
] as const;

/** The value a redacted field is replaced with. */
export const REDACTED = "[redacted]";

function isSecretFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_FIELD_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Replace the values of secret-material fields with {@link REDACTED}, leaving
 * every other field untouched. Shallow — nested objects are not descended into,
 * because operational-log fields are flat scalars by convention. Pure; exported
 * for tests.
 */
export function redactSecrets(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSecretFieldName(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Emit one structured operational-log line. `target`/`op`/`outcome` lead the
 * object (stable spine); the remaining fields are redacted for secret-material
 * names and merged after. Exactly one JSON object per line, on the level-
 * appropriate console sink.
 */
export function logEvent(level: LogLevel, event: LogEvent): void {
  const { target, op, outcome, ...rest } = event;
  const line = JSON.stringify({ target, op, outcome, ...redactSecrets(rest) });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
