# MCP Proxy Server design notes (internal)

This directory holds design documentation written in SEP format about
shape changes cloister thinks could benefit the
[Model Context Protocol](https://modelcontextprotocol.io). These are
**internal design notes**, not submissions in flight.

The MCP SEP process explicitly says cold spec drops don't work:
protocol changes derive from working-group discussion, sponsor
review, and community consensus — see
[modelcontextprotocol.io/community/sep-guidelines](https://modelcontextprotocol.io/community/sep-guidelines).
Cloister respects that. The drafts here exist so the design rationale
survives in the repo if the conversation later becomes useful, not as
a queue waiting to be submitted.

The SEP-format structure (preamble / abstract / motivation / spec /
rationale / backward compatibility / reference implementation /
security implications) is used as a discipline for thinking, not as
an implicit claim that the upstream MCP project is obligated to read
these.

## Current drafts

| Draft | What it covers |
|---|---|
| [SEP-XXXX: Formalize MCP Proxy Server as a First-Class Type](SEP-XXXX-mcp-proxy-server-formalization.md) | The "MCP Proxy Server" pattern is named in the Security Best Practices spec but not modeled at the data layer. Note describes what a `proxy` capability + `proxy/upstreams` introspection RPC could look like. Cloister implements this shape as a working prototype. |

## If a draft here ever becomes relevant upstream

The proper path (per the SEP guidelines):

1. Discuss the idea in the relevant MCP Discord working/interest group
   (or `#general` if no relevant group exists)
2. Refine based on that discussion
3. Find a sponsor (Core Maintainer or Maintainer)
4. Submit the PR with the sponsor's blessing

A draft here is not a substitute for any of those steps. If the
community converges on something cloister already documented, the
draft becomes useful input; otherwise it's just historical record of
how cloister thought about the problem.
