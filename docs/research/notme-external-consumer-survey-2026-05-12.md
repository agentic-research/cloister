# notme public-HTTP-surface external-consumer survey

**Date:** 2026-05-12
**Author:** survey agent (read-only)
**Purpose:** Close ADR-0018 prerequisite gate #5 (`docs/adr/0018-notme-co-location.md` §Status). Empirically determine whether any consumer outside cloister-router's process boundary needs notme's public surface up while cloister-router is being restarted.
**Conclusion (TL;DR):** **(b) Alternative 4 is preferred.** Multiple external consumers — concretely two GHA reusable workflows + `agentic-research/notme/action` distributed as a tagged GitHub Action, plus the `rig` (rosary-dashboard) Cloudflare Worker — depend on `auth.notme.bot/cert/gha`, `/.well-known/jwks.json`, and `/authorize` being reachable independent of cloister-router's lifecycle. Full co-location (Alternative 3) introduces fault-domain correlation that the current architecture does not have.

---

## 1. Methodology

**Tools:** ripgrep (`rg`), `find`, `grep`, `Read` on key source files. No code modified.

**Scope of search:** all repos under `~/remotes/art/*` and `~/remotes/jamestexas/*` (note: `~/github` is a symlink to `~/remotes`, so they are the same trees). Specifically:

- `cloister/`, `notme/`, `notme.bot/`, `signet/`, `rig/`, `ley-line/`, `rosary/`, `mache/`, `crumb/`, `art-hooks/`, `agents/` (`jamestexas/agents/`).
- All `.github/workflows/*.yml` files in those trees.
- `notme/action/`, `notme/proxy/`, `notme/worker/public/` (browser surface).

**Queries used (representative):**

```bash
rg -l 'auth\.notme\.bot|notme\.bot|/cert/gha' ~/remotes/art ~/remotes/jamestexas
find ~/remotes -name '*.yml' -path '*/.github/workflows/*' \
  | xargs rg -l 'agentic-research/notme|/cert/gha|auth\.notme\.bot'
rg -nE '/cert\b|/token\b|/authorize|jwks\.json|/auth/oidc|/auth/passkey|/invites|/join|/connections' \
  <key files>
```

**Key files inspected directly:**

- `~/remotes/art/notme/worker/worker.ts` — endpoint catalog (`/cert`, `/cert/gha`, `/token`, `/authorize`, `/.well-known/jwks.json`, `/auth/passkey/*`, `/auth/oidc/login`, `/invites`, `/join`, `/connections`).
- `~/remotes/art/notme/worker/wrangler.toml` — confirms `auth.notme.bot/*` and `notme.bot/*` are routed to this Worker (deployed on Cloudflare).
- `~/remotes/art/notme/action/src/index.ts` — the GitHub Action that calls `${authority_url}/cert/gha` (default `https://auth.notme.bot`).
- `~/remotes/art/signet/.github/workflows/gha-identity.yml` — reusable workflow calling the notme action.
- `~/remotes/art/signet/.github/workflows/signet-resign.yml` — production consumer of the reusable workflow.
- `~/remotes/art/rig/.github/workflows/deploy.yml` — production consumer of the signet reusable workflow.
- `~/remotes/art/rig/web/src/{routes/api.ts,services/cert.ts,index.ts,middleware/subdomain.tsx}` — rig's runtime calls to `auth.notme.bot`.
- `~/remotes/art/rig/web/wrangler.toml` — confirms rig is a separate Cloudflare Worker (`rosary-dashboard`) with both an `AUTH` service binding to `notme-bot` AND public HTTP fallbacks.

**What was NOT covered (gaps):** This survey is purely static. It cannot reveal:

- Browser users who hit `auth.notme.bot/login` outside the agentic-research org. The `_login.html` UI advertises passkey registration generically and the README points the public at `https://auth.notme.bot` as a "live authority" (`~/remotes/art/notme/README.md:204`). I have no traffic logs.
- Self-hosters or external developers who use the `notme/action` against their own forks/repos (the action is a public GHA via SHA pin; anyone can adopt it).
- Off-repo consumers (Slack bots, terraform modules, scripts in private orgs).

---

## 2. Endpoint-by-endpoint findings

`auth.notme.bot/*` and `notme.bot/*` are served today by a single Cloudflare Worker (`name = "notme-bot"`) — see `~/remotes/art/notme/worker/wrangler.toml:2,17,21`. ADR-0018 (Alternative 3 / full co-location) proposes folding this Worker into cloister-router's workerd process. The fault-domain question below is "what happens to each endpoint's consumers if cloister-router restarts."

Confidence key: **D** = definitive (caller code located), **P** = probable (referenced but indirect), **U** = unknown.

| Endpoint | Concrete external consumers (file:line) | Needs availability while cloister-router is down? | Confidence |
|---|---|---|---|
| `POST /cert/gha` | (1) `notme/action/src/index.ts:130–146` — distributed as `agentic-research/notme/action@<sha>` on the GHA marketplace. (2) `signet/.github/workflows/gha-identity.yml:91–94` — reusable workflow `uses: agentic-research/notme/action@2c540af`. (3) `signet/.github/workflows/signet-resign.yml:32–39` — production PR re-sign flow, triggered on `pull_request_review`. (4) `rig/.github/workflows/deploy.yml:26–33` — production Fly deploy flow. (5) `rig/web/src/routes/api.ts:558–570` — `rosary.bot/api/cert/gha` is a public proxy to `https://auth.notme.bot/cert/gha` (a different worker forwarding traffic). | **Yes.** All four GHA consumers run on GitHub-hosted runners, outside any cloister process. The cert pair has a 5-min TTL and is requested at job-start time. If cloister-router is restarting when (a) a PR is approved and triggers `signet-resign`, or (b) a `main` push triggers `rig/deploy`, the workflow fails closed and the developer must re-trigger. The `rig` proxy in row (5) is a separate Cloudflare Worker — but it just forwards to `auth.notme.bot`, so it inherits the downstream's availability. | **D** |
| `POST /cert` | Referenced by signet CLI comment only (`~/remotes/art/signet/cmd/signet/auth_login.go:595`: `// e.g., https://auth.notme.bot/api/cert`) — and that path (`/api/cert`) is not actually served by the notme worker (no match in `worker.ts`). The endpoint exists at `worker.ts:1591`, but no concrete external caller was located in the search corpus. The README documents it (`notme/README.md:128`). | **Unknown.** Possible CLI/manual consumers; survey found none in-tree. | **U** |
| `POST /token` | Referenced by `rig/web/src/index.ts` token verification paths, but verification uses JWKS, not `/token`. No external CLI call located. Documented in `notme/README.md:129`. | **Unknown.** Probably reachable via browser passkey flow → `/token`; no in-tree external caller. | **U** |
| `GET /authorize` | `rig/web/src/index.ts:396` — `c.redirect('https://auth.notme.bot/authorize?...')` for the admin `/admin/setup-github` flow when no DPoP identity is present. This redirect is served from the user's browser, so the user's next request to `auth.notme.bot/authorize` is independent of any cloister-router state EXCEPT that under Alternative 3 the destination *becomes* cloister-router. | **Yes (if `/admin/setup-github` is exercised during cloister-router restart).** Low frequency but real: rig is a separate Cloudflare Worker and continues serving even when cloister-router is down. A user clicking admin-setup would hit a redirect they cannot complete until cloister-router is back. Also, `rig/web/src/middleware/subdomain.tsx:44–46` redirects all `auth.rosary.bot/*` traffic to `auth.notme.bot/*` (301), meaning any rosary-side auth bookmark inherits the same correlation. | **D** |
| `POST /authorize/token` | No external caller located in search corpus. Browser-side token endpoint reached after `/authorize` redirect. | **Same as `/authorize`** — downstream of the passkey flow. | **P** |
| `POST /auth/oidc/login` | "Break-glass OIDC bootstrap." No external caller located. Documented in README as part of the auth surface. | **Unknown** — explicitly a break-glass surface; if it must work during cloister-router outage (which is plausibly *exactly when* break-glass is invoked), full co-location is wrong. | **U** (with strong "should-stay-separate-on-principle" prior) |
| `POST /auth/passkey/{register,authenticate,reset}` | Served to browsers from `~/remotes/art/notme/worker/public/_login.html:215–337`. No in-tree non-browser caller. | **Yes (for any browser-side user).** A passkey-registration mid-flight when cloister-router restarts loses the session. Same fault correlation. | **D** (the surface; **U** on real-world usage volume) |
| `POST /invites`, `GET/POST /join`, `POST /connections` | Browser-side at `~/remotes/art/notme/worker/public/_login.html:307,361` (`/join` from passkey registration flow). No external CLI located. | **Yes (browser-mediated user ops).** Same correlation as passkey. | **D** for surface |
| `GET /.well-known/jwks.json` | (1) `rig/web/src/index.ts:371,380` — `jwksUrl: 'https://auth.notme.bot/.well-known/jwks.json'` for DPoP and access-token verification on rig's `/admin/setup-github`. (2) `rig/web/src/auth/dpop.ts` (per file listing) likely has the same. (3) Any external service verifying notme-issued tokens needs JWKS reachable. | **Yes.** This is the single most load-bearing line of the survey. JWKS is the trust anchor for *every* DPoP-bound token notme has ever issued. While JWKS is cacheable (rig caches in `c.env.KV`), cache misses during cloister-router restart fail token verification. Any external auditor or third party verifying a notme JWT also needs this endpoint up. | **D** |
| `GET /internal/ca-bundle`, `POST /internal/sign-jwt` | Cluster-internal only (per ADR-0018 §Decision; consumer is cloister-router itself via `NOTME` service binding). | **No.** These are the endpoints already proposed to move in-process. Not part of this survey question. | **D** |
| `GET /.well-known/signet-authority.json`, `GET /.well-known/ca-bundle.pem` | Documented public surface (`notme/README.md:137,139`). No in-tree external caller located, but X.509 trust-bundle distribution is by-design pulled by arbitrary verifiers. | **Probable yes** — these underwrite the signet cert ecosystem; mTLS verifiers everywhere need them. | **P** |
| Browser assets at `auth.notme.bot` (`/login`, `/auth`, static HTML/CSS) | Served from `public/` directory; rendered to users hitting `auth.notme.bot/login` and friends. | **Yes (any browser user).** Same correlation. | **D** for surface |

### Notable external consumer #1: GHA workflows

`signet/.github/workflows/gha-identity.yml:91` pins `agentic-research/notme/action@2c540af` against `authority_url: https://auth.notme.bot`. This reusable workflow is itself invoked by:

- `signet/.github/workflows/signet-resign.yml:32–39` — fires on every approved PR review across signet.
- `rig/.github/workflows/deploy.yml:26–33` — fires on every push to `main` on rig.
- `notme/.github/workflows/gha-identity.yml:100` — self-test of the action (also references `auth.notme.bot`).

These workflows execute on GitHub-hosted runners and *cannot* be gated on cloister-router liveness; they run when GitHub schedules them. Co-locating notme into cloister-router means: any deploy / re-sign attempted during a cloister-router restart window fails the cert exchange, the run aborts, the developer must retry.

### Notable external consumer #2: `rig` (rosary-dashboard) Cloudflare Worker

`rig/web/wrangler.toml:9` deploys to Cloudflare zone `rosary.bot` (and subdomains). It is NOT in cloister-router's process. `rig/web/src/services/cert.ts:21,100–104` defaults to `https://auth.notme.bot/cert/mint` as an HTTP fallback when the `AUTH` service binding isn't configured. `rig/web/src/routes/api.ts:560–569` actively proxies `/cert/gha` to `auth.notme.bot/cert/gha`. `rig/web/src/index.ts:371,380,396` calls `auth.notme.bot` for JWKS lookup and `/authorize` redirect.

Today: `rig`'s `AUTH` service binding (`wrangler.toml:48–51`, `service = "notme-bot"`) lets it use private RPC to the **Cloudflare-deployed** notme worker — so when cloister-router is restarting, rig is unaffected because notme lives on CF, not on cloister-router.

Under ADR-0018 Alternative 3 (full co-location), `auth.notme.bot/*` is served by cloister-router. The `AUTH` service binding either (a) goes away entirely (rig has to call cloister-router via HTTP), or (b) is reconfigured to point at the in-cluster bundle. In either case, when cloister-router restarts:

- rig's `mintBridgeCert` RPC fails (the service binding's target is down).
- rig's HTTP fallback to `auth.notme.bot/cert/mint` also fails (same destination).
- rig's `/api/cert/gha` proxy fails.
- rig's `/admin/setup-github` redirect lands on a dead `auth.notme.bot/authorize`.
- rig's DPoP/access-token verification fails cache misses against JWKS.

Crucially, rig itself stays UP on Cloudflare (it's a separate worker). External users hitting `rosary.bot/admin/setup-github` therefore get a *partial* outage — rig responds, but the auth handoff dies. This is exactly the failure mode math-friend #2 flagged.

### Notable external consumer #3: Browser users of `auth.notme.bot`

The `_login.html` page advertises passkey registration with no authentication-domain restriction. The `/auth/passkey/register/options` endpoint is openly POST-able (rate-limited per `worker.ts`). The README publicly points to `https://auth.notme.bot` as a "live authority" (`notme/README.md:204`). Whether anyone outside agentic-research uses this is **unknown to this survey** — but the surface is intentionally public and self-serve.

---

## 3. Recommendation

**(b) Alternative 4 is preferred.**

Evidence:

1. **GHA workflow consumers are concrete and load-bearing.** Three production workflows (`signet-resign`, `rig-deploy`, the notme self-test) call `/cert/gha` on `auth.notme.bot` from runners outside cloister-router. The notme action is a tagged, externally-consumable GHA marketplace artifact. Their availability is not coupled to cloister-router today and ought not be.

2. **`rig` is an unambiguous out-of-process consumer.** `rig/web/src/{routes/api.ts:561, index.ts:371,380,396, services/cert.ts:101, middleware/subdomain.tsx:45}` actively call `auth.notme.bot` over HTTPS (plus a CF service binding fallback that, under Alternative 3, also lives in cloister-router). rig stays UP during cloister-router restarts; co-locating notme makes rig partially-degraded.

3. **JWKS is a published trust root.** `/.well-known/jwks.json` is consumed by anyone verifying notme-issued DPoP tokens. The CF Worker's KV cache makes this resilient *only* if every verifier has a fresh cache; cold caches during a cloister-router restart fail.

4. **Math-friend #2's exact stated trigger is satisfied** — line 209 of ADR-0018: "If condition (1) is NOT empirically true for some external consumer (e.g., a GHA CI workflow minting bridge certs via `/cert/gha` while cloister-router is being restarted), then Alternative 4 (below) is preferred over full co-location." That GHA CI workflow is `signet-resign.yml` + `rig/.github/workflows/deploy.yml`. Empirically: both exist; both run today.

---

## 5. Implementation cost if (b)

(Numbered "5" intentionally — the ADR template requested "Risk assessment if (a)" as §4; that section is N/A under recommendation (b).)

### Deploy units

Two notme deploy units, both built from the same source tree (`notme/worker/`), differing only by config and bundle manifest:

| Unit | Endpoints in-process | Runtime | Bindings |
|---|---|---|---|
| `notme-identity` bundle (in cloister-router) | `/internal/ca-bundle`, `/internal/sign-jwt`, and any other strictly cluster-internal helper paths | workerd, co-located with cloister-router | `SIGNING_AUTHORITY` (Durable Object), service-binding-as-syscall to master_sk helper per ADR-0019 |
| `notme-bot` worker (Cloudflare, status quo) | All public paths: `/cert`, `/cert/gha`, `/token`, `/authorize`, `/authorize/token`, `/auth/oidc/login`, `/auth/passkey/*`, `/invites`, `/join`, `/connections`, `/.well-known/jwks.json`, `/.well-known/signet-authority.json`, `/.well-known/ca-bundle.pem`, browser assets | Cloudflare Workers (custom domain `auth.notme.bot/*`) | KV (`CA_BUNDLE_CACHE`), VPC tunnel to signet (today's setup is fine) |

### Cluster manifest reflection

`cluster.capnp` declares `notme-identity` at `tier = hypervisor` with `hypervisorRationale` covering `master_sk`-access-mediation (per ADR-0011 / ADR-0013). Its `holdsCredential` field lists only the master_sk-helper service binding.

`cloister.capnp` `NOTME` service binding resolves to the in-process `notme-identity` bundle for cluster-internal calls (`/internal/sign-jwt` etc.). The CF-deployed `auth.notme.bot` worker has its own independent `wrangler.toml` (status quo retained).

### Lint impact

`scripts/lint-bundle-isolation.mjs` invariants apply only to the in-process `notme-identity` bundle. The CF Worker is outside the lint's scope. Inv 2 / Inv 5 (credential allow-list, cross-hypervisor wires) hold trivially because only the in-process bundle declares the master_sk binding.

### Code sharing

The notme `worker/` source tree continues to serve both deployments unchanged (it already runs on workerd locally + CF in prod per `worker/README.md:3`). The split is purely at the route registration / manifest layer: a small `routes-internal.ts` and `routes-public.ts` boundary inside `worker.ts`, with each deployment loading the union appropriate for it.

### Failure modes recovered

- **GHA workflows.** Continue minting bridge certs via CF when cloister-router restarts.
- **rig admin paths.** JWKS / `/authorize` redirects continue working.
- **Browser users.** `auth.notme.bot/login` and passkey flows continue working.
- **Cluster-internal `/internal/sign-jwt`.** Now in-process, same V8-isolate trust boundary as ADR-0013, so the tier-alignment goal of ADR-0018 is preserved.

### Operational cost

One extra deploy target (the CF Worker — but it already exists today, so this is "don't remove it"). One extra "is it up?" monitoring datapoint. Documentation: ADR-0018 needs a section clarifying the dual-deployment topology and what each endpoint's home is.

The operational-simplification claim in ADR-0018 §Rationale (3) weakens but does not vanish: `cluster.compose.yaml`'s `notme-identity` service entry still goes away (in-process); the CF Worker was never in `cluster.compose.yaml` to begin with.

---

## 4. Risk assessment if (a)

Not applicable under recommendation (b). For completeness: if the project chose (a) anyway, the migration cost from full co-location → Alternative 4 is small (split route registration, restore the CF `wrangler.toml`, repoint custom domain back to the CF Worker). The expensive part would be the time during which external consumers were broken by the correlation, plus any user-credential or session state stored in the in-process `notme-identity` bundle's DO storage that would need migration back to a CF-Worker DO namespace.

---

## Honest gap report

This survey is static and biased toward in-tree code. It cannot speak to:

- **External adopters of the `notme/action`** beyond `signet` and `rig`. The action is a tagged public GHA; anyone could be using it. I did not search GitHub globally.
- **Browser-user volume on `auth.notme.bot/login`.** The surface exists; I have no telemetry.
- **JWKS verifier deployments outside our trees.** Anyone verifying a notme-issued JWT pulls JWKS from `auth.notme.bot`. Population size unknown.
- **Whether the proposed Alternative 3 keeps `auth.notme.bot` DNS pointing at cloister-router or at something else.** ADR-0018 line 268 says "`NOTME` service binding resolves to it instead of the external Worker," which strongly implies the CF Worker is deprecated. If the actual plan is "keep both, just service-bind through cloister-router for the internal paths," that's already Alternative 4 in everything but name.

These gaps weaken the precision of (b) but do not change the recommendation: even the in-tree-discoverable consumers alone (GHA workflows + rig) are sufficient to justify keeping notme's public surface decoupled from cloister-router's lifecycle.
