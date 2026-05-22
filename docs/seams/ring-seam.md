# The Ring Seam — an io_uring-shaped I/O boundary for sandboxed units

**Status:** design draft · **Scope:** the guest↔host I/O contract for WASI components (and, by extension, any sandboxed unit) in a local-first agent substrate.

## 1. Problem

A WASI guest cannot issue syscalls; it can only call host-provided imports. As of WASI Preview 2 (stabilized in early 2026) there is still no native async I/O — async is emulated through a polling interface (`wasi:io/poll`), and from the guest program’s perspective host calls are **synchronous and block until completion** (the runtime, e.g. Wasmtime, drives them with async Rust internally) [1][2][3]. That gives two problems for an agent unit doing lots of file/arena I/O:

1. **Latency:** every `fd_read`/`fd_write` is a blocking host trap; no batching, no overlap.
1. **Mediation:** there is no single, cheap place to enforce “this read/write is in scope” — enforcement gets scattered across host functions.

We want one mechanism that is fast, async-capable, and is *also* the single chokepoint where the substrate decides yes/no on every I/O operation.

## 2. The borrow from io_uring

io_uring solves the analogous kernel↔userspace problem with **two shared-memory ring buffers** mapped into both domains: a submission queue (SQ) and a completion queue (CQ), plus a separate array of submission entries (SQEs) [4][5]. The shape we reuse:

- The caller writes a **submission entry** describing an operation — opcode, target handle, buffer address, length, offset — to the tail of the SQ. Each entry is “in essence the equivalent of a system call you would have made otherwise” [6][7].
- The servicer places **exactly one completion entry per submission** at the tail of the CQ; the completion carries a `res` field (the return value / negative error number, as the syscall would have returned) and a `user_data` field copied from the submission so the caller can correlate completions that arrive in any order [6][8].
- Because the bulk of communication is via the shared buffers, it is **zero-copy** and avoids a syscall per operation; an optional polling mode lets the servicer watch the SQ tail so the caller need not signal at all [9].

We are **not** putting kernel io_uring in the guest’s hands — that would be a sandbox-escape surface, because io_uring submissions can bypass syscall filters. We are reusing io_uring’s *protocol shape* as the **guest↔host** contract, where the host (not the kernel) services entries. In the WASM threat model the guest cannot reach the host kernel at all, so the escape vector does not exist here.

## 3. The Ring Seam

A region of shared memory — for a WASM unit, a region of its linear memory — holds:

- **SQ**: ring of submission descriptors. Each descriptor: `{ op, handle, buf_ptr, buf_len, offset, user_data, flags }`. `op` is a WASI-level operation (`read`, `write`, `open-at`, `readdir`, `stat`, `http-send`, …). `buf_ptr`/`buf_len` reference a region of the guest’s own linear memory.
- **CQ**: ring of completion descriptors. Each: `{ user_data, res, flags }`, where `res` mirrors a POSIX return — a byte count on success, a **negative errno on failure** (e.g. `-EACCES`, `-EROFS`, `-ENOENT`) — matching io_uring’s convention so the guest’s libc/WASI shim can surface ordinary errors [8].
- **Head/tail indices** for each ring, advanced with the same publish-after-write memory-ordering discipline io_uring requires (write the entry, then publish the tail) [8].

### 3.1 The drain loop *is* the enforcement point

The host’s job is a loop: read a submission, **validate it, then service it against the arena**, then post a completion. Validation is two checks, both below the guest and unreachable by it:

1. **Capability check** — is `handle` one the unit was granted? Out-of-scope handle → post `res = -EACCES`, never touch storage.
1. **Schema/scope check (writes)** — apply the proposed mutation against the content-addressed store, parse the result, and accept only if it still satisfies the unit’s write-scope and the store’s schema. Reject → `res = -EROFS` or `-EACCES`.

This is the entire value of the design: transport and mediation are the **same loop**. There is no separate “policy layer” the agent could be routed around — the only way to do I/O is to put a descriptor on the ring, and the only thing that drains the ring is the validating host. Permitted ops are serviced from the arena (zero-copy where the buffer is a mapped region); forbidden ops come back as ordinary POSIX errors the guest already knows how to handle.

### 3.2 “The guest doesn’t care” — synchronous transparency

The seam must not force the guest to understand rings. The default mode is **synchronous-over-ring**: the guest’s WASI `fd_read` shim submits one descriptor and blocks (host yields the guest) until the matching completion posts. The guest sees a perfectly ordinary, blocking `fd_read` returning bytes or an errno — it has no idea a ring, a schema, or an arena exists. This matches how WASI calls already feel synchronous to the guest today [2], so trained agent tooling is unchanged.

**Async is opt-in.** A guest that wants concurrency batches many submissions and reaps completions out of order via `user_data` — the io_uring batching win [9]. But that requires the guest to run a reactor and is therefore a per-unit choice; the substrate never requires it. For the common case (an agent calling `read_file` / `edit_file`), synchronous-over-ring is correct and invisible.

## 4. Zero-copy and the arena

Buffers are regions of the guest’s linear memory; the host reads/writes them in place — no marshaling [9]. Two intensities:

- **Default:** host copies the requested arena slice into the guest’s buffer on a read. Simple, universal, one copy.
- **Zero-copy read of a large blessed blob:** for a long-lived unit needing a big read-only resource (model weights, an index), back the unit’s linear memory with a host `mmap` of the blessed, content-addressed arena slice via Wasmtime’s `MemoryCreator`/`LinearMemory` traits — the embedder supplies host-managed memory and `memory.data_ptr()` returns exactly the host pointer [10][11]. Map it **read-only** (the arena is single-writer; a read-only map means even a hostile guest cannot corrupt truth) and only the blessed slice — never the whole arena. The traits are flagged advanced/experimental, so this is the special-case path, not the default [10][11].

## 5. Security properties

- **No kernel side-channel.** The ring services WASI ops via the host, not kernel io_uring; the guest never reaches the host kernel, so the native-io_uring sandbox-bypass concern does not apply.
- **Bounds.** Every `buf_ptr`/`buf_len` is validated against the guest’s memory size before the host touches it; a malicious guest handing an out-of-range region gets `-EFAULT`, never a host out-of-bounds.
- **Capabilities, not ambient authority.** A `handle` is usable only if granted; there is no path-walk to anything ungranted, because the only namespace the guest can express is “handles I was given.”
- **Mediation is structural.** The guest cannot disable, inspect, or bypass the drain loop — it is a layer the guest has no handle to. The guest can only emit descriptors; the host alone decides their fate.

## 6. Honest status & limits

- **There is no standard “WASI io_uring.”** WASI and io_uring are orthogonal — one is an *interface* (what ops mean), the other a *transport* (how a request is delivered). This spec delivers WASI ops over an io_uring-shaped transport; the descriptor format and ring layout are **ours to define and version**, not an importable standard.
- **Preview 3 may converge with this.** WASI Preview 3 is slated to add native async (futures/streams) so components pass streaming operations between each other [1][12]; today Preview 2’s mechanism is `wasi:io/poll` over a synchronous core [2][13]. If/when Preview 3 lands, the async-opt-in half of this design should be re-expressed in its terms rather than a bespoke reactor.
- **The async half needs a guest reactor.** Synchronous-over-ring needs nothing of the guest; the batching win does. Whether that is “write it once” or “every guest must cooperate” depends on whether guest code is yours or arbitrary.
- **It only covers what runs inside the unit.** Native tools that shell out do not use this seam; they need the OS-level filesystem path (see the companion Unit Format spec).

## 7. Why this is the right seam

It collapses three things the substrate needed at the guest boundary — fast async I/O, the write-gate, and the capability checkpoint — into **one ring with a validating drain loop**. It aligns with the emerging “split model” for Wasm at the edge: keep protocol termination, routing, auth policy, and capability grants in the **host**, and push deterministic logic into the **component** [14]. The ring is exactly that boundary, made concrete.

-----

## References

1. Bytecode Alliance, *WebAssembly: An Updated Roadmap for Developers* — WASI Poll, native async, Preview 3 streaming. <https://bytecodealliance.org/articles/webassembly-the-updated-roadmap-for-developers>
1. eunomia, *WASI and the WebAssembly Component Model: Current Status* — “as of WASI 0.2 still no native async … from the WASM program’s perspective those calls are synchronous and will block.” <https://eunomia.dev/blog/2025/02/16/wasi-and-the-webassembly-component-model-current-status/>
1. *WebAssembly in 2026 — WASI, Component Model, Runtimes* — “In Preview 2, async I/O works through a polling mechanism (wasi:io/poll).” <https://masturbyte.com/wasm-2026.html>
1. *io_uring_setup(2)* — Linux manual page (SQ/CQ mmap, SQE array). <https://man7.org/linux/man-pages/man2/io_uring_setup.2.html>
1. *io_uring_setup* — Lord of the io_uring (single-mmap rings, separate SQEs). <https://unixism.net/loti/ref-iouring/io_uring_setup.html>
1. *io_uring(7)* — Arch manual (SQE describes the equivalent syscall; one CQE per SQE; `res`). <https://man.archlinux.org/man/io_uring.7.en>
1. *io_uring(7)* — Linux manual page (opcodes; SQE ≈ a syscall). <https://man7.org/linux/man-pages/man7/io_uring.7.html>
1. *The Low-level io_uring Interface* — Lord of the io_uring (`user_data` correlation, any-order completion, `res`, ordering). <https://unixism.net/loti/low_level.html>
1. *What is io_uring?* — Lord of the io_uring (shared buffers → zero-copy; SQ polling avoids the enter syscall). <https://unixism.net/loti/what_is_io_uring.html>
1. *wasmtime::MemoryCreator* — Rust docs (host-managed memory; advanced/experimental). <https://docs.wasmtime.dev/api/wasmtime/trait.MemoryCreator.html>
1. *Zero-Copy GPU Inference from WebAssembly* — MemoryCreator returns your own mmap; `memory.data_ptr()` equals the handed pointer; verified zero-copy. <https://abacusnoir.com/2026/04/18/zero-copy-gpu-inference-from-webassembly-on-apple-silicon/>
1. *wasmtime_wasi_io* — Rust docs (`pollable`, `input-stream`, `output-stream` resources underpinning filesystem/sockets/http). <https://docs.wasmtime.dev/api/wasmtime_wasi_io/index.html>
1. *WebAssembly in 2026* (as [3]) — Preview 2 stable early 2026; poll-based async.
1. *Wasm Components & WASI Preview 3 at the Edge [2026]* — “keep protocol termination, routing, auth policy, and capability grants in the host; push deterministic business logic into the component.” <https://techbytes.app/posts/wasm-components-wasi-preview-3-edge-optimization-2026/>
