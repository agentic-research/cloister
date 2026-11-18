# `gen/`: generators and build steps

Each file writes a file that is committed or built: the typed manifest, tool
schemas, the published `cluster.toml` schema, the ADR index, the CLI
reference, the provider spec projections, wire fixtures.

[`Taskfile.yml`](../Taskfile.yml) names the task that runs each one. Where the
output is committed, a `:check` or `:check-drift` task in `task lint` fails
when the committed file is stale.

`gen/lib/` holds what the generators share. Tests are in [`gen/test/`](test/).
