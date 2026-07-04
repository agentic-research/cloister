# docs/

Orientation map for everything under `docs/`. The repo's top-level
docs are [`README.md`](../README.md) (project intro + quickstart),
[`GETTING-STARTED.md`](../GETTING-STARTED.md) (operator setup),
[`CHANGELOG.md`](../CHANGELOG.md), [`CLAUDE.md`](../CLAUDE.md) (AI
session memory), and [`AGENTS.md`](../AGENTS.md) (agent dispatch).

Everything under `docs/` is one of these kinds:

| Subdir | What lives there |
|---|---|
| [`adr/`](adr/) | Numbered architectural decisions — the *why* behind every substrate choice. Current range: ADR-0001 through ADR-0025 (with ADR-0022 reserved-but-not-drafted). Per-ADR status canonical in [`STATUS.md`](STATUS.md). Start with ADR-0001 → ADR-0002 → ADR-0007 (Interlace) → ADR-0011 (hypervisor/bundle boundary) for the core mental model. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The substrate description — *what* runs and how it composes. Read after the README + ADR-0011. |
| [`security/`](security/) | Threat model + adversarial-cycle reports. `threat-model.md` is the contract (17 sections); `adversarial-cycles/` records red-team findings. |
| [`perf/`](perf/) | Benchmark reports for the load-bearing perf claims (lease pipeline, dispatch, TrustStore contention, disclosure endpoint, cold start). |
| [`deployment/`](deployment/) | Operator runbooks: cluster-in-a-pod, off-platform peers, secure ART tool operation. |
| [`integration/`](integration/) | Wiring at both ends: `mcp-client.md` (how external MCP clients connect to cloister) and `authoring-server-json.md` (how MCP server authors describe a server so cloister can consume it). |
| [`launch/`](launch/) | Pre-launch verification checklists. The current one is `PRE-LAUNCH-VERIFICATION.md`. |
| [`mcp-seps/`](mcp-seps/) | Internal SEP drafts about the upstream MCP spec. **Not** submissions in flight — design notes for cloister's own framing. |
| [`research/`](research/) | Design notes + surveys that inform decisions but aren't themselves decisions. |
| [`tenants/`](tenants/) | Per-tenant docs (one page per backend: `bead-mcp.md`, `mache-mcp.md`, etc.). Drift-gated by `scripts/lint-tenant-docs.mjs`. |
| [`glossary.md`](glossary.md) | Canonical definitions for terms that get conflated across cloister + sibling repos (e.g. `leyline` vs `leyline-sign` vs `signet-sign`). Add an entry when a name has shown up in more than one place with a different meaning. |

## If you're trying to...

| Goal | Start here |
|---|---|
| Run cloister locally | [`../GETTING-STARTED.md`](../GETTING-STARTED.md) |
| Understand the substrate model | [`ARCHITECTURE.md`](ARCHITECTURE.md), then [`adr/0011-hypervisor-bundle-boundary.md`](adr/0011-hypervisor-bundle-boundary.md) |
| Verify a security claim | [`security/threat-model.md`](security/threat-model.md) → trace to the test + bead it cites |
| See what red-team review found | [`security/adversarial-cycles/`](security/adversarial-cycles/) |
| Add a new MCP tool family | [`adr/0006-derived-tool-schemas.md`](adr/0006-derived-tool-schemas.md) + the existing `LspToolBackend` template |
| Add a new ADR | next free is **ADR-0026** (latest is 0025; 0022 reserved-but-not-drafted, see `cloister-ae587d`); see any 00*.md for the shape. Per-ADR status canonical in [STATUS.md](STATUS.md). |
| Wire a client to `/mcp` | [`integration/mcp-client.md`](integration/mcp-client.md) |
| Make your MCP server consumable by cloister | [`integration/authoring-server-json.md`](integration/authoring-server-json.md) |
| Operate cloister in a cluster topology | [`deployment/cluster-in-a-pod.md`](deployment/cluster-in-a-pod.md) |
| Run ART tools securely through cloister | [`deployment/secure-art-tools.md`](deployment/secure-art-tools.md) |

## Conventions

- **ADRs are append-only** — never delete or renumber. Statuses change
  (Proposed → Accepted / Deferred / Superseded) but the file stays.
- **Threat model is the contract** — load-bearing security claims live
  there with a status, a test pointer, and a bead. If something is
  "secure," it's in `threat-model.md`. If it's not in there, it's not
  defended.
- **Adversarial-cycle reports are dated** — `YYYY-MM-DD.md` under
  `security/adversarial-cycles/`. One per cycle (specialists + synthesis-
  lead per ADR-0020).
- **Bead IDs are the work-tracking glue** — `cloister-XXXXXX` slugs in
  doc headers, ADR `relates_to:` frontmatter, and threat-model rows
  let you walk from "this is documented" → "this is being worked on" →
  "this is shipped."
