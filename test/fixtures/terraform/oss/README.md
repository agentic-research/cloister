# Open-source plan fixtures

`jsr-plan.show.json` is a trimmed `tofu show -json` of an offline plan of the
`terraform/` directory of https://github.com/jsr-io/jsr at commit
`1624825e0783b6921e99693e10e30ae67b44119b`.

- License: MIT. Copyright 2024 the JSR authors.
- The plan was produced offline with placeholder credentials; nothing was
  applied and no account was contacted.
- Trimmed with `node scripts/trim-plan-fixture.mjs <plan.show.json> <out.json>`:
  it keeps `format_version`, the `planned_values` resources of mapped types with
  only their mapped attributes (and matching `sensitive_values` entries), and the
  root-module `configuration` references for the mapped `referenceAttrs`. Output
  has sorted keys. Everything else is dropped.

Unlike `../cloudflare-state.show.json`, this file is real public data, not a
synthetic fixture.
