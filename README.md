# gitlab-mcp-proxy

A small loopback bridge (one node file, no dependencies) that gives an
opencode session the GitLab MCP server without any credential in config,
environment, or sandbox. Fork of
[`github-mcp-proxy`](https://github.com/code-acrobat/github-mcp-proxy).

```
opencode / omac sandbox
        |  http://127.0.0.1:3720/mcp        (all it can reach)
        v
gitlab-mcp-proxy.mjs  (runs on the HOST)
        |  adds "Authorization: Bearer $(glab config get token)" per request
        v
https://gitlab.com/api/v4/mcp
```

The token comes from `glab` on the host (web login or otherwise), is read at
request time, and is never written to disk or passed into the sandbox.

## Files

| file | what it is |
|------|------------|
| `gitlab-mcp-proxy.mjs` | the proxy: node, no dependencies, listens on `127.0.0.1:3720/mcp` |
| `gitlab-mcp-proxy.sh`  | control script: `up`, `down`, `status` |

## Install

Prerequisites: `node`, and `glab` logged in (`glab auth status` must succeed
on the host).

```sh
cp gitlab-mcp-proxy.mjs gitlab-mcp-proxy.sh ~/.local/bin/
chmod +x ~/.local/bin/gitlab-mcp-proxy.mjs ~/.local/bin/gitlab-mcp-proxy.sh

gitlab-mcp-proxy.sh up        # starts it in the background (nohup)
gitlab-mcp-proxy.sh status    # prints pid + probes the port (exit 1 = down)
gitlab-mcp-proxy.sh down
```

Log: `/tmp/opencode/gitlab-mcp-proxy.log` (startup lines only). Started by
hand on purpose: no systemd unit, it dies on reboot or logout, so run `up`
again after one.

Self-managed GitLab: point the proxy at your instance before starting it —
`GITLAB_MCP_URL=https://gitlab.example.com/api/v4/mcp gitlab-mcp-proxy.sh up`
(the `glab` token is then looked up for that host too).

Quick check:

```sh
curl -s -X POST http://127.0.0.1:3720/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# 200 with a JSON-RPC result          = everything works
# 403 "MCP server not enabled ..."    = proxy + token work, GitLab-side gate (see below)
# 401                                 = token rejected
# 502 "token lookup failed: ..."      = glab is not logged in on the host
```

## GitLab-side gate

The endpoint authenticates the token first, then checks a feature gate: if it
answers `403 "MCP server not enabled for any of your groups"`, the proxy is
fine and GitLab is not. Per the
[GitLab MCP docs](https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/),
your top-level group (or instance) needs GitLab Duo set to always on /
on by default, beta and experimental features allowed, and MCP server access
explicitly granted.

Note: the endpoint takes `Authorization: Bearer` only; the `PRIVATE-TOKEN`
header gets 401. The token is whatever `glab` holds, web-login OAuth or PAT
alike (`glab config get token -h <host>`, where `-h` is the hostname flag in
glab 1.36).

## Configure opencode.json

Disabled by default — enable it where you actually work on GitLab:

```json
"mcp": {
  "gitlab": {
    "type": "remote",
    "url": "http://127.0.0.1:3720/mcp",
    "enabled": false
  }
}
```

This is the entry in the standard user config `~/.config/opencode/opencode.json`.
No headers, no token, no OAuth: the URL is the whole entry. Flip `enabled` to
`true` when the proxy is up (per project if you prefer, see the
github-mcp-proxy README for that discussion).

## Making it reachable in omac (port forwarding)

The sandbox is network-filtered. The grant the loopback port needs is in the
machine policy `~/.config/omac/sandbox-profiles/default.json`:

```json
"network": {
  "open_port": [3720],
  "mode": "filtered"
}
```

`open_port` is the omac equivalent of a forwarded port: the sandboxed process
may connect to `127.0.0.1:3720` and nothing else on that port's terms.

## Why the session cannot use `glab` directly

1. **No credential in the sandbox.** `glab` keeps its token in
   `~/.config/glab-cli/config.yml`, which is not granted to the sandbox, and
   no `GITLAB_TOKEN`/`GLAB_TOKEN` is in `environment.allow_vars`.
2. **No network to GitLab.** `network.mode: filtered`; `gitlab.com` is not in
   `allow_domain`, so direct API calls are denied.
3. **No OAuth workaround.** An interactive `mcp auth` flow cannot complete in
   the sandbox (the callback server may not bind an OS-assigned port).

So the session reaches `127.0.0.1:3720` only, and the token is injected on
the host side, per request, where `glab` lives.

## Security notes

Same model as github-mcp-proxy, port 3720:

- Token read from host `glab` per request: never on disk, never in config,
  environment, or the sandbox.
- **The port is open to everything on this machine.** No authentication on
  `127.0.0.1:3720`: any process running as you can act with your GitLab
  identity. Requests carrying a browser `Origin` or `Sec-Fetch-Site` header
  are rejected with 403; that is header sniffing, not real authentication.
- Single-user machine assumption; do not run on shared hosts.
- The proxy runs with your privileges and calls `glab` from `PATH`. Only start
  it from a shell you trust.
- No rate or size limits; failure replies can contain `glab` error text.
- Kill switch: `gitlab-mcp-proxy.sh down` fails every GitLab tool closed
  (connection refused) for all sessions at once; a nested omac session cannot
  undo it (no token material inside the sandbox), anything outside a sandbox
  can.

In short: every MCP client you point at this port holds your GitLab identity
while it is connected. Keep that set small, keep the window short.

## Production safeguards

A hobby setup is one personal token and one human at the keyboard. For
production projects, keep a human approving each next step instead of
building hard tool denials:

- **Ask is already the default.** opencode asks before a tool runs when no
  permission rule matches, so no `permissions` block is needed: every
  create, merge, or push call waits for you. Prefer staying on `ask` over
  `deny` rules as long as a human approves the next step; add a deny only
  for something nobody should ever run.
- **Keep merge rights on the forge, not in the client.** On GitLab:
  protected branch `main` with "Allowed to merge" set to maintainers while
  the token behind the proxy stays a project access token with the
  Developer role, merge request approvals with "prevent approval by
  author", and merge checks requiring a successful pipeline. These hold
  even when an `ask` is clicked through without much thought.
- **Skip draft-only rules; keep CI in the loop.** Draft MRs often sit
  outside the pipeline checks that should pass before a human reviewer is
  bothered. Open a real MR, let CI go green, and state "human review
  required" in the description instead.
- **Token scope is the ceiling.** The OAuth token behind `glab` carries
  your full role on every project you can access. For production use a
  project access token with the Developer role scoped to the project;
  everything above narrows who may merge, not what the token can do
  elsewhere.

## Scope and maturity

Deliberately minimal, same as its sibling: no version pinning (whatever
`node` and `glab` are on your `PATH`), no update checks or releases (`git
pull` is the upgrade path), no CI/CD, no auto-restart, no npm package.

## License

[MIT](./LICENSE) — free to use, copy, modify, merge, publish, distribute;
without warranty.
