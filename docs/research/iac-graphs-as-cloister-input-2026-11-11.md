# IaC graphs as cloister input: Terraform, Terragrunt, Pulumi, CDKTF, Crossplane

**Date:** 2026-11-11
**Tracking bead:** `cloister-661f61`
**Relates to:** [ADR-0069](../adr/0069-declared-connections.md) (declared connections),
[ADR-0070](../adr/0070-placements-and-channel-strength.md) (placements, channel strength),
ADR-0072 "Placements are realizers" (`docs/adr/0072-placements-are-realizers.md`, PR #294, not yet on `main`).
**Status:** research note. Nothing here is decided; a schema change it suggests needs its own ADR.

Every source was fetched on 2026-11-11. Citations are `[Sn]`, resolved in
[Sources](#sources). `[unverified]` marks a claim that no fetched primary source confirmed.

## The question

Cloister holds one graph in `cluster.toml`: bundles, a placement per
environment, and declared connections between them (ADR-0070 §1). For a
forwarded placement such as `cloudRun`, the far side of a connection is typed by
hand today: ADR-0069's `gcp` target is `cloudSql = "proj:us-central1:orders"`
or `cloudRun = "payments"`. The policy behind the edge, a `roles/run.invoker`
binding, is applied by the operator's own Terraform (ADR-0070 §4).

Two questions:

1. **Ingest.** Could cloister read an IaC tool's graph and fill in those facts,
   such as the instance connection name, the service URL and the service
   identity? Could it also check its `policy` strength claim against evidence,
   such as an invoker binding in state?
2. **Emit.** Could cloister emit a small fragment, such as the invoker binding,
   that the operator's tool applies, without cloister owning the operator's
   program?

The invariant held throughout: **discovered is not authorized.** An importer
may add facts (targets, addresses, evidence). It never adds grants or
connections. Only declared connections grant anything (ADR-0070 §2;
ADR-0072 "Out of scope").

ADR-0070 §2 sets two constraints on any importer. Cloister runs **no**
Terraform, Helm or Kustomize, and it reads **rendered** artifacts only, **parsed
with a real parser** (`lint:structured-parse`).

## TL;DR

- **Terraform's `show -json` output is the one format worth building against
  first.** It is documented and carries a `format_version` with a stated
  compatibility rule (minor = additive, major = reject) [S1]. It holds
  resolved attribute values, resource types and addresses [S1]. State in this
  form is "always fully known" [S1]. Cloister reads a file the operator
  rendered and does not run Terraform. That is the same posture ADR-0070 takes
  for rendered Kubernetes manifests.
- **The raw state file is not a format to build on.** HashiCorp says the state
  format "is subject to change" and points automation at `terraform show -json`
  [S5].
- **State shows evidence of policy, not proof.** A
  `google_cloud_run_v2_service_iam_member` row in state is evidence that a
  binding exists. But `_member` is non-authoritative: grants made outside
  Terraform are invisible to it [S8]. Absence from state is not absence of a
  grant. The evidence can feed a report. It must never raise strength, and it
  must never create an edge.
- **Pulumi's `stack export` has a richer graph**, with per-resource
  `dependencies` and `propertyDependencies` [S17]. Secrets stay encrypted unless
  `--show-secrets` is passed [S16][S20]. It is a reasonable second adapter.
- **Terragrunt and Crossplane are poor first targets.** Terragrunt's graph
  is unit-to-unit, not resource-level, and its JSON has no documented schema
  [S13]. Crossplane is Kubernetes objects whose shape is per-provider CRDs
  [S28]. Crossplane also changed shape in v2: managed resources became
  namespaced and claims went away for new XRs [S31].
- **CDKTF is a warning, not an input.** It generated Terraform JSON from code
  [S23]. It also owned the whole program, wrapped each provider in generated
  bindings that "maxed out" its team [S27], and was sunset on 2025-12-10
  [S22]. Its exit path was the plain format: `cdktf synth --hcl` [S22].
  Cloister should emit leaf fragments in the tool's own documented format and
  should never wrap or generate the operator's program.

## Comparison matrix

| Question | Terraform | Terragrunt | Pulumi | CDKTF | Crossplane |
|---|---|---|---|---|---|
| 1. Graph and format | `show -json` plan/state; values, types; references in plan config | Unit DAG via `find --json`; rendered config | `stack export` JSON; deps, property deps | Synthesizes Terraform JSON config; no own state | MRs/XRs as Kubernetes objects; `*Ref` edges |
| 2. Read without running tool | Rendered file yes; producing it runs Terraform | Rendering runs Terragrunt; schema undocumented | Rendered file yes; export runs CLI | Read the synthesized JSON; then it's Terraform | `kubectl get -o yaml`; real YAML parser |
| 3. Facts that map | Connection name, URI, SA, IPs, network | Only via each unit's Terraform state | Same as Terraform; mostly the same names | None beyond Terraform's | `status.atProvider`; connection secret refs |
| 4. Policy evidence | IAM member/binding, firewall rows; partial view | Indirect, through unit state | IAM resources in export; partial view | None | IAM MRs if Crossplane manages them |
| 5. Emitting | `.tf.json` module; documented for generation | Not needed; Terraform fragment suffices | Component needs a language runtime | Lesson: never own the program | MR YAML; but reconciler then owns it |
| 6. Adoption / stability | Low cost; `format_version` 1.x since 1.1 | Medium; flags renamed in CLI redesign | Medium; schema v3/v4 in Go types | Deprecated 2025-12-10; do not adopt | High; per-provider CRDs; v2 reshaped |

## Terraform

**Graph and format.** `terraform show -json` renders a plan file or the current
state as JSON [S2]. A plan "shows a JSON representation of the plan,
configuration, and current state" [S2]. The values representation gives each
resource `address`, `mode`, `type`, `name`, `index`, `provider_name`,
`schema_version`, `values` and `sensitive_values` [S1]. The documented
state-values skeleton has **no dependency edges**, and no `depends_on` key
appears in it [S1]. Edges appear only in the plan's `configuration` block,
where expressions carry a `references` list [S1]. A plan also carries
`resource_changes`, `prior_state`, `output_changes`, `checks` and
`relevant_attributes` [S1]. `terraform output -json` gives only root-module
outputs, one key per output, read from state [S3]. `terraform providers schema
-json` gives each resource type's attributes, with `required`, `optional`,
`computed` and `sensitive` flags [S4].

**Reading without running it.** Producing the JSON means running Terraform, but
only read commands (`show`, `output`, `providers schema`), never `apply`.
Cloister can read a file the operator rendered in their own pipeline and run
nothing itself. That is the posture ADR-0070 already takes: "Rendered manifests
only. Cloister runs no Helm, no Kustomize and no terraform." The format is
versioned. `format_version` has been `"1.0"` since Terraform 1.1.0. Minor
bumps are backward-compatible. Consumers should ignore unknown properties and
reject an unsupported major version [S1]. The providers-schema output follows
the same rule [S4]. Do not read the raw state file. HashiCorp says "the state
format is subject to change in new Terraform versions" and points automation at
`show -json` [S5]. Whether `show -json` needs an initialized directory with
provider schemas available is not stated on the command page [S2]
`[unverified]`.

**Facts that map.** These come from the Google provider's attribute reference:

| Cloister fact | Terraform source |
|---|---|
| `cloudSql` target (ADR-0069) | `google_sql_database_instance.connection_name`: "the connection name of the instance to be used in connection strings" [S7] |
| DB host | `private_ip_address`, `public_ip_address`, `dns_name` on the same resource [S7] |
| `cloudRun` target URL | `google_cloud_run_v2_service.uri`, "the main URI in which this Service is serving traffic" [S9] |
| bundle identity in `gcp` | `google_cloud_run_v2_service.template.service_account` [S9] |
| ingress posture | `google_cloud_run_v2_service.ingress` (`INGRESS_TRAFFIC_ALL` / `_INTERNAL_ONLY` / `_INTERNAL_LOAD_BALANCER`) [S9] |
| VPC / network rule | `google_compute_firewall` `network`, `direction`, `allow`, `source_service_accounts`, `target_service_accounts` [S10] |

**Policy behind an edge.** Cloud Run service-to-service calls need the caller's
service account to hold `roles/run.invoker` on the receiving service [S11]. In
Terraform that is a `google_cloud_run_v2_service_iam_member` (or `_binding`,
or `_policy`) row with `name`, `role` and `member = "serviceAccount:…"` [S8].
That row in state is exactly the shape cloister would need to check a
`cloudRun → cloudRun` edge's `policy` claim. Three limits apply:

- **`_member` is non-authoritative.** "Members added outside Terraform are not
  treated as drift" [S8]. State can show a grant exists, but it cannot show
  that a grant does *not* exist. A missing row proves nothing.
- **State is as fresh as its last refresh.** The `show` docs tell you to run
  `terraform refresh` before reading state [S2]. A stale file is stale
  evidence.
- **Firewall rules cover VM instances by service account or tag** [S10]. They
  are not evidence for Cloud Run → Cloud Run, which IAM invoker plus ingress
  governs (ADR-0070 §3).

**Pressure on the invariant.** IAM rows look like edges. An importer that
turned "A's SA has invoker on B" into a connection would let the operator's
Terraform grant through cloister. The rule must run the other way. A binding
with no declared connection behind it is a **finding** (an undeclared grant).
It is never an edge.

**Sensitive data.** `show -json` and `output -json` print sensitive values in
plain text [S2][S3]. `sensitive_values` marks which attributes are sensitive
[S1]. An importer must drop every attribute that `sensitive_values` flags. It
should read only a fixed allowlist of attributes per resource type, and it
must not write any value into `cluster.toml`. Credentials stay `vaultSlice`
references (ADR-0069 §2).

**Emitting.** Terraform reads `.tf.json` files and calls the format "useful when
generating portions of a configuration programmatically" [S6]. Cloister could
emit one module containing a `google_cloud_run_v2_service_iam_member` per
declared `cloudRun → cloudRun` edge. The operator adds it with a `module` block
and applies it. This is the "cloister emits it, does not apply it" that ADR-0070
§4 already promises. Use `_member`, not `_binding` or `_policy`. `_policy`
"replaces any existing policy", and `_policy` must not be mixed with
`_binding`/`_member` because they "will fight" [S8]. Emitting `_member` still
conflicts if the operator manages the same service with `_policy`. The emitter
cannot detect that without the operator's state, and an importer can.

**Adoption cost.** Low. You need a JSON parser, a `format_version` major check,
and a per-type allowlist of a handful of Google resource types.

## Terragrunt

**Graph and format.** Terragrunt orchestrates Terraform/OpenTofu units.
`terragrunt find --json --dag --dependencies` lists configurations with their
type, path and inter-unit dependencies, sorted in dependency order [S13].
`terragrunt render --format json` writes the unit's config "with all includes
and dependencies resolved", with function calls evaluated [S12]. This is the
*input* config, not resource values. `render` replaces `render-json`, which
"will be deprecated by the end of the CLI Redesign" [S15].

**Reading without running it.** Both commands run Terragrunt. Neither page
states a JSON schema or a compatibility promise [S12][S13]. Dependency outputs
come from state: "Terragrunt reads dependency outputs from state by default on
a backend that supports it" [S14]. The render page does not say whether
`render` fetches those outputs [S12] `[unverified]`.

**Facts, policy.** Terragrunt's own artifacts hold none of the facts cloister
needs. They are all in each unit's Terraform state. Terragrunt's real value
here is as a **locator**: it answers which units exist and which state each
unit holds. The Terraform adapter then reads each unit's `show -json`.

**Pressure on the invariant.** The unit DAG is an *ordering* graph ("apply X
before Y"). It is not a reachability graph. Reading a Terragrunt `dependency`
as a cloister connection would be a category error.

**Emitting.** Nothing Terragrunt-specific is needed. A `.tf.json` module drops
into a Terragrunt unit like any other module.

**Adoption cost.** Medium for little gain. The CLI was redesigned recently
(`render-json` → `render` [S15]; `find` reportedly began behind an
experiment flag `[unverified]`).

## Pulumi

**Graph and format.** `pulumi stack export` writes "a stack's deployment to
standard out" [S16]. Each resource (`ResourceV3`) carries `URN`, `Type`,
`ID`, `Inputs`, `Outputs`, `Parent`, `Provider`, `External`, and the two
fields Terraform state JSON lacks. `Dependencies` holds "the dependency edges to
other resources that this depends on". `PropertyDependencies` "maps from an
input property name to the set of resources that property depends on" [S17].
That second field is an attribute-level edge: it says which input of B came
from A.

**Reading without running it.** Producing the export runs the CLI. It reads the
backend and does not run the program or the engine. The Automation API is the
wrong tool here, because it "drives the Pulumi engine itself" and needs the CLI
at runtime [S19]. The export is wrapped in `UntypedDeployment { version,
deployment }` [S17]. Current schema versions are 3, and 4 when v4 features are
in use. Both unmarshal into `DeploymentV3` [S17][S18]. The schema lives in Go
types. I found no standalone published JSON Schema document. A
`DeploymentSchema()` validator is reported in the Go SDK `[unverified]`. The
package states the rule "never make breaking changes" [S17].

**Secrets.** This works in cloister's favour. Secret values are encrypted in
state, and values derived from secrets are marked secret too [S20]. Export
keeps them encrypted unless `--show-secrets` is passed [S16]. An importer can
simply refuse secret-valued fields.

**Facts and policy.** Pulumi says its popular providers "are also built from
open-source Terraform schemas" [S24]. So attribute names mostly match the
Terraform ones (`connectionName`-style casing aside) `[unverified per
resource]`. The type tokens differ, so a shared mapping table would key on
(provider, type) per tool. Policy evidence has the same partial-view limit as
Terraform, because the same non-authoritative IAM member semantics apply
`[unverified for Pulumi's gcp provider]`.

**Emitting.** A component "is a logical grouping of Pulumi resources". It is
usable across languages only when shipped as a Pulumi package with a plugin
[S21]. That means building and versioning a plugin for each target, which is
much heavier than a `.tf.json` file. Do not build it.

**Adoption cost.** Medium. It is a second adapter behind the same interface,
with a separate per-type mapping.

## CDKTF

**What it was.** CDKTF let you "define infrastructure resources using
programming constructs and provision them using HashiCorp Terraform" [S22].
`cdktf synth` wrote Terraform configuration as JSON by default, into an
ephemeral `cdktf.out` directory [S23]. Its CLI also wrapped deploy, diff and
destroy [S23]. Typed provider bindings were generated per provider, and
HashiCorp published prebuilt binding packages [S27].

**Why it was deprecated.** HashiCorp's notice reads: "Terraform CDK (CDKTF) will
sunset and be archived on December 10, 2025". The reason given: it "did not
find product-market fit at scale" [S22]. The recommended exit is "standard
Terraform and HCL" via `cdktf synth --hcl` [S22]. The CLI docs now carry the
deprecation banner [S23]. Other evidence about cost:

- A HashiCorp team member wrote in 2024 that "the process of generating the
  CDKTF bindings is complex enough" and that "our team is basically maxed out on
  the amount of ongoing maintenance we can handle" [S27].
- Ably, migrating its workspaces off CDKTF, judged that the stronger
  types were not "worth the cost of the extra build step". It built a generator
  whose output was "validated by Terraform tooling itself" [S26].
- A competing vendor called CDKTF "always a translation layer sitting on top of
  Terraform" [S25]. This is vendor commentary, not evidence.

**What to learn.** The following is inference from the facts above, not a
claim any source makes:

1. **The durable artifact was the JSON. The program was not.** When CDKTF died,
   the way out was the plain format. A cloister fragment should be plain
   `.tf.json` from day one, so there is nothing to migrate off.
2. **Generated per-provider bindings are a treadmill.** Cloister should emit
   only the few resource types its edges lower to (one IAM member type
   today). It should never generate typed wrappers for a provider.
3. **Wrapping the tool's lifecycle made CDKTF the owner.** Its CLI ran
   deploy, diff and destroy [S23]. Cloister should emit a module and stop:
   the operator's `plan`/`apply` stays the operator's. This matches ADR-0070's
   rule that forwarded placements "parse; they do not own".

**Reading it.** There is nothing to read. CDKTF's output *is* Terraform config,
and once applied, state is Terraform's. Do not adopt it.

## Crossplane

**Graph and format.** Every external resource maps to a **managed resource**
(MR), a Kubernetes object [S28]. `spec.forProvider` holds desired settings and
is treated as the source of truth: Crossplane reverts console changes [S28].
`status.atProvider` holds observed values [S30]. Edges are explicit. A field
can reference another MR by `*Ref` (name), `*Selector` (labels) or
`matchControllerRef` [S28]. `writeConnectionSecretToRef` names the Secret where
the provider writes endpoints and credentials [S28]. Compositions template many
resources into one composite resource (XR) through a function pipeline [S29].

**Reading without running it.** The objects can be read as rendered YAML
(`kubectl get -o yaml`). They parse with a real YAML parser and need no
Crossplane binary. That is the same path ADR-0070 already uses for manifests.
But there is no single format. Each provider ships its own CRDs and API
versions. Upjet, the code-generation framework behind the AWS, Azure and GCP
providers [S32], reportedly builds those CRDs from Terraform provider schemas
`[unverified]`. v2 reshaped the model. MRs are namespaced, cluster-scoped MRs
are "a legacy feature", new XRs "don't support claims", native patch-and-
transform is removed, and XRs "no longer have native connection details
support" [S31].

**Facts and policy.** `status.atProvider` carries the same facts as Terraform
state when Crossplane manages the resource. That includes the connection name
and URI, at per-provider field paths `[unverified per field]`. Policy evidence
exists only if Crossplane manages the IAM resource too.

**Observe-only.** A `managementPolicies: ["Observe"]` MR "observes the resource
and doesn't make any changes" [S28]. Crossplane then "populates the
`status.atProvider` fields with the values from the external resource" [S30].
This is the closest any of the five systems comes to a read-only fact source.
But it needs a running Crossplane control plane and provider, and the
management-policy feature is beta [S28].

**Emitting.** Cloister could emit an IAM MR as YAML, like its NetworkPolicy
overlay. But a reconciler then owns that grant and reverts out-of-band changes
[S28]. That is a stronger ownership claim than a `.tf.json` module the
operator chooses to apply. Do not build it unless an operator already runs
Crossplane.

**Pressure on the invariant.** This is the strongest of the five. `*Ref`
fields and compositions look like a ready-made dependency graph, and XRs look
like bundles. Importing an XR as a bundle, or a `*Ref` as a connection, would
make Crossplane the author of cloister's graph. Both are out.

**Adoption cost.** High. Each provider's CRDs need their own mapping, and v2 is
still migrating some providers' MRs to namespaced form [S31].

## Recommendation

**Build first: one read-only resource-facts importer interface, with a
Terraform `show -json` adapter.**

1. **Interface.** `importFacts(renderedFile) → ResourceFact[]`. Each fact
   holds `{source, formatVersion, fileDigest, address, type, attrs}`, where
   `attrs` is a per-type **allowlist** (connection name, URI, service account,
   ingress, IAM `role`/`member`). The return type has no `grant`,
   `connection` or `edge` field. That makes "discovered is not authorized" a
   property of the type, not of reviewer discipline. Attributes flagged in
   `sensitive_values` are dropped before they reach a fact. Rendered input
   only; cloister runs nothing.
2. **Terraform adapter.** Parse `show -json` state (not plan, because state is
   fully known [S1]). Reject `format_version` major ≠ 1 and ignore unknown
   properties [S1]. Never read raw `.tfstate` [S5]. Start with four types:
   `google_sql_database_instance`, `google_cloud_run_v2_service`,
   `google_cloud_run_v2_service_iam_member`, `google_compute_firewall`.
3. **Two consumers, both report-first.**
   - **Target resolution.** A `gcp` target may name a fact
     (`cloudSql` resolved from a resource address) instead of a typed string.
     A literal still wins, and an unresolved address fails the build by name.
     This adds a `cluster.toml` field, so it needs an ADR (CLAUDE.md "When to
     write an ADR"). Check it against ADR-0070's rule against duplicating
     forwarded-spec fields.
   - **Evidence rail.** For each declared `cloudRun → cloudRun` edge, report
     whether an invoker `_member` for the caller's SA exists in state. Report
     invoker grants that have **no** declared edge as findings. The rail
     never changes computed strength. Missing evidence is "unknown", not
     "none", because `_member` is non-authoritative [S8].
4. **Emit the one fragment ADR-0070 §4 promises.** A `.tf.json` module of
   `google_cloud_run_v2_service_iam_member` rows, one per declared edge [S6].
   The operator applies it.

**Do not build:**
- a raw state-file parser [S5], or anything that runs Terraform, Terragrunt,
  Pulumi or `kubectl apply`;
- the Pulumi Automation API integration [S19], Pulumi component emission
  [S21], or a Terragrunt-specific adapter (use it only to locate state);
- generated per-provider bindings, or any wrapper over the operator's
  `plan`/`apply` (the CDKTF lesson);
- an importer path that creates a connection, an edge, a placement or a
  bundle from discovered IAM rows, firewall rules, Terragrunt dependencies,
  Crossplane `*Ref`s or XRs;
- `_binding` or `_policy` emission, because both are authoritative and conflict
  with the operator's own IAM [S8].

Second, if demand shows up: a Pulumi `stack export` adapter behind the same
interface. Its `propertyDependencies` [S17] give better edge evidence than
Terraform state.

## Open questions

1. **Freshness and provenance.** Who renders the JSON, and when? Should the
   fact carry the file digest into the emitted plan's digest, so a stale input
   is visible? Evidence from un-refreshed state is stale [S2].
2. **Plaintext secrets at rest.** `show -json` writes sensitive values in plain
   text [S2]. Should cloister refuse an input file whose `sensitive_values` is
   non-empty for non-allowlisted attributes, or only strip them? Either way,
   the file must not be committed to a public repo.
3. **Can evidence ever gate?** If an operator opts in, should a missing invoker
   binding fail the build for an edge with `minStrength = "policy"`? Because
   `_member` is non-authoritative, absence is not proof. A gate would need
   the operator to use `_binding`, which is authoritative per role [S8].
4. **Where do realizer tables meet evidence?** ADR-0072 §2 makes strength a
   realizer's declared data. Is evidence a third column ("declared, achieved,
   observed"), or a separate report?
5. **Multi-state merging.** With Terragrunt, one environment is many states.
   How should facts with colliding addresses across units be keyed?
6. **OpenTofu.** Does OpenTofu's `show -json` keep the same `format_version`
   contract? Not checked here `[unverified]`.
7. **Fact references vs. ADR-0070's no-duplication rule.** Naming a Terraform
   address in a target adds a field, but it removes a duplicated *value*. The
   ADR for target resolution should settle whether that counts as duplication.

## Sources

All accessed 2026-11-11.

- [S1] Terraform, "JSON Output Format" — https://developer.hashicorp.com/terraform/internals/json-format
- [S2] Terraform, "terraform show command" — https://developer.hashicorp.com/terraform/cli/commands/show
- [S3] Terraform, "terraform output command" — https://developer.hashicorp.com/terraform/cli/commands/output
- [S4] Terraform, "terraform providers schema command" — https://developer.hashicorp.com/terraform/cli/commands/providers/schema
- [S5] Terraform, "State" — https://developer.hashicorp.com/terraform/language/state
- [S6] Terraform, "JSON Configuration Syntax" — https://developer.hashicorp.com/terraform/language/syntax/json
- [S7] terraform-provider-google, `sql_database_instance` docs — https://raw.githubusercontent.com/hashicorp/terraform-provider-google/main/website/docs/r/sql_database_instance.html.markdown
- [S8] terraform-provider-google, `cloud_run_v2_service_iam` docs — https://raw.githubusercontent.com/hashicorp/terraform-provider-google/main/website/docs/r/cloud_run_v2_service_iam.html.markdown
- [S9] terraform-provider-google, `cloud_run_v2_service` docs — https://raw.githubusercontent.com/hashicorp/terraform-provider-google/main/website/docs/r/cloud_run_v2_service.html.markdown
- [S10] terraform-provider-google, `compute_firewall` docs — https://raw.githubusercontent.com/hashicorp/terraform-provider-google/main/website/docs/r/compute_firewall.html.markdown
- [S11] Google Cloud, "Authenticating service-to-service" (Cloud Run) — https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- [S12] Terragrunt, `render` command — https://docs.terragrunt.com/reference/cli/commands/render/
- [S13] Terragrunt, `find` command — https://docs.terragrunt.com/reference/cli/commands/find/
- [S14] Terragrunt, HCL blocks reference (`dependency`) — https://docs.terragrunt.com/reference/hcl/blocks/
- [S15] Terragrunt v0.77.17 release notes (mirror) — https://newreleases.io/project/github/gruntwork-io/terragrunt/release/v0.77.17
- [S16] Pulumi, `pulumi stack export` — https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_export/
- [S17] Pulumi source, `sdk/go/common/apitype/core.go` — https://raw.githubusercontent.com/pulumi/pulumi/master/sdk/go/common/apitype/core.go
- [S18] Pulumi `apitype` package docs (v3.274.1) — https://pkg.go.dev/github.com/pulumi/pulumi/sdk/v3/go/common/apitype
- [S19] Pulumi, "Automation API" — https://www.pulumi.com/docs/iac/concepts/automation-api/
- [S20] Pulumi, "Secrets" — https://www.pulumi.com/docs/iac/concepts/secrets/
- [S21] Pulumi, "Components" — https://www.pulumi.com/docs/iac/concepts/components/
- [S22] hashicorp/terraform-cdk README (sunset notice) — https://github.com/hashicorp/terraform-cdk
- [S23] CDKTF CLI commands — https://developer.hashicorp.com/terraform/cdktf/cli-reference/commands
- [S24] Pulumi blog, "CDKTF is deprecated: what's next for your team" (2025-12-18) — https://www.pulumi.com/blog/cdktf-is-deprecated-whats-next-for-your-team/
- [S25] env zero blog, "Another one bites the dust" (2025-12-11; vendor commentary) — https://www.envzero.com/blog/another-one-bites-the-dust-what-the-cdktf-deprecation-means-for-you
- [S26] Ably engineering, CDKTF migration with tfgen (2026-07-21) — https://ably.com/blog/cdktf-migration-tfgen
- [S27] HashiCorp Discuss, "The standards of pre-built providers…" (2024-01-16) — https://discuss.hashicorp.com/t/the-standards-of-pre-built-providers-and-the-process-of-testing-and-maintaining-them/61748
- [S28] Crossplane v2.4, "Managed Resources" — https://docs.crossplane.io/latest/managed-resources/managed-resources/
- [S29] Crossplane v2.4, "Compositions" — https://docs.crossplane.io/latest/composition/compositions/
- [S30] Crossplane v2.4, "Import Existing Resources" — https://docs.crossplane.io/v2.4/guides/import-existing-resources/
- [S31] Crossplane v2.0, "What's new" — https://docs.crossplane.io/v2.0/whats-new/
- [S32] crossplane/upjet repository — https://github.com/crossplane/upjet
