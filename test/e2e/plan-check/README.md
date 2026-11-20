# plan-check fixtures

The CI job `plan-check-action` runs `actions/plan-check` against the sample
plan `test/fixtures/terraform/kubernetes-plan.show.json` with each directory
here:

- `matches/cluster.toml` is drafted from that plan by `cloister inspect
  --draft --env prod --name plan-check`, unedited. The check must pass.
- `undeclared/cluster.toml` is the same file without `probe`'s connection to
  `server` and the env row that names it. The plan still makes that call, so
  the check must fail.
