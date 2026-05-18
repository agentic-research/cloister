"""The five credential-injection strategies.

Each strategy takes (skill_request, credential_value, strategy_param) and
returns the upstream request shape: (upstream_url, upstream_headers,
upstream_body). The proxy materializes that into a real outbound request.

Per cloister-spec/credential-isolation/v1/README.md §"Injection strategies":

| Strategy | Wire transformation |
|---|---|
| authorizationBearer | adds `Authorization: Bearer <secret>` |
| authorizationBasic  | adds `Authorization: Basic <b64(user:secret)>` |
| headerNamed         | adds `<name>: <secret>` |
| queryParam          | appends `?<name>=<urlencoded(secret)>` |
| bodyField           | sets JSON body field at JSONPath to <secret> |

The union is closed. New strategies require a spec extension + a new
conformance vector. No raw shell-out or arbitrary template strategy ever.
"""

from __future__ import annotations

import base64
import json
import urllib.parse
from dataclasses import dataclass


@dataclass(frozen=True)
class SkillRequest:
    """Inputs the skill produced — what the caller sent through cloister."""
    method: str
    upstream_path: str   # e.g. "v1/chat/completions" — no leading slash
    query: str           # raw query string ("a=1&b=2") or "" if none
    headers: dict[str, str]
    body: str            # request body as a UTF-8 string (may be "")


@dataclass(frozen=True)
class UpstreamRequest:
    """Outputs the proxy will send to upstream."""
    method: str
    url: str             # full upstream URL with any added query params
    headers: dict[str, str]
    body: str


def _join_upstream(base_url: str, path: str, query: str) -> str:
    """Join upstream base + path + query into a full URL.

    base_url comes from manifest (e.g. "https://api.openai.com"); path
    is the per-call upstream path (e.g. "v1/chat/completions"). We
    explicitly DO NOT use urljoin — its leading-slash behavior is
    surprising and we want the spec to be operational, not heuristic.
    """
    base = base_url.rstrip("/")
    p = path.lstrip("/")
    sep = "?" if query else ""
    return f"{base}/{p}{sep}{query}"


# ── strategy: authorizationBearer ───────────────────────────────────────

def inject_authorization_bearer(
    req: SkillRequest, credential: str, upstream_base: str,
) -> UpstreamRequest:
    """Adds `Authorization: Bearer <secret>` to the outbound headers."""
    headers = dict(req.headers)
    headers["Authorization"] = f"Bearer {credential}"
    return UpstreamRequest(
        method=req.method,
        url=_join_upstream(upstream_base, req.upstream_path, req.query),
        headers=headers,
        body=req.body,
    )


# ── strategy: authorizationBasic ────────────────────────────────────────

def inject_authorization_basic(
    req: SkillRequest, credential: str, upstream_base: str,
    *, basic_user: str,
) -> UpstreamRequest:
    """Adds `Authorization: Basic <b64(user:secret)>`.

    `basic_user` comes from credential metadata; the credential itself is
    the password half. base64 is standard b64 with padding per RFC 7617.
    """
    raw = f"{basic_user}:{credential}".encode("utf-8")
    b64 = base64.b64encode(raw).decode("ascii")
    headers = dict(req.headers)
    headers["Authorization"] = f"Basic {b64}"
    return UpstreamRequest(
        method=req.method,
        url=_join_upstream(upstream_base, req.upstream_path, req.query),
        headers=headers,
        body=req.body,
    )


# ── strategy: headerNamed ───────────────────────────────────────────────

def inject_header_named(
    req: SkillRequest, credential: str, upstream_base: str,
    *, header_name: str,
) -> UpstreamRequest:
    """Adds `<header_name>: <secret>` to outbound headers verbatim.

    The header name is taken from the manifest entry; the proxy MUST NOT
    URL-encode or otherwise transform it. Existing skill-supplied headers
    of the same name are overwritten (vault-injected value wins).
    """
    headers = dict(req.headers)
    headers[header_name] = credential
    return UpstreamRequest(
        method=req.method,
        url=_join_upstream(upstream_base, req.upstream_path, req.query),
        headers=headers,
        body=req.body,
    )


# ── strategy: queryParam ────────────────────────────────────────────────

def inject_query_param(
    req: SkillRequest, credential: str, upstream_base: str,
    *, param_name: str,
) -> UpstreamRequest:
    """Appends `?<param_name>=<urlencoded(secret)>` to the upstream URL.

    Existing query string is preserved verbatim; the credential param is
    appended with a `&` separator if a query string already exists.
    Per spec: operators MUST NOT use queryParam when the skill itself
    already sets the same param (collision is implementation-defined).
    """
    encoded_secret = urllib.parse.quote(credential, safe="")
    cred_pair = f"{param_name}={encoded_secret}"
    if req.query:
        merged_query = f"{req.query}&{cred_pair}"
    else:
        merged_query = cred_pair
    return UpstreamRequest(
        method=req.method,
        url=_join_upstream(upstream_base, req.upstream_path, merged_query),
        headers=dict(req.headers),
        body=req.body,
    )


# ── strategy: bodyField ─────────────────────────────────────────────────

def _set_json_path(doc: dict, path: str, value: object) -> dict:
    """Set `value` at a dotted JSONPath (`a.b.c`) on `doc`, creating
    intermediate dicts as needed. Returns the doc for chaining.

    JSONPath subset:
      - dotted keys only ("client_secret", "auth.token")
      - no list indices, no wildcards, no filter expressions
    The closed JSONPath grammar is part of v1's "no shell-out, no
    arbitrary template" property.
    """
    if "." not in path:
        doc[path] = value
        return doc
    head, _, tail = path.partition(".")
    sub = doc.get(head)
    if not isinstance(sub, dict):
        sub = {}
        doc[head] = sub
    _set_json_path(sub, tail, value)
    return doc


def inject_body_field(
    req: SkillRequest, credential: str, upstream_base: str,
    *, json_path: str,
) -> UpstreamRequest:
    """Merges `<credential>` into the JSON body at the named JSONPath.

    Body MUST be valid JSON (decode-able); proxy rejects non-JSON bodies
    when the strategy is bodyField (per spec). The merged JSON is
    re-serialized with `separators=(",", ":")` for byte stability across
    implementations — the same canonicalization the wire spec uses.
    """
    doc = json.loads(req.body) if req.body else {}
    if not isinstance(doc, dict):
        raise ValueError(
            f"bodyField requires a JSON object body; got {type(doc).__name__}"
        )
    _set_json_path(doc, json_path, credential)
    merged = json.dumps(doc, separators=(",", ":"), sort_keys=True)
    return UpstreamRequest(
        method=req.method,
        url=_join_upstream(upstream_base, req.upstream_path, req.query),
        headers=dict(req.headers),
        body=merged,
    )


# ── dispatcher ──────────────────────────────────────────────────────────

STRATEGY_DISPATCH = {
    "authorizationBearer": inject_authorization_bearer,
    "authorizationBasic": inject_authorization_basic,
    "headerNamed": inject_header_named,
    "queryParam": inject_query_param,
    "bodyField": inject_body_field,
}
"""The closed strategy union. Used by the conformance runner to dispatch
test-vector cases by their `strategy` field."""
