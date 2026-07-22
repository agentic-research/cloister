# Config sources & resolution order

cloister reads configuration from several sources depending on how it's run.
Historically their precedence was implicit, and one overlap silently turned the
lease gate off (cloister-d2db6d). This doc is the source of truth for **which
source wins**, and which one should *own* each binding.

Related: ADR-0053 (lease-gate authority resolution), ADR-0042 (dev-mode seams),
ADR-0010 (vault slices as the eventual binding substrate). Enforcement:
`task config:check` (`scripts/config-source-check.mjs`), part of `task lint`.

## The sources

| Source | Committed? | Read by | Holds |
|---|---|---|---|
| `wrangler.toml [vars]` | yes | Cloudflare (prod) **and** `wrangler dev` | the prod var surface; `= ""` defaults for secrets |
| `config.capnp` bindings | yes | `workerd serve` (`task serve:local`) | the workerd-local launch surface (URLs, `VAULT_KEK_SOURCE`) |
| `.env.local` | no (gitignored) | `task dev` sources it into the **process env** | dev `VAULT_KEK_SOURCE` + `DEV_VAULT_KEK`, optional `INTERLACE_ROOT_PUBKEY` |
| `.dev.vars` | no (gitignored) | `wrangler dev` auto-reads it | ADR-0042 dev-mode seams (`CLOISTER_MODE=dev`, `DEV_CA_MASTER`, `DEV_VAULT_SEED`, …) |
| prod secrets | no | `wrangler secret put` / CF dashboard | real prod values for the `= ""` keys |

## Resolution order — the load-bearing rule

The two runtimes resolve differently. This is the part that bit us:

### `wrangler dev` (`task dev`, `task harness:dev`)

```
.dev.vars  >  wrangler.toml [vars]
```

**`wrangler dev` does NOT bind the ambient process env.** So when `.dev.vars`
exists, a value that `task dev` sourced from `.env.local` into the process env
is **invisible to the Worker** unless `.dev.vars` (or a non-empty
`wrangler.toml [vars]`) also declares it. That is exactly how an
`INTERLACE_ROOT_PUBKEY` in `.env.local` got dropped to `wrangler.toml`'s `= ""`
default — silently disabling the gate (cloister-d2db6d).

`task config:check` models this and **fails the `task dev` preflight** on:

- **SHADOWED** — `.env.local` sets a non-empty value, a non-dev `.dev.vars`
  exists but doesn't declare the key, and `wrangler.toml [vars]` has no
  non-empty value. The `.env.local` value would be silently lost.
- **CONFLICT** — the same key is set to **different** values in `.env.local` and
  `.dev.vars`. `.dev.vars` wins; ownership is ambiguous.

Under `CLOISTER_MODE=dev` (the ADR-0042 harness flow) SHADOWED is **suppressed**
for the prod surface — dev seams (`DEV_CA_MASTER`, `DEV_VAULT_SEED`)
intentionally supersede `INTERLACE_ROOT_PUBKEY` / `VAULT_KEK_SOURCE`. CONFLICT is
still flagged regardless of mode.

### `workerd serve` (`task serve:local`)

Reads `config.capnp` directly; `.dev.vars` is not involved. Secrets are injected
at launch (e.g. `cluster-dev.mjs` passes `--var INTERLACE_ROOT_PUBKEY:…`).

### Cloudflare (prod)

Reads `wrangler.toml [vars]`, with real secret values supplied out-of-band via
`wrangler secret put`. `.env.local` / `.dev.vars` never exist in prod.

## Ownership: one source of truth per binding (cloister-21f273)

The requirement is that **each binding has one owner** — no silent
config-vs-env override dups. Until ADR-0010 vault slices become the single
binding substrate, the interim rule is:

- **A key belongs to exactly one dev file.** If it's in `.dev.vars`, it's not
  also in `.env.local` (and vice-versa). `task config:check` enforces this for
  the `wrangler dev` path.
- **The `= ""` defaults in `wrangler.toml [vars]` are prod placeholders**, filled
  by `wrangler secret put`. An empty value never means "off" on a gated path —
  ADR-0053 makes the lease gate fail **closed** unless `CLOISTER_MODE=dev` is
  explicit (cloister-21e42e).

The end state (ADR-0010) moves secrets/config into vault slices so there is a
single authoritative place, retiring the multi-file overlap entirely. That
migration is tracked separately; this doc + `config:check` are the guardrail
until then.
