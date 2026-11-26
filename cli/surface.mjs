// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CLI surface, declared once.
//
// `printHelp` used to hardcode the command list and docs/reference/ had no CLI
// page at all — so adding `cloister run` meant editing the dispatcher's help by
// hand and the documentation not mentioning the verb at all. Two statements of
// one fact, one of them missing.
//
// This is the single declaration. The help text and docs/reference/cli.md are
// both PROJECTIONS of it, so a new command appears in both or in neither.
//
// ── Why not scrape `--help` ───────────────────────────────────────────────
//
// The obvious shortcut is to spawn each verb with `--help` and capture stdout.
// It is wrong in three ways: it derives documentation from BEHAVIOUR rather than
// both from a declaration; it puts N subprocess spawns in the lint path; and it
// only works while every `--help` is side-effect free, which is a property that
// has already failed once here (harness-dev.mjs `--help` used to mint a
// credential — cloister-eb33d4). A declaration cannot have that bug.
//
// ── Why plain data, not zod (yet) ─────────────────────────────────────────
//
// zod is the right layer for VALIDATING parsed argv — types, required, defaults,
// refinements — and cli-run.mjs currently does that by hand. But the shape a
// documentation emitter needs, and the shape a future schema-bridge emitter
// would consume, is plain declarative data. Keeping this as data means Phase 2
// (ADR-0036: lift the multi-output IR to LLO once proven across ≥2 schemas) can
// consume it without unwrapping a validation library first. Wiring zod in as the
// argv validator is the natural next step and does not change this shape.
//
// ── Colour lives in the renderer ──────────────────────────────────────────
//
// No chalk here. Colour is a property of the help PROJECTION, not of a command's
// identity — the docs emitter has to get clean markdown from the same source.

/**
 * The env-var contract between `cloister run` and the harness launcher.
 *
 * These names were string literals in TWO files with nothing pairing them:
 * cli-run.mjs wrote them, harness-dev.mjs read them. Rename either side and
 * `cloister run --repo X` silently confines to process.cwd() instead of X — the
 * wrong tree, with every test still green, because a test that only checks the
 * CLI SETS a variable cannot notice the consumer stopped reading it.
 *
 * Declared here so both sides reference one definition, and railed by
 * cli/test/cli-surface.test.mjs asserting the consumer still honours it.
 * The process boundary between them is a separate concern (cloister-d8599e);
 * this is the part that drifts silently.
 */
export const HARNESS_ENV = Object.freeze({
  /** Absolute path the harness is confined to — the ONLY writable surface. */
  workdir: "HARNESS_WORKDIR",
  workdirs: "HARNESS_WORKDIRS",
  /** Selects the confinement provider. */
  sandbox: "SANDBOX",
  /** The only provider harness-dev.mjs implements. */
  sandboxProvider: "nono",
  /**
   * Absolute path to the harness executable, per-machine.
   *
   * Under confinement there is no $PATH inside the sandbox, so the binary must
   * be named by absolute path. `entryPoint` on the harnessTargets row is the
   * DECLARED form — but the path is machine-local
   * (`/Users/me/.local/bin/claude` is not a fact about the cluster), so
   * committing it to a shared manifest would be wrong. This is the
   * per-invocation rung of the ladder the launcher already implements:
   *
   *     HARNESS_CMD  >  TARGET.entryPoint  >  TARGET.name ($PATH, unconfined only)
   */
  harnessBin: "HARNESS_CMD",
  /**
   * JSON array of arguments passed through to the harness itself.
   *
   * Needed for any non-interactive run: with no TTY inside the sandbox, claude
   * defaults to --print and exits asking for a prompt. Everything after `--` on
   * the cloister run line lands here, which is what makes an ephemeral attested
   * run scriptable rather than interactive-only.
   */
  harnessArgs: "HARNESS_ARGS",
});

/**
 * @typedef {{flag: string, value?: string, summary: string, required?: boolean,
 *            repeatable?: boolean, default?: string, short?: string}} Flag
 * @typedef {{name: string, summary: string, required?: boolean, repeatable?: boolean}} Argument
 *   A positional, named `<like-this>`; only a command's last may be repeatable.
 * @typedef {{name: string, usage: string, summary: string, detail?: string,
 *            arguments?: Argument[], flags?: Flag[], examples?: string[],
 *            seeAlso?: string}} Command
 */

/** Global flags are plain declaration data so terminal help and Markdown agree. */
export const GLOBAL_OPTIONS = [
  {
    flag: "--color",
    value: "<auto|always|never>",
    summary: "color human-readable output (default: auto; auto colors only a terminal)",
  },
  {
    flag: "--no-color",
    summary: "plain output; alias for --color never (NO_COLOR=1 also works)",
  },
];

/** @type {Command[]} */
export const COMMANDS = [
  {
    name: "install",
    usage: "cloister install",
    summary: "Install Cloister and its experimental compatibility runtime",
    detail:
      "Installs the locked Node dependencies, regenerates the files declared by " +
      "cluster.toml, builds and digest-checks the current compatibility runtime, " +
      "and puts the cloister command in ~/.local/bin (or CLOISTER_BIN_DIR). " +
      "On macOS arm64 it also installs LLO's digest-pinned leyline-krun-worker " +
      "and creates the microVM store; the compatibility runtime is temporary " +
      "while LLO's native execution API matures.",
  },
  {
    name: "uninstall",
    usage: "cloister uninstall",
    summary: "Remove this checkout's installed command",
    detail:
      "Removes only a symlink that points to this checkout. It refuses to remove " +
      "an unrelated file or another checkout's command, and keeps runtime files " +
      "so uninstalling the command cannot silently delete machine state.",
  },
  {
    name: "run",
    usage: "cloister run --harness <name> --repo <abs> [--repo <abs> …] [-- <harness args...>]",
    summary: "Run a harness confined to the repos you name",
    detail:
      "Executes a harness with the named repositories as its ONLY readable and " +
      "writable paths. Every other path is kernel-denied — `~/.ssh`, other " +
      "repositories, and outbound network — with EPERM rather than ENOENT, so " +
      "the boundary does not leak whether a path exists. Loopback to cloister " +
      "stays open, which is what makes cloister the only route tools arrive by.\n\n" +
      "`--repo` repeats. The first is the primary workspace and becomes the " +
      "harness's working directory. WHICH repos you name does not change the " +
      "attested confinement digest — the manifest holds symbolic paths — but HOW " +
      "MANY does, because more writable roots is a wider boundary and the cert " +
      "commits to the shape.",
    flags: [
      { flag: "--repo", value: "<abs>", required: true,
        summary: "a directory the harness may read and write; repeat for more, and the first is the primary (the harness's cwd). Must be absolute — a relative path is rejected rather than resolved against the current directory, because the confinement boundary is not something to infer. Duplicate or nested paths are refused: they would make the attested shape claim more roots than the confinement has" },
      { flag: "--harness", value: "<name>", summary: "harness to launch (default: the declared default target)" },
      { flag: "--target", value: "<name>", summary: "deprecated spelling of --harness; accepted during migration and warns once" },
      { flag: "--dry-run", summary: "print what would be confined; mint nothing, launch nothing" },
      { flag: "--setup-only", summary: "mint the identity and write .dev.vars, do not launch" },
      { flag: "--audit", summary: "forward harness auth and emit a receipt; no key vaulted" },
      { flag: "--harness-bin", value: "<abs>", summary: "absolute path to the harness executable. Required under confinement when the target declares no entryPoint, because there is no $PATH inside the sandbox — and the path is machine-local, so it belongs on the invocation rather than in a shared manifest" },
      { flag: "--no-sandbox", summary: "DANGEROUS: skip kernel confinement (debugging only)" },
      { flag: "--", value: "<args...>", summary: "everything after this is passed to the harness itself. Required for a non-interactive run: with no TTY inside the sandbox the harness has no prompt to read" },
    ],
    seeAlso: "docs/reference/confinement-model.md",
  },
  {
    name: "dev bootstrap",
    usage: "cloister dev bootstrap [--dir <checkout>]",
    summary: "Prepare a checkout for local development",
    detail:
      "Creates or refreshes the gitignored .env.local file needed by the local " +
      "Worker. Existing secrets are reused. When a local notme or signet " +
      "authority is available, its public key is recorded so lease checks are on.",
    flags: [
      { flag: "--dir", value: "<checkout>", summary: "Cloister checkout (default: the current directory)" },
    ],
  },
  {
    name: "dev serve",
    usage: "cloister dev serve [--dir <checkout>]",
    summary: "Run Cloister locally on port 8787",
    detail:
      "Loads .env.local without a shell, checks for conflicting configuration " +
      "sources, and runs the local Worker directly. Run `cloister dev bootstrap` first.",
    flags: [
      { flag: "--dir", value: "<checkout>", summary: "Cloister checkout (default: the current directory)" },
    ],
  },
  {
    name: "dev test",
    usage: "cloister dev test [--dir <checkout>]",
    summary: "Run every repository Node test discovered by convention",
    detail:
      "Finds every *.test.mjs file under cli/test, lint/test, gen/test and dev/test, plus the nono harness checks, " +
      "sorts them, and runs them once. Adding a test does not require editing " +
      "the Taskfile or another filename list.",
    flags: [
      { flag: "--dir", value: "<checkout>", summary: "Cloister checkout (default: the current directory)" },
    ],
  },
  {
    name: "init",
    usage: "cloister init --recipe <name> --out <dir> [--port N]",
    summary: "Scaffold a cluster recipe",
    flags: [
      { flag: "--recipe", value: "<name>", required: true, summary: "recipe to instantiate" },
      { flag: "--out", value: "<dir>", required: true, summary: "destination directory" },
      { flag: "--port", value: "<N>", summary: "port to expose" },
    ],
  },
  {
    name: "add",
    usage: "cloister add <ref> [--name <name>] [--version <ver>] [--provides <cap>]... [--requires <cap>]...",
    summary: "Add and resolve a tool input",
    detail:
      "Adds the input to cluster.toml, resolves the ref, records its content digest in " +
      "cluster.lock.toml, and derives the backend declarations from the tool's own " +
      "server.json. Refuses rather than guesses when the input declares no transport.",
    arguments: [
      { name: "<ref>", required: true, summary: "the input: file://<abs-path>, https://<url>, github://owner/repo[/path]@<ref>, or its registry name io.github.org/owner/repo[/path]@<ref>; a GitHub ref must pin a git ref" },
    ],
    flags: [
      { flag: "--name", value: "<name>", summary: "input name (default: derived from the ref's basename)" },
      { flag: "--version", value: "<ver>", summary: "the version to record for the input, as a semver range or an exact version; it is recorded, not checked" },
      { flag: "--provides", value: "<cap>", repeatable: true, summary: "a capability this input provides, in the lane-3 shape cloister/<name>/v<n> (ADR-0028)" },
      { flag: "--requires", value: "<cap>", repeatable: true, summary: "a capability this input requires, in the same shape" },
    ],
    examples: [
      "cloister add github://anthropic/skills@main",
      "cloister add github://anthropic/skills/python-bridge.md@v1.2.0 --name python-bridge --provides cloister/skill/v1",
      "cloister add file:///abs/path/to/skill --name local-skill",
    ],
  },
  {
    name: "skills list",
    usage: "cloister skills list [--dir <cluster>] [--state-dir <path>]",
    summary: "Show which skills are pinned, unpinned, undeclared, or CHANGED",
    detail:
      "Surveys the harness skills directory against a cluster's " +
      "`[[gateway.skills]]` declarations. Exits non-zero when a PINNED skill's " +
      "bytes no longer match — that is the state worth acting on, and an exit " +
      "code makes it usable from a script. Results are grouped by what needs " +
      "attention: CHANGED, unpinned, undeclared, then pinned. The text labels " +
      "remain when color is off.",
    flags: [
      { flag: "--dir", value: "<cluster>", summary: "cluster directory holding cluster.toml (default: the current directory)" },
      { flag: "--state-dir", value: "<path>", summary: "harness state dir; skills are read from <path>/skills (default: ~/.claude)" },
    ],
    seeAlso: "docs/adr/0061-skills-declared-and-verified.md",
  },
  {
    name: "skills pin",
    usage: "cloister skills pin [<name>...] [--dir <cluster>] [--write] [--force]",
    summary: "Emit [[gateway.skills]] declarations with current digests",
    detail:
      "Prints the declarations to paste into cluster.toml. Pinning is an act of " +
      "TRUST — it says you have looked at these bytes — so it does NOT edit your " +
      "manifest by default: a command that rewrote it silently would turn " +
      "vouching into a keystroke, and the reflex after a failed verification is " +
      "to re-run it.\n\n" +
      "Name one or more skills to pin only those skills; with no names, every " +
      "discovered skill is selected. `--write` appends for the first-run case. " +
      "Skills already pinned are left " +
      "alone; re-pinning one whose bytes CHANGED needs `--force`, because " +
      "adopting an unpinned skill is bookkeeping while changing an existing pin " +
      "is a decision.",
    flags: [
      { flag: "--dir", value: "<cluster>", summary: "cluster directory holding cluster.toml (default: the current directory)" },
      { flag: "--state-dir", value: "<path>", summary: "harness state dir; skills are read from <path>/skills (default: ~/.claude)" },
      { flag: "--write", summary: "append to cluster.toml instead of printing" },
      { flag: "--force", summary: "also re-pin skills whose bytes changed under an existing pin" },
    ],
    seeAlso: "docs/adr/0061-skills-declared-and-verified.md",
  },
  {
    name: "cluster generate",
    usage: "cloister cluster generate [--dir <path>] [--check]",
    summary: "Generate every committed projection from cluster.toml",
    detail:
      "Reads cluster.toml once, validates it, then produces canonical " +
      "cluster.toml, src/generated/cluster.ts, cloister.capnp and " +
      "cluster.compose.yaml. If validation or rendering fails, the existing " +
      "generated files are left alone.",
    flags: [
      { flag: "--dir", value: "<path>", default: ".", summary: "cluster directory" },
      { flag: "--check", summary: "report drift without writing any file" },
    ],
  },
  {
    name: "cluster resolve",
    usage: "cloister cluster resolve [--dir <path>]",
    summary: "Resolve declared inputs into cluster.lock.toml",
    detail:
      "Reads [inputs.*] from cluster.toml, fetches or reads each declared ref, " +
      "and records its content digest in cluster.lock.toml.",
    flags: [
      { flag: "--dir", value: "<path>", default: ".", summary: "cluster directory" },
    ],
  },
  {
    name: "cluster up",
    usage: "cloister cluster up [--dir <path>] [--detach] [--locked] | cloister cluster up --env <name> [--dir <path>] [--locked]",
    summary: "Bring a declared cluster up (compose, or microVMs with --env)",
    detail:
      "With --env, starts every bundle placed \"microvm\" in that env from cluster.toml and " +
      "cluster.lock.toml: each connection's target before its source (a cycle is refused), " +
      "each bundle bound once every socket it binds exists (health is not checked, so it " +
      "is not called ready — ADR-0071 §3). Plans are emitted in memory " +
      "exactly as `runtime plan` would. Channel sockets live in a fresh owner-only " +
      "directory, printed per exposed port and removed on exit. A port declared " +
      "expose = \"edge\" is also published on the host as TCP at 127.0.0.1:<port> (loopback " +
      "only), relayed to that socket once its bundle is bound; every edge port is bound " +
      "before anything starts, so a busy one is refused by name. Runs in the foreground; " +
      "SIGINT/SIGTERM/SIGHUP/SIGQUIT stops every run in reverse order; a second signal " +
      "reports progress, a third SIGKILLs the host runtimes (a krun worker from LLO 0.31 " +
      "or later exits with its host runtime; one installed before that can outlive it " +
      "until `cloister runtime install` is re-run). If `up` is killed, each host runtime stops on " +
      "stdin EOF. If a run ends on its own, the rest " +
      "are stopped and the command exits non-zero, naming it. Kubernetes-placed bundles " +
      "are skipped (`cluster k8s`). Needs each bundle's rootfs imported for this host's " +
      "guest platform (`runtime import --bundle`).\n\n" +
      "Without --env:\n" +
      "Runs the cluster declared by `cluster.compose.yaml` in --dir (default: " +
      "the current directory), using nerdctl, podman or docker — whichever is " +
      "present, or COMPOSE_CMD if set. Each image is resolved when it starts " +
      "(ADR-0083 §4), through the engine compose drives (or CONTAINER_CMD). An " +
      "image written by digest runs as written, pulled by that digest if missing. " +
      "Any other image the engine holds runs by its image ID, under a tag made from " +
      "that ID; one that names a registry and is not held is first pulled with the " +
      "engine's credentials. A bare name the engine does not hold " +
      "is refused by name and never pulled, and then nothing starts. Each container " +
      "records what it runs in its cloister.image labels, and `up` prints each " +
      "digest that moved since the last run. With --locked, `up` starts only a " +
      "digest cluster.toml writes or cluster.lock.toml pins, and refuses, before " +
      "anything starts, an image with no digest or a cluster.compose.yaml whose " +
      "images are not what cluster.toml and cluster.lock.toml render. It asks no " +
      "registry what a tag names today.\n\n" +
      "A scaffolded cluster includes a small Taskfile, and its `task up` command " +
      "delegates to this CLI command. Both paths therefore use one implementation " +
      "of starting a cluster.",
    flags: [
      { flag: "--dir", value: "<path>", default: ".", summary: "cluster directory. Present from the start because the next shape is many cloisters, and a cwd-only verb would foreclose it" },
      { flag: "--detach", short: "-d", summary: "run in the background (compose -d); not with --env" },
      { flag: "--env", value: "<name>", summary: "start the microVM-placed bundles of this env instead of compose" },
      { flag: "--locked", summary: "start only images pinned by digest, in cluster.toml or cluster.lock.toml (ADR-0083 §5). The microVM placement always runs this way" },
    ],
  },
  {
    name: "cluster down",
    usage: "cloister cluster down [--dir <path>] [--destroy]",
    summary: "Tear a cluster down, preserving volumes",
    detail:
      "Stops the cluster and KEEPS its volumes. Durable-Object SQLite state " +
      "lives in those volumes, so removing them is unrecoverable and is never " +
      "the default for a routine-looking verb — pass --destroy to opt in.",
    flags: [
      { flag: "--dir", value: "<path>", default: ".", summary: "cluster directory" },
      { flag: "--destroy", summary: "ALSO remove volumes — unrecoverable; DO state lives there" },
    ],
  },
  {
    name: "cluster k8s",
    standalone: true,
    usage: "cloister cluster k8s --out <dir> [--env <name>] [--dir <path>] [--locked]",
    summary: "Lower kubernetes placements to manifests + NetworkPolicy; check knative ones",
    detail:
      "For each bundle placed \"kubernetes\" in --env, checks its rendered " +
      "manifest's Service against the ports cluster.toml declares, copies the " +
      "manifest unchanged, and adds an overlay in a namespace named after the " +
      "bundle: the Namespace, a default-deny-ingress NetworkPolicy, and one " +
      "NetworkPolicy per declared connection into it. Apply each bundle's " +
      "directory with `kubectl apply -n <bundle> -f <out>/<bundle>`. For each bundle " +
      "placed \"knative\", checks its Knative Service, copies its manifest unchanged and adds " +
      "the Namespace the Service names when the manifest does not declare it. No " +
      "NetworkPolicy is written for it. Each printed apply line names the namespace: the " +
      "bundle's own for kubernetes, the Service's for knative. The checks: the " +
      "port must be dialled on 80 (set with [[bundles.placements.ports]] when the " +
      "workload listens elsewhere), the appProtocol must match the http1 or h2c wire, " +
      "and `expose` must agree with the Service's route visibility. expose = " +
      "\"cluster\" requires the label networking.knative.dev/visibility: cluster-local, " +
      "and expose = \"edge\" requires it absent. An edge between a kubernetes and a " +
      "knative bundle is lowered: a knative caller is admitted by the kubernetes " +
      "target's NetworkPolicy (strength \"policy\"), and a kubernetes caller reaches a " +
      "knative target that nothing fences from in-cluster callers (strength \"none\"). " +
      "A connection that sets a higher minStrength than its edge has fails the build. " +
      "Edges to any other placement are refused (they need LLO's broker). " +
      "For both kinds, the in-cluster addresses in each container's " +
      "environment (resolved through envFrom, env, valueFrom and variable " +
      "references, for ConfigMaps and Secrets in the manifest), args and " +
      "command are held to the declared connections: an " +
      "address naming another bundle with no declared connection, or on a " +
      "port no declared connection reaches, fails the build. An address is " +
      "any host, in a URL, a DSN or a bare host:port; values are never " +
      "printed. ADR-0070 §2-4. With --locked, a container whose image has no digest, " +
      "or runs a digest other than the lock's pin for its bundle, is refused before " +
      "anything is written (ADR-0083 §5).",
    flags: [
      { flag: "--out", value: "<dir>", required: true, summary: "output directory (may exist, but only with files this run writes)" },
      { flag: "--env", value: "<name>", default: "local", summary: "environment whose placements and targets are lowered" },
      { flag: "--dir", value: "<path>", default: ".", summary: "cluster directory holding cluster.toml" },
      { flag: "--locked", summary: "refuse a container image that is not pinned by digest, or is not the lock's pin for its bundle (ADR-0083 §5)" },
    ],
    seeAlso: "docs/adr/0070-placements-and-channel-strength.md",
  },
  {
    name: "cluster graph",
    standalone: true,
    usage: "cloister cluster graph [--env <name>] [--dir <path>] [--json]",
    summary: "Show every declared edge, what carries it, and what holds it",
    detail:
      "Reads cluster.toml and prints one graph: every [[connections]] row that has a target " +
      "in --env, and every [[wires]] row. For each edge it says what carries it where it " +
      "runs, its strength (none, policy or capability: what stops a bundle that is not the " +
      "declared caller), and the mechanism in a sentence. A strength is what the emitter " +
      "for that placement writes today, never what is intended: an edge nothing enforces " +
      "is shown as none, with the reason. An edge below its minStrength is marked. " +
      "Strength is reachability, not the isolation boundary under it: two compose " +
      "containers and two microVMs can both be capability, though the containers share " +
      "the host kernel (ADR-0070 §3, amendment of 2026-11-20). A " +
      "connection with no target in --env is listed, not dropped. Nothing is written or " +
      "started. ADR-0075.",
    flags: [
      { flag: "--env", value: "<name>", default: "local", summary: "environment whose connection targets and placements are read" },
      { flag: "--dir", value: "<path>", default: ".", summary: "cluster directory holding cluster.toml" },
      { flag: "--json", summary: "print the graph as JSON: the Graph format in schema/cli.schema.json, versioned by formatVersion" },
    ],
    seeAlso: "docs/adr/0075-one-graph.md",
  },
  {
    name: "cluster lower",
    standalone: true,
    usage: "cloister cluster lower [--env <name>] [--dir <path>]",
    summary: "Write each kubernetes- or knative-placed bundle's manifest from cluster.toml",
    detail:
      "For each bundle placed \"kubernetes\" or \"knative\" in --env, writes the manifest " +
      "its placement row names, from the bundle as cluster.toml declares it. On kubernetes: " +
      "a Deployment and a Service, or a Job when the bundle has runs = \"job\". On knative: " +
      "a Knative Service. A port is dialled on the number its placement row gives " +
      "([[bundles.placements.ports]]) and listened on at the bundle's own number, so a " +
      "Knative Service is dialled on 80 and a Kubernetes Service maps port to targetPort. " +
      "The same row may set expose for that placement only, so a port that is \"edge\" " +
      "as deployed can be \"cluster\" on a local cluster. " +
      "If any bundle cannot be lowered, nothing is written. cluster.toml is the only input, so a " +
      "hand-written file and one drafted by `inspect --draft` are lowered the same way. " +
      "The image, entry point, args and literal env values are written as declared. An " +
      "env row bound to a connection is set to that connection's address in this " +
      "placement, plus its path. An env row bound to a secret becomes a secretKeyRef, and " +
      "the manifest says which Secret to create. A manifest that already exists is never " +
      "overwritten. Nothing is applied. Then run `cluster k8s`: it holds the addresses in " +
      "these manifests to the declared connections and writes the NetworkPolicies. An " +
      "address that crosses placements is refused. ADR-0074 §7.",
    flags: [
      { flag: "--env", value: "<name>", default: "local", summary: "environment whose kubernetes and knative placements are lowered" },
      { flag: "--dir", value: "<path>", default: ".", summary: "cluster directory holding cluster.toml" },
    ],
    seeAlso: "docs/adr/0074-the-graph-is-derived-cluster-toml-holds-intent.md",
  },
  {
    name: "inspect",
    standalone: true,
    usage: "cloister inspect [--terraform <file>] [--wrangler <file>]... [--crd <file>]... [--mapping <file>]... [--dir <path>] [--env <name>] [--json] [--fail-on <kinds>] | cloister inspect --terraform <file> --draft --env <name> [--crd <file>]... [--mapping <file>]... [--local <env> [--local-kind <kind>]] [--name <name>]",
    summary: "Report what a rendered Terraform document and wrangler configs describe, beside cluster.toml",
    detail:
      "Reads the output of `terraform show -json` (or `tofu show -json`), state or " +
      "plan, and/or wrangler configs (where a Worker's bindings live), and lists the " +
      "workloads, bindings, routes, tunnels and storage they describe. With a cluster.toml it also reports, for each declared wire, " +
      "whether the document shows a matching binding, and lists bindings between " +
      "workloads that cluster.toml does not declare. Read-only: it runs no tool and " +
      "writes nothing. Discovered resources are facts, never grants. Only an " +
      "allowlist of non-secret attributes is read, and a file tracked by git is " +
      "refused, because a rendered document prints secrets in plain text. " +
      "The attributes read are a data mapping validated against the provider's " +
      "published schema, and relations are exact joins. In a plan document, a relation " +
      "whose value is unknown until apply may resolve through the configuration's " +
      "references, only when exactly one referenced resource has the target type. " +
      "Cloudflare resource types, Google Cloud Run services and jobs (with their invoker " +
      "member rows, and what each one dials, read from its containers' env and args) " +
      "and Cloud SQL instances and Cloud Tasks queues, and " +
      "wrangler.toml / wrangler.json are read today. With a cluster.toml, each " +
      "declared connection is also compared with what the inputs say a service " +
      "dials: evidenced, unknown, or undeclared, plus the services cluster.toml " +
      "does not list. Each exposed port's `expose` is compared with what the inputs say " +
      "about reaching the workload from outside its network (Cloud Run's ingress): " +
      "evidenced, unknown, or contradicted when the two disagree. " +
      "With --draft it prints a cluster.toml instead: one bundle per " +
      "workload and one connection per edge the inputs imply. A bundle carries what the " +
      "workload is started with: image, args, whether it is a service or a job, and env. " +
      "An env value is drafted as what it is: a literal, a binding to a connection (an " +
      "address, which differs per placement), or a secret reference. A value taken from " +
      "a variable is not drafted and is named in the header. From a plan, env is read " +
      "from the configuration, so it is found even when the provider marks the whole " +
      "block sensitive. --local <env> adds a kubernetes placement for a second " +
      "environment, which `cluster lower` then writes manifests for. The draft is printed, never written, and an " +
      "existing cluster.toml is not read. Its header lists what the inputs did not show: " +
      "an env block marked sensitive, a port that was assumed, an edge whose target is " +
      "not a workload, a resource type no mapping reads. Committing the draft is what " +
      "makes it a declaration. A checkout supplies the CRDs and entries for kinds cloister " +
      "does not ship in cluster.toml's [inspect], or for one run with --crd and --mapping; " +
      "the report says what checked each kind. ADR-0073, ADR-0074.",
    flags: [
      { flag: "--terraform", value: "<file>", summary: "`terraform show -json` output (state or plan); must not be tracked by git" },
      { flag: "--wrangler", value: "<file>", summary: "a wrangler.toml or wrangler.json to read bindings from; repeatable (at least one of --terraform / --wrangler is required)" },
      { flag: "--crd", value: "<file>", summary: "a CRD to check a kind cloister ships no schema for against, for this run; repeatable. It may only add kinds: replacing one is declared in cluster.toml's [[inspect.crds]]" },
      { flag: "--mapping", value: "<file>", summary: "a mapping file of entries for kinds of object a resource holds whole, for this run; repeatable. cluster.toml's [inspect] mappings names the checkout's own" },
      { flag: "--dir", value: "<path>", summary: "cluster directory holding cluster.toml (default: the current directory, if it has one)" },
      { flag: "--env", value: "<name>", summary: "the environment these inputs describe; declared connections are compared for that environment only (default: every environment)" },
      { flag: "--json", summary: "print the report as JSON: the InspectReport format in schema/cli.schema.json, versioned by formatVersion" },
      { flag: "--fail-on", value: "<kinds>", summary: "exit 3 when a finding of these kinds is reported, a comma list of undeclared, contradicted, unknown (for CI). Needs a cluster.toml. Exit 1 means the check could not run, 2 that it was called wrongly" },
      { flag: "--draft", summary: "print a cluster.toml drafted from --terraform, for you to review and commit; needs --env" },
      { flag: "--local", value: "<env>", summary: "with --draft: also place every bundle in this environment, for `cluster lower`" },
      { flag: "--local-kind", value: "<kind>", summary: "with --local: kubernetes (default) or knative. A job is always placed kubernetes" },
      { flag: "--name", value: "<name>", summary: "with --draft: the cluster name in [metadata] (default: drafted)" },
    ],
    seeAlso: "docs/adr/0074-the-graph-is-derived-cluster-toml-holds-intent.md",
  },
  {
    name: "artifacts pull",
    usage: "cloister artifacts pull [<input>...] [--print] [--yes] [--allow-unpinned]",
    summary: "Acquire lockfile-pinned OCI artifacts",
    detail:
      "Pulls every image cluster.lock.toml pins into the local container store, so " +
      "`cloister cluster up`, which emits pull_policy: never, can boot offline. The store " +
      "is the one `cluster up` starts from: $CONTAINER_CMD, else the engine its compose " +
      "runtime drives. That includes each image a multi-image producer names for a bundle " +
      "in [[inputs.<input>.ociBundles]], and each operator image the lock pins in " +
      "[[images]], pulled by its digest. Naming inputs pulls only theirs. It shows the plan " +
      "and asks before downloading; without a terminal to ask on, it refuses unless --yes " +
      "is given. A tag-pinned or bare reference is refused unless --allow-unpinned is " +
      "given too: consent to download is not consent to weaker provenance.",
    arguments: [
      { name: "<input>", repeatable: true, summary: "an input whose images to pull (default: every input). Naming inputs does not weaken the check on the others' references" },
    ],
    flags: [
      { flag: "--print", summary: "show the plan and download nothing" },
      { flag: "--yes", short: "-y", summary: "approve the plan shown (required without a terminal)" },
      { flag: "--allow-unpinned", summary: "permit tag-pinned or bare references, which are not content-addressed" },
    ],
  },
  { name: "runtime plan", usage: "cloister runtime plan <bundle> --workspace <absolute-path> [options]",
    summary: "Emit a fail-closed host launch plan",
    flags: [
      { flag: "--workspace", value: "<abs>", required: true, summary: "workspace the plan is scoped to" },
      { flag: "--control-socket", value: "<path>", summary: "host-runtime control socket" },
      { flag: "--env", value: "<name>", summary: "environment whose connection targets are lowered (default: local)" },
      { flag: "--channel-dir", value: "<abs>", summary: "directory of declared-channel sockets (default: /tmp/cloister-host-runtime/ch)" },
      { flag: "--dir", value: "<path>", summary: "cluster directory holding cluster.toml + cluster.lock.toml (default: this checkout)" },
      { flag: "--output", value: "<path>", summary: "write the JSON plan here" },
    ] },
  {
    name: "runtime install",
    usage: "cloister runtime install",
    summary: "Build and install the experimental compatibility runtime",
    detail:
      "Builds the native confinement helper and host runtime, copies them into " +
      "~/.local/libexec/cloister (or CLOISTER_LIBEXEC_DIR), and writes a provider " +
      "record containing their SHA-256 digests. Runtime commands verify those " +
      "digests before execution.",
  },
  { name: "runtime import", usage: "cloister runtime import [--layout <dir>] [--bundle <name> [--dir <cluster>]] [--image <sha256:…>] [--symlinks preserve|refuse|resolve]",
    summary: "Import a digest-pinned OCI image (layout or registry) as a microVM rootfs",
    detail:
      "With --bundle, imports that bundle's pinned image (in cluster.lock.toml, the digest of " +
      "the [[inputs.<input>.ociBundles]] row naming it when its producer publishes several " +
      "images, else [inputs.<bundle>.oci] digest; --image may be omitted, and must equal it " +
      "if given) and records the resulting blake3-256 rootfs beside the pin as a rootfs row " +
      "([[inputs.<bundle>.oci.rootfs]], or [[inputs.<input>.ociBundles.rootfs]]) " +
      "for the platform LLO reports (other platforms' rows are kept); `runtime plan` and " +
      "`cluster up` run the row for the host runtime's guest platform. Idempotent. With --bundle and no --layout, the pinned `identifier@sha256:…` is " +
      "pulled from its registry (anonymous HTTPS, public images only; a tag-only or unpinned " +
      "image is refused). Without --bundle, prints LLO's import record and writes nothing.",
    flags: [
      { flag: "--layout", value: "<dir>", summary: "an OCI image layout (oci-layout + blobs/sha256); not a docker store. With --bundle, omit it to pull from the registry" },
      { flag: "--bundle", value: "<name>", summary: "record the rootfs for this bundle in cluster.lock.toml" },
      { flag: "--dir", value: "<cluster>", summary: "with --bundle: cluster directory holding cluster.lock.toml (default: the current directory)" },
      { flag: "--image", value: "<sha256:…>", summary: "index or manifest digest to import; tags are refused (with --bundle: defaults to the locked digest)" },
      { flag: "--symlinks", value: "<preserve|refuse|resolve>", summary: "keep links as links (default), refuse them, or copy in-image targets; recorded in the lock when not the default" },
    ] },
  { name: "runtime run", usage: "cloister runtime run <plan>",
    summary: "Run a compatibility plan or LLO execution envelope" },
  { name: "runtime inspect", usage: "cloister runtime inspect <run-id>",
    summary: "Inspect LLO execution events" },
  { name: "runtime collect", usage: "cloister runtime collect <run-id>",
    summary: "Collect an LLO terminal receipt" },
  { name: "runtime cancel", usage: "cloister runtime cancel <run-id> --idempotency-key <key>",
    summary: "Cancel an LLO execution" },
  { name: "runtime cleanup", usage: "cloister runtime cleanup <run-id> --idempotency-key <key>",
    summary: "Release LLO execution resources" },
  { name: "runtime doctor", usage: "cloister runtime doctor [--json]",
    summary: "Check runtime prerequisites and storage",
    flags: [{ flag: "--json", summary: "print one machine-readable report" }] },
  { name: "runtime storage init", usage: "cloister runtime storage init --idempotency-key <key> [--backend native|microVm]",
    summary: "Provision storage through the LLO provider" },
  { name: "runtime storage status", usage: "cloister runtime storage status [--json]",
    summary: "Show bounded storage state without changing it",
    flags: [{ flag: "--json", summary: "print one machine-readable status object" }] },
];

/**
 * Per-command help, derived.
 *
 * cli-run.mjs used to hardcode its own option list, which is how `--harness-bin`
 * could be declared, documented and parsed while `cloister run --help` did not
 * mention it — the same defect as the top-level list, one level down. Both help
 * texts and the docs page now read from this one declaration.
 *
 * @param {string} name
 * @returns {string}
 */
/** A flag as help and the reference page show it: `-y, --yes`, `--dir <path>`. */
export const flagLabel = (f) => `${f.short ? `${f.short}, ` : ""}${f.flag}${f.value ? ` ${f.value}` : ""}`;

/** An argument as help and the reference page show it: `<ref>`, `<input>...`. */
export const argumentLabel = (a) => `${a.name}${a.repeatable ? "..." : ""}`;

export function renderCommandHelp(name) {
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) throw new Error(`no declared command ${JSON.stringify(name)}`);
  const lines = [`Usage: ${c.usage}`, "", c.detail ?? c.summary, ""];
  const required = (c.flags ?? []).filter((f) => f.required);
  const optional = (c.flags ?? []).filter((f) => !f.required);
  const args = c.arguments ?? [];
  const width = Math.max(
    ...(c.flags ?? []).map((f) => flagLabel(f).length),
    ...args.map((a) => argumentLabel(a).length),
    10,
  ) + 2;
  // A declared default is shown from the declaration, so the text cannot
  // name one default while the parser applies another (cli/lib/flags.mjs).
  const row = (f) => `  ${flagLabel(f).padEnd(width)} ${f.summary}${f.repeatable ? " (repeatable)" : ""}${f.default !== undefined ? ` (default: ${f.default})` : ""}`;
  const argumentRow = (a) => `  ${argumentLabel(a).padEnd(width)} ${a.summary}${a.required ? " (required)" : ""}`;
  if (args.length) { lines.push("Arguments:", ...args.map(argumentRow), ""); }
  if (required.length) { lines.push("Required:", ...required.map(row), ""); }
  if (optional.length) { lines.push("Options:", ...optional.map(row), ""); }
  lines.push("  --help".padEnd(width + 2) + " this text — mints nothing, writes nothing", "");
  if (c.examples?.length) { lines.push("Examples:", ...c.examples.map((e) => `  ${e}`), ""); }
  return lines.join("\n");
}

/**
 * The declared command `argv` names: the longest `name` whose words begin it.
 * Undefined when none does.
 *
 * @param {string[]} argv the arguments after the global options
 */
export function commandFor(argv) {
  let best;
  for (const c of COMMANDS) {
    const words = c.name.split(" ");
    if (words.every((w, i) => argv[i] === w) && (!best || words.length > best.name.split(" ").length)) best = c;
  }
  return best;
}

/**
 * The commands the one-file build runs (gen/bundle.mjs). A command is here
 * because it reads nothing from a cloister checkout and needs nothing but
 * Node, and gen/test/bundle.test.mjs runs each one from an empty directory.
 * Every other command, run from that file, refuses by name.
 */
export const STANDALONE = Object.freeze(COMMANDS.filter((c) => c.standalone).map((c) => c.name));

/** The top-level help text, derived. Colour is applied by the caller, not here. */
export function renderHelp() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 12;
  const lines = ["Usage: cloister <command> [options]", "", "Commands:"];
  for (const c of COMMANDS) {
    lines.push(`  ${`cloister ${c.name} ...`.padEnd(width)} ${c.summary}`);
  }
  const optionWidth = Math.max(
    ...GLOBAL_OPTIONS.map((option) => `${option.flag} ${option.value ?? ""}`.trim().length),
  ) + 2;
  lines.push("", "Global options:");
  for (const option of GLOBAL_OPTIONS) {
    const label = `${option.flag} ${option.value ?? ""}`.trim();
    lines.push(`  ${label.padEnd(optionWidth)} ${option.summary}`);
  }
  lines.push("", "Run `cloister <command> --help` for command-specific options.");
  if (globalThis.__CLOISTER_BUNDLE__ === true) {
    lines.push(`This is the one-file build. It runs: ${STANDALONE.join(", ")}. The others need a cloister checkout.`);
  }
  return lines.join("\n");
}
