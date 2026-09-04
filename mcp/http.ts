/**
 * Network entry point: MCP over Streamable HTTP, for a phone or any remote
 * client to reach a server you deployed.
 *
 * This endpoint spends real money — every call burns Anlas from the configured
 * account — so MCP_AUTH_TOKEN is mandatory and the process refuses to start
 * without it. An open endpoint would be someone else's free image generator.
 *
 * It speaks plain HTTP. Put it behind a TLS-terminating reverse proxy on
 * anything public: without TLS the bearer token and every prompt cross the
 * network in the clear.
 *
 *   NOVELAI_TOKEN      required, the pst- token
 *   MCP_AUTH_TOKEN     required, the shared secret clients must present
 *   PORT               default 8787
 *   HOST               default 0.0.0.0
 *   NOVELAI_PUBLIC_URL optional, e.g. https://nai.example.com — enables image links
 *   NOVELAI_OUTPUT_DIR optional, where PNGs are written and served from
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { timingSafeEqual } from "node:crypto"

import { buildServer } from "./tools"

const AUTH = (process.env.MCP_AUTH_TOKEN ?? "").trim()
if (!AUTH) {
  console.error(
    "MCP_AUTH_TOKEN 没有设置。这个端点会消耗你账户的 Anlas，不允许无认证启动。\n" +
      "生成一个：openssl rand -hex 32",
  )
  process.exit(1)
}
// Deliberately NOT fatal, unlike MCP_AUTH_TOKEN above.
//
// Starting without the auth secret would expose a money-spending endpoint, so
// that one has to stop the process. A missing NovelAI token only means
// generation fails, and token() already says so clearly on each call. Exiting
// for it turned one mistyped value into a crash loop that took the whole
// service down — the one thing a bad paste must not be able to do.
if (!(process.env.NOVELAI_TOKEN ?? "").trim()) {
  console.warn("NOVELAI_TOKEN 未设置：服务照常启动，但生图会失败。")
}

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? "0.0.0.0"
const OUTPUT_DIR =
  process.env.NOVELAI_OUTPUT_DIR?.trim() || join(homedir(), "Pictures", "NovelAI")
mkdirSync(OUTPUT_DIR, { recursive: true })

/** Constant-time compare, so the secret cannot be guessed a byte at a time. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  const a = Buffer.from(presented)
  const b = Buffer.from(AUTH)
  return a.length === b.length && timingSafeEqual(a, b)
}

function deny(res: ServerResponse) {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="novelai-mcp"',
  })
  res.end(JSON.stringify({ error: "unauthorized" }))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return undefined
  }
}

/** Serve a generated PNG, so a client can show it by URL instead of base64. */
function serveImage(name: string, res: ServerResponse) {
  // basename() is the path-traversal guard: no directory part survives it.
  const clean = basename(decodeURIComponent(name))
  // Only names this server generated, so the unguessable suffix is mandatory
  // rather than incidental.
  if (!/^nai_\d{8}_\d{6}_\d+_[0-9a-f]{16}\.png$/.test(clean)) {
    res.writeHead(404).end("not found")
    return
  }
  const file = join(OUTPUT_DIR, clean)
  if (!existsSync(file)) {
    res.writeHead(404).end("not found")
    return
  }
  res.writeHead(200, {
    "content-type": "image/png",
    "content-length": String(statSync(file).size),
    "cache-control": "private, max-age=86400",
  })
  createReadStream(file).pipe(res)
}

const http = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost")

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // Images are served without the bearer header on purpose: a chat client
    // rendering <img> or markdown cannot attach one, so requiring it meant the
    // picture never displayed. The filename carries 8 random bytes and the
    // pattern below is enforced, so the URL is the capability.
    if (url.pathname.startsWith("/images/")) {
      serveImage(url.pathname.slice("/images/".length), res)
      return
    }

    if (!authorized(req)) {
      deny(res)
      return
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("not found")
      return
    }

    // A fresh server and transport per request: stateless mode keeps no session
    // state, and sharing one transport across concurrent calls would let two
    // requests interleave on the same stream.
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, await readBody(req))
  })().catch((error) => {
    console.error("[mcp] " + (error instanceof Error ? error.stack : String(error)))
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal error" }))
  })
})

http.listen(PORT, HOST, () => {
  console.log(`novelai mcp on http://${HOST}:${PORT}/mcp`)
  console.log(`images written to ${OUTPUT_DIR}`)
  if (!process.env.NOVELAI_PUBLIC_URL) {
    console.log("NOVELAI_PUBLIC_URL 未设置：结果里不会带图片链接，只有内联图和路径。")
  }
  console.log("明文 HTTP：公网部署请放在 TLS 反向代理后面。")
})
