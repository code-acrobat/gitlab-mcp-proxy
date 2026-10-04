#!/usr/bin/env node
// GitLab MCP -> loopback bridge (fork of github-mcp-proxy).
// Token stays on the host (glab web-login config); the omac sandbox only
// ever sees http://127.0.0.1:3720/mcp and never the credential.
// ponytail: plain nohup start; promote to a systemd user unit if it must survive reboots.
import http from "node:http"
import https from "node:https"
import { execFileSync } from "node:child_process"

const PORT = 3720
// Override for self-managed: GITLAB_MCP_URL=https://gitlab.example.com/api/v4/mcp
const TARGET = new URL(process.env.GITLAB_MCP_URL || "https://gitlab.com/api/v4/mcp")
const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
])

const token = () =>
  execFileSync("glab", ["config", "get", "token", "-h", TARGET.hostname], { encoding: "utf8" }).trim()

http.createServer((req, res) => {
  // Browsers are not clients here: block requests carrying fetch metadata.
  if (req.headers.origin || req.headers["sec-fetch-site"]) {
    res.writeHead(403, { "content-type": "text/plain" })
    res.end("browser requests are not allowed")
    return
  }
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase()
    if (key === "host" || key === "authorization" || key === "private-token" || HOP.has(key)) continue
    headers[k] = v
  }
  try {
    // GitLab's MCP endpoint takes Authorization: Bearer only (PRIVATE-TOKEN -> 401).
    headers.authorization = `Bearer ${token()}`
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end(`token lookup failed: ${e.message}`)
    return
  }
  headers["user-agent"] = "gitlab-mcp-proxy"

  const up = https.request(
    {
      hostname: TARGET.hostname,
      port: 443,
      path: TARGET.pathname + TARGET.search,
      method: req.method,
      headers,
    },
    (ures) => {
      const rh = {}
      for (const [k, v] of Object.entries(ures.headers)) {
        if (!HOP.has(k.toLowerCase())) rh[k] = v
      }
      res.writeHead(ures.statusCode ?? 502, rh)
      ures.pipe(res) // streams SSE; never buffer
    },
  )
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
    res.end(String(e))
  })
  req.pipe(up)
}).listen(PORT, "127.0.0.1", () => {
  console.log(`gitlab mcp proxy on 127.0.0.1:${PORT} -> ${TARGET.href}`)
})
