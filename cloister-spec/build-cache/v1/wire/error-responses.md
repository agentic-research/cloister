# Wire — error responses

Errors specific to `build-cache/v1`. Shared OCI errors (auth, generic
404, generic 5xx) are inherited from the OCI Distribution Spec §3.

All errors follow the OCI `errors` envelope:

```json
{
  "errors": [
    {
      "code": "<UPPER_SNAKE>",
      "message": "<human-readable>",
      "detail": { ... }
    }
  ]
}
```

## Error codes defined by this v1

### `BLOB_DIGEST_MISMATCH` (400 Bad Request)

Returned by the provider when a PUT blob's bytes hash to something
other than the URL's `?digest=` parameter. The producer is buggy or
mid-corruption.

```json
{
  "errors": [
    {
      "code": "BLOB_DIGEST_MISMATCH",
      "message": "uploaded bytes hash to <actual>, but URL claims <claimed>",
      "detail": {
        "claimed": "sha256:abc...",
        "actual": "sha256:def..."
      }
    }
  ]
}
```

### `MANIFEST_MEDIATYPE_REFUSED` (415 Unsupported Media Type)

Provider returns this if a manifest PUT has a `mediaType` it doesn't
recognize. Specifically, if a producer tries to push a
`build-cache/v2` manifest to a `v1`-only provider.

### `MANIFEST_CONFIG_MISSING` (400 Bad Request)

Manifest PUT references a `config.digest` that the provider hasn't
seen. Producer must push the config blob FIRST, then the manifest.

```json
{
  "errors": [
    {
      "code": "MANIFEST_CONFIG_MISSING",
      "message": "manifest references config <digest> which is not in this registry",
      "detail": { "digest": "sha256:abc..." }
    }
  ]
}
```

### `MANIFEST_LAYER_MISSING` (400 Bad Request)

Same as `MANIFEST_CONFIG_MISSING` but for a layer. Returned per
missing layer (provider MAY return multiple errors in the envelope).

### `BLOB_TOO_LARGE` (413 Payload Too Large)

A single blob exceeds the provider's max size. v1 doesn't specify a
minimum supported size; conformance vectors stay well under 1 MiB.
Providers that impose a limit MUST document it via this code.

### `TAG_CONFLICT` (409 Conflict)

A tag PUT arrived while another writer's tag PUT was in flight, AND
the provider's policy is "first writer wins" rather than "last
writer wins." cloister-oci and r2-direct default to last-writer-wins
(no 409); fs-local with a lockfile MAY return 409.

## Error code that this v1 does NOT define

`UNAUTHORIZED` and `DENIED` (auth failures) — these are OCI standard;
this v1 doesn't redefine them.

`BLOB_UNKNOWN` and `MANIFEST_UNKNOWN` — also OCI standard for 404.
Consumers MUST be prepared for either the OCI standard code OR a
plain 404 with no body; some providers (esp. fs-local) may not bother
populating the error envelope on missing-blob GETs.

## Conformance

A conformant provider:

- Returns one of the OCI standard codes OR one of the codes defined
  here for each documented failure mode.
- Returns the `errors` envelope shape (or empty body for 404).
- Does NOT silently corrupt — every error mode listed here is a HARD
  fail with an explicit code, not a partial / lossy response.

A conformant consumer:

- Reads `errors[0].code` and branches on the documented codes.
- Treats unknown codes as "unspecified protocol error" and refuses
  to proceed — does NOT silently retry as if the operation succeeded.
