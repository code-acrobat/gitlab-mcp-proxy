#!/usr/bin/env node
// GitLab MCP -> loopback bridge (fork of github-mcp-proxy).
// Token stays on the host (glab web-login config); the omac sandbox only
// ever sees http://127.0.0.1:3720/mcp and never the credential.
// ponytail: plain nohup start; promote to a systemd user unit if it must survive reboots.
import http from "node:http"
import https from "node:https"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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

// Call rules, read once at start (edit file, then down + up to apply).
// Missing file = no rules = forward everything (forward-compat with older
// installs). Entries must be {tool: string, if?: object, reason?: string};
// `schema` records what upstream the rules were written against so a rule
// from the wrong generation gets spotted instead of silently never matching.
let denyCalls = []
const denyTools = new Set()
try {
  const cfg = JSON.parse(readFileSync(join(import.meta.dirname, "gitlab-mcp-proxy.rules.json"), "utf8"))
  const all = cfg.deny_calls ?? []
  denyCalls = all.filter((d) => typeof d?.tool === "string" && (d.if == null || typeof d.if === "object"))
  if (denyCalls.length < all.length) console.error(`rules: dropped ${all.length - denyCalls.length} malformed deny_calls entries`)
  const toolList = cfg.deny_tools ?? []
  for (const t of toolList) {
    if (typeof t === "string") denyTools.add(t)
    else console.error("rules: dropped malformed deny_tools entry")
  }
  if (denyCalls.length || denyTools.size)
    console.log(
      `rules: ${denyTools.size} deny_tools, ${denyCalls.length} deny_calls active (schema ${cfg.schema ?? "unspecified"})`,
    )
} catch (e) {
  if (e.code !== "ENOENT") console.error(`rules unusable (${e.message}); forwarding all calls`)
}

// ponytail: exact match on the listed arg pairs only; add a `missing:` check when a rule needs absence
const blockedReason = (body) => {
  if (body?.method !== "tools/call") return null
  const name = body?.params?.name
  if (denyTools.has(name)) return `denied ${name}`
  const args = body?.params?.arguments
  for (const r of denyCalls) {
    if (r.tool !== name) continue
    if (r.if && !Object.entries(r.if).every(([k, v]) => args?.[k] === v)) continue
    return r.reason || `denied ${r.tool}`
  }
  return null
}

http.createServer((req, res) => {
  // Browsers are not clients here: block requests carrying fetch metadata.
  if (req.headers.origin || req.headers["sec-fetch-site"]) {
    res.writeHead(403, { "content-type": "text/plain" })
    res.end("browser requests are not allowed")
    return
  }
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const raw = Buffer.concat(chunks)
    // Buffer requests only so tools/call can be ruled on; forward raw bytes.
    // ponytail: JSON-RPC batches and unparseable bodies pass through untouched
    let reason = null
    let id = null
    try {
      const body = JSON.parse(raw)
      if (!Array.isArray(body)) {
        reason = blockedReason(body)
        id = body?.id ?? null
      }
    } catch {}
    if (reason) {
      console.log(`${new Date().toISOString()} blocked tools/call: ${reason}`)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `blocked by gitlab-mcp-proxy policy: ${reason}` },
        }),
      )
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
    up.end(raw)
  })
}).listen(PORT, "127.0.0.1", () => {
  console.log(`gitlab mcp proxy on 127.0.0.1:${PORT} -> ${TARGET.href}`)
})
