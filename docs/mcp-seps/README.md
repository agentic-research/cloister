# MCP Specification Enhancement Proposals (SEPs) drafted in cloister

This directory holds draft Specification Enhancement Proposals against the
[Model Context Protocol](https://modelcontextprotocol.io) that cloister
intends to submit upstream. Each draft lives here until it has a sponsor
(a Core Maintainer of the MCP spec repository); at that point the PR is
opened against [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)
and the file gets renumbered using the assigned PR number.

The cloister repo carries these drafts because:

1. **Cloister is the reference implementation** for proposals about MCP
   Proxy Servers, gateway aggregation, and private-registry alignment.
   Keeping the draft text next to the implementation makes both easier
   to audit.
2. **Drafts iterate in PRs against this repo first** before they're
   submitted upstream — sponsor review is faster when there's working
   code, tests, and a reasoned ADR backing the proposal.
3. **Final / merged SEPs in the official repo** supersede the drafts
   here. Once a SEP reaches `final` status upstream, the local draft
   is deleted and replaced with a brief pointer to the upstream URL.

## Current drafts

| Draft | Status | Notes |
|---|---|---|
| [SEP-XXXX: Formalize MCP Proxy Server as a First-Class Type](SEP-XXXX-mcp-proxy-server-formalization.md) | Draft, no sponsor yet | Formalizes the "MCP Proxy Server" pattern named in the Security Best Practices spec as a data-layer capability with normative obligations + introspection RPC. Cloister is the reference implementation. |

## Process notes

The MCP SEP process is documented at
[modelcontextprotocol.io/community/sep-guidelines](https://modelcontextprotocol.io/community/sep-guidelines).
Drafts here follow that format:

1. Preamble (front-matter table)
2. Abstract (~200 words)
3. Motivation
4. Specification (normative, using RFC 2119 MUST/SHOULD/MAY)
5. Rationale (alternates considered, why this design)
6. Backward Compatibility
7. Reference Implementation
8. Security Implications

A SEP is only ready to submit upstream once:

- A reference implementation exists and is testable (cloister fits).
- A sponsor (Core Maintainer of the MCP spec repo) has agreed to champion it.
- Community discussion (Discord working group, GitHub Discussion) has
  surfaced and addressed the major objections.
