# AGENTS.md — gitlab-mcp-proxy

Loopback policy proxy in front of the GitLab MCP endpoint. A fork of
`github-mcp-proxy`; same request-handling discipline, GitLab-specific
token and target. Read the github-mcp-proxy AGENTS.md for the shared
rationale; this file records only what differs.

## Repo map

- `gitlab-mcp-proxy.mjs` — the proxy (node >= 18, zero deps).
- `gitlab-mcp-proxy.sh` — `up` / `down` / `status` (anchored `pid()`).
- `gitlab-mcp-proxy.rules.json` — deny_tools / deny_calls (currently empty;
  the GitLab endpoint is 403-gated until MCP is enabled for a group, so no
  tools have been captured yet).
- `tests/smoke.sh` — offline request-side policy smoke test (no network).

## Invariants (do not regress)

- **Request flow:** buffer body -> browser guard (`Origin` or
  `Sec-Fetch-Site` -> 403) -> JSON parse -> policy check -> inject
  `Authorization: Bearer $(glab config get token -h <host>)` -> forward raw.
  SSE responses stream unbuffered. Blocked calls get a local `200`
  JSON-RPC error (`-32000`) and never reach upstream.
- **Batches and unparseable bodies fail closed** (same as the siblings);
  the empty-body `GET` (SSE) still forwards.
- **Token is Bearer-only.** GitLab's MCP endpoint rejects `PRIVATE-TOKEN`
  with a 401; the proxy strips any inbound `PRIVATE-TOKEN` and injects
  `Authorization: Bearer`. Token comes from `glab` on the host, never the
  sandbox.
- **`PORT` and `GITLAB_MCP_URL` are env-overridable** (`PORT` default 3721;
  `GITLAB_MCP_URL` default `https://gitlab.com/api/v4/mcp`). Override the
  URL for self-managed GitLab.
- **Rules load once at startup** (edit file, then `down` + `up`). Missing
  rules file = forward everything; malformed entries dropped and logged.
- **`pid()` in the control script is anchored** on
  `^(.*/)?node [^ ]*/gitlab-mcp-proxy\.mjs$` — keep it exact.

## Filling rules (blocked on the feature gate)

The GitLab.com MCP endpoint currently answers
`403 Forbidden - MCP server not enabled for any of your groups`. Until MCP
is enabled for a group and `tools/list` answers:

- Leave `gitlab-mcp-proxy.rules.json` empty (forward-all). Do not invent
  tool names — a deny rule that names a nonexistent tool silently never
  matches.
- When the gate lifts: run the proxy live, `initialize` + `tools/list`
  through it, normalize the tool list, write the first deny rules against
  what is actually exposed, and record the endpoint version in the rules
  `schema` field. Mirror the github skill + `validate.sh` flow then.

## Verify

```
node --check gitlab-mcp-proxy.mjs
sh tests/smoke.sh
```
