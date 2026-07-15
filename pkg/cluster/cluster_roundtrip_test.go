// Round-trip gate for the schema-bridge Go emitter.
//
// Invoke via `task cluster:go:verify`, which runs
// `scripts/verify-go.sh` — that script dumps the
// canonical cluster const (src/generated/cluster.ts → JSON) to a
// tmpfile, sets CLUSTER_JSON_PATH, and runs `go test` here. Direct
// `go test` invocations without the env var skip cleanly so this
// file doesn't break stray `go test ./...` runs.
//
// What it gates:
//   - The emitted Go types accept the canonical cluster JSON without
//     unmarshal errors (catches schema-bridge regressions like a
//     missing field, wrong type, or mismatched JSON tag).
//   - Spot-check invariants on the unmarshaled value (catches the
//     "unmarshal succeeds but a field is silently zero-valued"
//     class of bugs that loose typing would mask).
//   - Go ↔ JSON ↔ Go round-trip preserves the value (catches
//     emitter regressions that would lose data on re-marshal).
//
// What it does NOT gate (yet):
//   - Byte-identical JSON between Go's encoder output and capnp's
//     canonical JSON convention. Bead cloister-765d83 (C) adds
//     MarshalJSON/MarshalCBOR that produce canonical bytes; this
//     test will tighten then.

package cluster_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/agentic-research/cloister/pkg/cluster"
)

func TestClusterRoundTrip(t *testing.T) {
	path := os.Getenv("CLUSTER_JSON_PATH")
	if path == "" {
		t.Skip("CLUSTER_JSON_PATH not set — invoke via `task cluster:go:verify`")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read CLUSTER_JSON_PATH=%q: %v", path, err)
	}

	var first cluster.Cluster
	if err := json.Unmarshal(raw, &first); err != nil {
		t.Fatalf("unmarshal cluster.json into generated types: %v", err)
	}

	// Spot-checks against known cluster.toml content. These would
	// silently zero-value if schema-bridge regressed on a field's
	// JSON tag or type.
	if first.Metadata.Name == "" {
		t.Error("cluster.metadata.name lost in unmarshal — schema-bridge JSON-tag regression?")
	}
	if first.Metadata.Version == "" {
		t.Error("cluster.metadata.version lost in unmarshal")
	}
	if len(first.Bundles) == 0 {
		t.Fatal("cluster.bundles empty after unmarshal — list field broken?")
	}
	if len(first.Wires) == 0 {
		t.Fatal("cluster.wires empty after unmarshal")
	}

	// Every bundle must have either a populated workerd OR external
	// kind. Both nil would mean the nested-union form emitted by the
	// zod side was lost — exactly the regression D guards against.
	for i, b := range first.Bundles {
		if b.Name == "" {
			t.Errorf("bundles[%d].name empty after unmarshal", i)
		}
		if b.Kind.Workerd == nil && b.Kind.External == nil {
			t.Errorf("bundles[%d] (%s): neither Kind.Workerd nor Kind.External populated; union shape broken", i, b.Name)
		}
	}

	// Void-variant round-trip — Wire.transport unions use `*struct{}`
	// pointers, and capnp's JSON encoding is `{"variant":null}`.
	// Without C's custom (Un)MarshalJSON, the default Go decoder
	// would treat `null` as "set the pointer to nil" — losing the
	// variant selection silently. Guard: every wire must have
	// EXACTLY ONE Transport variant populated after unmarshal.
	for i, w := range first.Wires {
		set := 0
		if w.Transport.Uds != nil {
			set++
		}
		if w.Transport.LeylineNet != nil {
			set++
		}
		if set != 1 {
			t.Errorf(
				"wires[%d] (%s→%s): Transport must have exactly one variant populated after unmarshal, got %d (Uds=%v LeylineNet=%v) — Void-variant marshaler broken (cloister-765d83)",
				i, w.From, w.To, set, w.Transport.Uds, w.Transport.LeylineNet,
			)
		}
	}

	// Go ↔ JSON ↔ Go round-trip must converge. Two unmarshals
	// bracketed by one marshal: if the emitter drops a field on
	// marshal (e.g. unexported, missing tag), the second value
	// diverges from the first.
	roundtripped, err := json.Marshal(first)
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	var second cluster.Cluster
	if err := json.Unmarshal(roundtripped, &second); err != nil {
		t.Fatalf("re-unmarshal: %v\nroundtripped JSON:\n%s", err, roundtripped)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("Go ↔ JSON ↔ Go round-trip lost data:\nfirst:  %+v\nsecond: %+v", first, second)
	}
}
