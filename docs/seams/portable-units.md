# Portable Units — build once, host anywhere

**Status:** design draft · **Scope:** how a thing that does work (a WASI component, *or* a native app that speaks HTTP) becomes a portable, hostable unit in a local-first agent substrate — and how the substrate hosts it. Companion to *The Ring Seam*.

## 1. Goal: the `docker build` feel, for agent units

A developer should be able to take what they have — a Node HTTP service, a Rust CLI, a WASI component — and **build it into one portable artifact**, then **run it** under a substrate that gives it identity, capabilities, a scoped filesystem, and (if it serves HTTP) a route. No cluster to write. The two verbs are *build* and *run*; everything else is the substrate's job.

This is achievable today because the pieces exist and compose:

- **OCI is the portable envelope for both kinds.** containerd + `runwasi` lets you swap container runtimes for WebAssembly runtimes behind a shim, and it **auto-detects the workload type and runs WebAssembly and native containers side-by-side** (native lifecycle via Youki's libcontainer) [1][2]. So one image format, one scheduler, two kinds of payload.
- **Wasm artifacts are portable across hosts.** The same component can move between local Wasmtime, a CDN edge, and Kubernetes-backed Wasm platforms with less packaging drift, and host-managed lifecycle makes caching/precompilation/fast-instantiation easier than container-first serverless [3]. Docker+Wasm is GA as of 2026 [4].
- **A Wasm component that speaks HTTP is a standard thing.** Building to the `wasi:http/proxy` world yields a component you can serve with `wasmtime serve component.wasm`, runnable on *any* runtime supporting that world [5].

## 2. One format, two runtime classes

A **unit** is an OCI image plus a manifest. The manifest's `runtimeClass` selects the backend; everything else (identity, capabilities, mounts, routes) is uniform.

| Runtime class | Payload | Isolation | Hosts your… |
|---|---|---|---|
| `wasm` | WASI component (`wasi:http/proxy` or CLI world) | language-level sandbox + capability grants | portable logic, routers, validators |
| `native` | ordinary binary / Node app | OS-level (Youki/libcontainer; or a kernel sandbox) | "I already have a Node HTTP app" |

containerd+runwasi schedules both; the substrate doesn't care which a given unit is, the same way Kubernetes-with-runwasi doesn't care whether a pod is a container or a Wasm module [2]. This is the answer to "I have a Node app that speaks HTTP and no way to host it": it ships as a `native` unit, and the substrate hosts it like any other.

## 3. The two verbs

### `build` — produce a portable unit

A small CLI takes a source dir + a thin descriptor and emits an OCI image + manifest:

- **Node HTTP app** → wrap as a `native` OCI image (entrypoint = the server), record the port it listens on. Optionally target a Wasm runtime later, but native ships today with zero rewrite.
- **WASI component** → build to `wasm32-wasip2`, target `wasi:http/proxy` for HTTP units or the CLI world for batch units [5], package as an OCI artifact.

The output is content-addressed and signable — the unit is identified by digest, the same property the substrate already uses for the arena and for tool resolution.

### `run` — host it

The substrate (the local kubelet-shaped scheduler) provisions the unit:

1. **Identity** — mint the unit an ephemeral cert (the substrate's identity primitive).
2. **Capabilities** — grant exactly the handles it declared (arena roots, network, downstream tools). No ambient authority.
3. **I/O floor** — wire its storage/IO through the **Ring Seam** (companion spec) to the arena: the unit does not open arbitrary host paths; it submits descriptors that the host validates and services. For `native` units that insist on a real filesystem, mount a scoped projection (a real directory in a private mount namespace) instead — the unit sees only that subtree.
4. **Route (HTTP units)** — the host **terminates the protocol, routes, and applies auth**, then forwards to the unit. For `wasm` HTTP units this is the `wasi:http/proxy` entrypoint [5]; for `native` units it is a reverse-proxy to the recorded port. Either way the unit never owns the listener socket or the TLS — those stay in the host.

This split — **protocol termination, routing, auth, and capability grants in the host; deterministic logic in the unit** — is the recommended edge architecture for Wasm in 2026 [6], and it is what makes "host my HTTP app" safe: the app handles requests; it never handles the network's trust boundary.

## 4. The manifest is the deployment (no cluster YAML)

The unit's manifest is the `server.json` + `_meta` rail the substrate already resolves for tools: declare the image by ref/digest, the runtime class, the capability grants, the arena mount, and (for HTTP) the route. The substrate resolves the ref, fetches the signed manifest, generates the backend wiring, and runs it. **The manifest is the cluster.** Adding a second unit is a second manifest, not an orchestration rewrite.

## 5. Portability story

Because the envelope is OCI and (for `wasm`) the payload is a component, the *same* unit runs:

- **locally** under the substrate's embedded runtime (Wasmtime for `wasm`, libcontainer for `native`),
- **at the edge** on any `wasi:http/proxy`-supporting host [5], and
- **on a cluster** via a Wasm `RuntimeClass` if you ever want one [2].

with minimal packaging drift [3]. "Make my shit portable" cashes out as: build the unit once; the host it lands on is a scheduling choice, not a rewrite.

## 6. Honest limits

- **Isolation differs by class.** `wasm` units get the language-level sandbox + capability model (fine-grained, the Ring Seam mediates every op). `native` units (your Node app) get OS-level isolation — strong blast-radius containment, but **coarser**: it confines what the process may touch, not what shape its mutations take. A `native` unit that needs the arena should still go through the Ring Seam / a scoped projection, not raw host FS, or you lose the structural guarantees.
- **HTTP chaining is Preview-2-limited.** Single `wasi:http/proxy` units serve fine today; fully composing components into HTTP intermediary chains depends on features in the WASI Preview 3 timeframe [6]. Plan single-hop now.
- **Native units are arch-specific.** A `native` unit is a real binary; portability across CPU arches needs multi-arch images. `wasm` units sidestep this — one artifact, every arch — which is a reason to prefer `wasm` for the portable tier even though `native` is the zero-rewrite on-ramp.
- **Windows is deferred.** The kernel-sandbox and the Linux runtime story are first; Windows exists in the runwasi shim tree but is not the near-term target.
- **The Ring Seam's async half is non-standard.** HTTP and arena I/O ride the seam; its zero-copy/async behaviors are ours until WASI Preview 3's native async lands (see companion spec).

## 7. Net

You get the `docker build` feel without forking a runtime or writing a cluster: **`build` turns a Node app or a component into a content-addressed OCI unit; `run` hands it to containerd+runwasi with an identity, capability grants, a Ring-Seam I/O floor, and a host-terminated route.** wasm and native are two runtime classes of one format, scheduled side-by-side, portable by digest. The host owns the trust boundary (termination, routing, auth, caps); the unit owns only its logic.

-----

## References

1. *Runwasi — Architecture Overview* — auto-detects workload type; runs WebAssembly side-by-side with native containers; Youki/libcontainer for native lifecycle & sandboxing. <https://runwasi.dev/developer/architecture.html>
2. Saifeddine Rajhi, *Wasm and Kubernetes* — runwasi as a containerd shim swapping container runtimes for Wasm runtimes; scheduler is agnostic to container-vs-Wasm. <https://seifrajhi.github.io/blog/k8s-wasm-runtimes-part1/>
3. *Wasm Components & WASI Preview 3 at the Edge [2026]* — artifact portability across local Wasmtime / edge / k8s; host-managed lifecycle eases caching & fast instantiation. <https://techbytes.app/posts/wasm-components-wasi-preview-3-edge-optimization-2026/>
4. *WebAssembly in 2026* — Docker+Wasm GA; Spin 3.0, wasmCloud v2, Wasmtime 20+, WASI Preview 2 stable early 2026. <https://masturbyte.com/wasm-2026.html>
5. *leptos_wasi* (WASI Preview 2 + `wasi:http/proxy`) — building to the `wasi:http/proxy` world yields a component servable via `wasmtime serve`, runnable on any runtime supporting that world. <https://github.com/leptos-rs/leptos_wasi>
6. *Wasm Components & WASI Preview 3 at the Edge [2026]* — split model: protocol termination, routing, auth, capability grants in the host; logic in the component; HTTP intermediary chaining depends on Preview 3. <https://techbytes.app/posts/wasm-components-wasi-preview-3-edge-optimization-2026/>
