// SPDX-License-Identifier: AGPL-3.0-or-later
//
// capability-matchmaker — ADR-0027's matchmaker algorithm (cloister-e059ea).
//
// WHAT THIS IS
//
// `manifest/cluster.capnp` already declares the capability lattice on every
// input — `provides @5 :List(Text)` (studs out) and `requires @6 :List(Text)`
// (anti-studs in) — and its own comments promise that "the matchmaker at compose
// time connects studs ↔ anti-studs" and "surfaces an error if no input satisfies
// a `requires`". Nothing resolved them. This is that resolver.
//
// WHY IT MATTERS BEYOND WIRING (ADR-0054)
//
// ADR-0054 splits dispatch into a NEURAL half (parse natural language into a
// formal capability request) and a SYMBOLIC half (adjudicate that request
// against the committed manifest). This is the symbolic half's foundation: it
// needs no model, it is exhaustively verifiable offline, and — the property the
// constrained-decoding experiment could not provide — an unsatisfiable request
// produces a PRECISE ERROR naming what is missing, rather than a plausible
// wrong answer. A mis-parse fails closed here instead of dispatching the wrong
// capability with a valid-looking shape.
//
// SCOPE (phase 1)
//
// Steps 1, 2 and 4 of the ADR-0027 algorithm — the pure resolution core:
//   1. collect every `provides` into a provider index
//   2. resolve every `requires` (unsatisfied → error; ambiguous → error unless
//      an explicit binding override breaks the tie)
//   4. reject cycles in the resulting require-graph
// Steps 3 (capability-typed route binding) and 5 (emit the wired manifest) touch
// the capnp emitters and are deliberately a later increment; they compose on top
// of the bindings this returns.
//
// No regex, per the operator's standing rule.

/** Raised for every unsatisfiable input. Carries a machine-readable `code`. */
export class MatchError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "MatchError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Step 1 — index every capability an input claims to provide.
 * Returns Map<capability, inputName[]> with insertion order preserved so error
 * messages are deterministic (a nondeterministic error message is a flaky test
 * waiting to happen).
 */
export function collectProviders(inputs) {
  const providers = new Map();
  for (const input of inputs) {
    for (const cap of input.provides ?? []) {
      if (!providers.has(cap)) providers.set(cap, []);
      const list = providers.get(cap);
      // A single input listing the same capability twice is a declaration bug,
      // but it must not make the capability look ambiguous with itself.
      if (!list.includes(input.name)) list.push(input.name);
    }
  }
  return providers;
}

/**
 * Step 2 — bind every `requires` to exactly one provider.
 *
 * `overrides` is the ambiguity-break the ADR calls for: `{ "<cap>": "<input>" }`
 * selects a provider when more than one exists. An override naming an input that
 * does not actually provide the capability is itself an error — otherwise a typo
 * would silently reintroduce the ambiguity it was meant to resolve.
 *
 * Returns { bindings: Array<{ consumer, capability, provider }> }.
 * Throws MatchError on the first unsatisfiable requirement.
 */
export function resolveRequires(inputs, providers, overrides = {}) {
  const bindings = [];
  for (const input of inputs) {
    for (const cap of input.requires ?? []) {
      const candidates = providers.get(cap) ?? [];

      if (candidates.length === 0) {
        throw new MatchError(
          "unsatisfied",
          `input "${input.name}" requires "${cap}" but no input provides it`,
          { consumer: input.name, capability: cap },
        );
      }

      // Self-satisfaction is not wiring — an input cannot fulfil its own
      // anti-stud, or the lattice degenerates.
      const external = candidates.filter((c) => c !== input.name);
      if (external.length === 0) {
        throw new MatchError(
          "self-provided",
          `input "${input.name}" requires "${cap}" but only provides it to itself`,
          { consumer: input.name, capability: cap },
        );
      }

      if (external.length > 1) {
        const chosen = overrides[cap];
        if (chosen === undefined) {
          throw new MatchError(
            "ambiguous",
            `input "${input.name}" requires "${cap}"; ambiguous between ${external.join(", ")}` +
              ` — set an explicit binding override for "${cap}" to break the tie`,
            { consumer: input.name, capability: cap, candidates: external },
          );
        }
        if (!external.includes(chosen)) {
          throw new MatchError(
            "bad-override",
            `binding override for "${cap}" names "${chosen}", which does not provide it` +
              ` (providers: ${external.join(", ")})`,
            { capability: cap, chosen, candidates: external },
          );
        }
        bindings.push({ consumer: input.name, capability: cap, provider: chosen });
        continue;
      }

      bindings.push({ consumer: input.name, capability: cap, provider: external[0] });
    }
  }
  return { bindings };
}

/**
 * Step 4 — reject cycles in the require-graph (consumer depends on provider).
 * Iterative DFS with an explicit stack; returns the first cycle found as a path
 * so the error can name it, rather than just asserting one exists.
 */
export function detectCycle(bindings) {
  const edges = new Map();
  for (const b of bindings) {
    if (!edges.has(b.consumer)) edges.set(b.consumer, []);
    edges.get(b.consumer).push(b.provider);
  }
  const UNVISITED = 0, IN_PROGRESS = 1, DONE = 2;
  const state = new Map();
  const parent = new Map();

  for (const start of edges.keys()) {
    if ((state.get(start) ?? UNVISITED) !== UNVISITED) continue;
    const stack = [start];
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      const st = state.get(node) ?? UNVISITED;
      if (st === UNVISITED) {
        state.set(node, IN_PROGRESS);
        for (const next of edges.get(node) ?? []) {
          const ns = state.get(next) ?? UNVISITED;
          if (ns === IN_PROGRESS) {
            // Walk parents back to `next` to render the cycle path.
            const path = [node];
            let cur = node;
            while (cur !== next && parent.has(cur)) {
              cur = parent.get(cur);
              path.push(cur);
            }
            path.reverse();
            path.push(next);
            return path;
          }
          if (ns === UNVISITED) {
            parent.set(next, node);
            stack.push(next);
          }
        }
      } else {
        if (st === IN_PROGRESS) state.set(node, DONE);
        stack.pop();
      }
    }
  }
  return null;
}

/**
 * Run the resolution core (steps 1, 2, 4) over a list of inputs.
 *
 * Returns { providers, bindings } on success. Throws MatchError — never a
 * partial or best-effort result — on any unsatisfiable input. Fail-closed is the
 * point: a request the lattice cannot satisfy must be REJECTED, not approximated.
 */
export function matchCapabilities(inputs, { overrides = {} } = {}) {
  if (!Array.isArray(inputs)) {
    throw new MatchError("bad-input", "matchCapabilities expects an array of inputs");
  }
  const seen = new Set();
  for (const input of inputs) {
    if (typeof input?.name !== "string" || input.name === "") {
      throw new MatchError("bad-input", "every input needs a non-empty string name");
    }
    if (seen.has(input.name)) {
      throw new MatchError("duplicate-input", `input "${input.name}" is declared more than once`);
    }
    seen.add(input.name);
  }

  const providers = collectProviders(inputs);
  const { bindings } = resolveRequires(inputs, providers, overrides);

  const cycle = detectCycle(bindings);
  if (cycle !== null) {
    throw new MatchError("cycle", `cycle in capability graph: ${cycle.join(" → ")}`, { cycle });
  }

  return { providers, bindings };
}
