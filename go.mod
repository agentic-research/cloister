// Module declaration so the schema-bridge-go output at pkg/cluster/
// can compile + be verified. Stdlib-only — no third-party deps.
// Added by cloister-76a9ea (ADR-0036 Phase 1 piece D); kept minimal
// because the Go output is consumed by external repos (signet, mache,
// notme) under their own module paths, not from inside cloister.
module github.com/agentic-research/cloister

go 1.21
