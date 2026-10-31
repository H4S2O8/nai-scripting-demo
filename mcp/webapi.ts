/**
 * The review web page: /app serves the front end, /api the JSON it reads and
 * writes. Both sit on the same studio service the MCP tools use, so a pick
 * made here is the pick the agent sees.
 *
 * Every write needs the x-nai-app header: a cross-site page cannot send it
 * without a CORS preflight this server never answers, and the session cookie
 * is SameSite=Strict besides.
 */
import { IncomingMessage, ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { Library } from "./library"
import { Studio, pageFooter } from "./studio"
import { Publisher } from "./publish"
import { Thumbs } from "./thumbs"
import { Visitor, WebAuth } from "./webauth"

export type WebDeps = {
  auth: WebAuth
  library: () => Library
  thumbs: Thumbs
  publisher: Publisher
}

const STATIC: Record<string, { file: URL; type: string }> = {
  "/app/assets/app.js": { file: new URL("./web/app.js", import.meta.url), type: "text/javascript; charset=utf-8" },
  "/app/assets/style.css": { file: new URL("../web/style.css", import.meta.url), type: "text/css; charset=utf-8" },
}
const INDEX = new URL("../web/index.html", import.meta.url)

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers })
  res.end(JSON.stringify(body))
}

/**
 * The front end's version: a hash of the built script and the stylesheet.
 *
 * A browser that keeps an old app.js — some in-app browsers ignore no-cache —
 * would run yesterday's page against today's API. So the page is never cached,
 * it loads the assets as app.js?v=<version>, a URL that changes with every
 * build, and it carries the version so the running page can notice a newer
 * one and offer to reload.
 */
export function frontendVersion(): string {
  const hash = createHash("sha1")
  for (const { file } of Object.values(STATIC)) {
    const path = fileURLToPath(file)
    if (!existsSync(path)) throw new Error(`缺少前端文件 ${path}，先 npm run build`)
    hash.update(readFileSync(path))
  }
  return hash.digest("hex").slice(0, 10)
}

function sendIndex(res: ServerResponse) {
  const path = fileURLToPath(INDEX)
  let version: string
  try {
    version = frontendVersion()
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(error instanceof Error ? error.message : String(error))
    return
  }
  const html = readFileSync(path, "utf8")
    .replace(/(\/app\/assets\/(?:app\.js|style\.css))/g, `$1?v=${version}`)
    .replace("</head>", `  <meta name="nai-version" content="${version}">\n  </head>`)
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  res.end(html)
}

function sendFile(res: ServerResponse, file: URL, type: string) {
  const path = fileURLToPath(file)
  if (!existsSync(path)) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`缺少前端文件 ${path}，先 npm run build`)
    return
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" })
  res.end(readFileSync(path))
}

function shotIdList(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("需要 shotIds")
  return value.map(Number)
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error("请求体太大")
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch {
    throw new Error("请求体不是合法的 JSON")
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8").slice(0, 4096))
}

function loginPage(usesPassword: boolean, message = ""): string {
  const hint = usesPassword
    ? "输入网页登录密码。这台设备会记住 90 天。"
    : "粘贴 MCP 的访问密钥（服务器 /etc/novelai-mcp.env 里的 MCP_AUTH_TOKEN）。这台设备会记住 90 天。"
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>登录 · NovelAI 工作室</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:16px system-ui,sans-serif}
form{width:min(360px,calc(100% - 32px))}h1{font-size:20px;font-weight:600}p{color:#aaa;font-size:14px;line-height:1.6}
input{box-sizing:border-box;width:100%;padding:12px;margin:12px 0;border:1px solid #444;border-radius:8px;background:#1c1c1c;color:#eee;font:inherit}
button{width:100%;padding:12px;border:0;border-radius:8px;background:#e8e8e8;color:#111;font:inherit;font-weight:600}
.err{color:#ff8a80}</style></head><body><form method="post" action="/app/login">
<h1>NovelAI 工作室</h1><p>${hint}</p>
${message ? `<p class="err">${message}</p>` : ""}
<input name="token" type="password" autocomplete="current-password" required autofocus aria-label="${usesPassword ? "密码" : "访问密钥"}">
<button type="submit">登录</button></form></body></html>`
}

/** Handles /app and /api. Returns false for anything else, so the caller can carry on. */
export async function handleWeb(req: IncomingMessage, res: ServerResponse, url: URL, deps: WebDeps): Promise<boolean> {
  const path = url.pathname
  if (path !== "/app" && !path.startsWith("/app/") && !path.startsWith("/api/")) return false

  if (path === "/app/login") {
    if (req.method === "POST") {
      const client = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?")
      const outcome = deps.auth.login((await readForm(req)).get("token") ?? "", client)
      if (outcome === "ok") {
        res.writeHead(303, { location: "/app", "set-cookie": deps.auth.sessionCookie() }).end()
      } else if (outcome === "misconfigured") {
        res.writeHead(500, { "content-type": "text/html; charset=utf-8" })
        res.end(loginPage(true, "服务器上的网页密码配置有误：" + deps.auth.passwordProblem))
      } else {
        const wrong = deps.auth.usesPassword ? "密码不对。" : "密钥不对。"
        res.writeHead(outcome === "locked" ? 429 : 401, { "content-type": "text/html; charset=utf-8" })
        res.end(loginPage(deps.auth.usesPassword, outcome === "locked" ? "错误次数太多，十分钟后再试。" : wrong))
      }
      return true
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(loginPage(deps.auth.usesPassword))
    return true
  }
  if (path === "/app/logout") {
    res.writeHead(303, { location: "/app/login", "set-cookie": WebAuth.clearCookie() }).end()
    return true
  }

  const visitor = await deps.auth.visitor(req)
  if (!visitor) {
    if (path.startsWith("/api/")) send(res, 401, { error: "未登录" })
    else res.writeHead(303, { location: "/app/login" }).end()
    return true
  }

  if (!path.startsWith("/api/")) {
    const asset = STATIC[path]
    if (asset) sendFile(res, asset.file, asset.type)
    else sendIndex(res)
    return true
  }

  try {
    await api(req, res, url, visitor, deps)
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
  return true
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, visitor: Visitor, deps: WebDeps) {
  const studio = new Studio(deps.library())
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent)
  const method = req.method ?? "GET"

  if (method === "POST" && req.headers["x-nai-app"] !== "1") {
    send(res, 403, { error: "缺少 x-nai-app 请求头" })
    return
  }

  if (method === "GET" && parts[0] === "version") return send(res, 200, { version: frontendVersion() })

  if (method === "GET" && parts[0] === "me") return send(res, 200, { ...visitor, access: deps.auth.accessConfigured })

  if (method === "GET" && parts[0] === "projects" && parts.length === 1) return send(res, 200, studio.listProjects())

  if (method === "GET" && parts[0] === "projects" && parts.length === 2) {
    const project = studio.getProject(parts[1])
    return send(res, 200, {
      ...project,
      chapters: project.kind === "novel" ? studio.novelOverview(project.name) : [],
      shots: project.kind === "gallery" ? studio.galleryOverview(project.name) : [],
      loose: studio.looseImages(project.name),
      feedback: studio.feedback(project.name, true).filter((f) => f.target === "project"),
    })
  }

  if (method === "GET" && parts[0] === "pages" && parts.length === 2) return send(res, 200, studio.pageDetail(Number(parts[1])))
  if (method === "GET" && parts[0] === "shots" && parts.length === 2) return send(res, 200, studio.shotDetail(Number(parts[1])))

  if (method === "POST" && parts[0] === "verdict") {
    const body = await readJson(req)
    const actions = ["pick", "reject", "reset", "favorite", "unfavorite"]
    if (!Array.isArray(body.imageIds) || !actions.includes(body.action)) throw new Error("需要 imageIds 和 action")
    return send(res, 200, studio.verdict(body.imageIds.map(Number), body.action, "human"))
  }

  // The mainline, for any number of shots at once: place, unplace, or the whole order.
  if (method === "POST" && parts[0] === "shots" && (parts[1] === "place" || parts[1] === "unplace") && parts.length === 2) {
    const body = await readJson(req)
    const ids = shotIdList(body.shotIds)
    if (parts[1] === "unplace") return send(res, 200, studio.unplace(ids))
    const pick = (k: string) => (body[k] == null ? undefined : Number(body[k]))
    return send(res, 200, studio.place(ids, { before: pick("before"), after: pick("after"), at: pick("at") }))
  }
  if (method === "POST" && parts[0] === "projects" && parts[2] === "order" && parts.length === 3) {
    const body = await readJson(req)
    if (!Array.isArray(body.shotIds)) throw new Error("需要 shotIds")
    return send(res, 200, studio.order(parts[1], body.shotIds.map(Number)))
  }

  if (method === "POST" && parts[0] === "shots" && parts[2] === "adopt") {
    const body = await readJson(req)
    if (!Array.isArray(body.imageIds) || body.imageIds.length === 0) throw new Error("需要 imageIds")
    return send(res, 200, studio.adopt(Number(parts[1]), body.imageIds.map(Number)))
  }

  if (method === "POST" && parts[0] === "projects" && parts[2] === "chapters" && parts.length === 4) {
    const body = await readJson(req)
    if (body.route !== undefined && typeof body.route !== "string") throw new Error("route 要是文字")
    if (body.title !== undefined && typeof body.title !== "string") throw new Error("title 要是文字")
    return send(res, 200, studio.setChapterInfo(parts[1], { chapter: Number(parts[3]), title: body.title, route: body.route }))
  }

  if (method === "POST" && parts[0] === "feedback" && parts.length === 1) {
    const body = await readJson(req)
    return send(res, 200, studio.comment(String(body.project), {
      target: body.target,
      targetId: body.targetId == null ? undefined : Number(body.targetId),
      body: String(body.body ?? ""),
      author: "human",
    }))
  }
  if (method === "POST" && parts[0] === "feedback" && parts[2] === "resolve") {
    const body = await readJson(req)
    studio.resolve(String(body.project), [Number(parts[1])])
    return send(res, 200, { ok: true })
  }

  if (method === "GET" && parts[0] === "thumb" && parts.length === 2) {
    const image = deps.library().get([Number(parts[1])])[0]
    const thumb = await deps.thumbs.thumbnail(image)
    if ("url" in thumb) {
      // The thumbnail is on R2: send the browser to the CDN, and let it remember.
      res.writeHead(302, { location: thumb.url, "cache-control": "private, max-age=86400" }).end()
    } else {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" }).end(thumb.data)
    }
    return
  }

  if (method === "GET" && parts[0] === "render" && parts[1] === "page" && parts.length === 3) {
    const detail = studio.pageDetail(Number(parts[2]))
    const imageId = Number(url.searchParams.get("image"))
    const image = detail.candidates.find((c) => c.id === imageId)
    if (!image) throw new Error(`#${imageId} 不是这一页的候选图`)
    const data = await deps.thumbs.page(
      image,
      detail.page,
      {
        pageNumber: pageFooter(detail.page),
        background: detail.layout.background,
        textColor: detail.layout.textColor,
      },
      Number(url.searchParams.get("w") ?? 1200),
    )
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" })
    res.end(data)
    return
  }

  if (await publishApi(req, res, method, parts, deps.publisher)) return

  send(res, 404, { error: `没有这个接口：${method} ${url.pathname}` })
}

/**
 * Publishing to E-Hentai. Every call goes through Publisher to the publisher
 * MCP on this host; uploads stop at a draft, and nothing here publishes.
 */
async function publishApi(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], publisher: Publisher): Promise<boolean> {
  if (parts[0] === "mascots") {
    if (method === "GET" && parts.length === 1) return send(res, 200, publisher.mascots()), true
    if (method === "POST" && parts.length === 1) {
      const body = await readJson(req, 12 * 1024 * 1024)
      const match = String(body.dataUrl ?? "").match(/^data:image\/(png|webp|jpeg);base64,([A-Za-z0-9+/=]+)$/)
      if (!match) throw new Error("需要 dataUrl：PNG、WebP 或 JPEG 的 data URL")
      return send(res, 200, await publisher.uploadMascot(String(body.name ?? ""), Buffer.from(match[2], "base64"))), true
    }
    if (method === "POST" && parts[1] === "from-image") {
      const body = await readJson(req)
      return send(res, 200, publisher.mascotFromImage(String(body.name ?? ""), Number(body.imageId))), true
    }
    if (method === "POST" && parts[2] === "remove") return publisher.removeMascot(Number(parts[1])), send(res, 200, { ok: true }), true
    return false
  }
  if (parts[0] === "projects" && parts[2] === "publish") {
    const project = parts[1]
    if (method === "GET" && parts.length === 3) {
      return send(res, 200, {
        settings: publisher.settings(project),
        appendDefaults: await publisher.appendDefaults(project),
        candidates: publisher.candidates(project),
        publications: publisher.publications(project),
        mascots: publisher.mascots(),
      }), true
    }
    if (method === "POST" && parts[3] === "preview") {
      const body = await readJson(req)
      const { image } = await publisher.previewCover({
        backgroundImageId: Number(body.backgroundImageId),
        coverStyle: String(body.coverStyle ?? "ai"),
        coverSpec: body.coverSpec ?? null,
        maxWidth: Number(body.maxWidth ?? 900),
      })
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end(image)
      return true
    }
    if (method === "POST" && parts[3] === "start") {
      const body = await readJson(req)
      if (!Array.isArray(body.items)) throw new Error("需要 items")
      const items = body.items.map((i: any) => ({ imageId: Number(i.imageId), ...(i.pageId ? { pageId: Number(i.pageId) } : {}) }))
      return send(res, 200, { id: publisher.start(project, items, body.settings ?? {}) }), true
    }
    return false
  }
  if (parts[0] === "publications" && parts.length >= 2) {
    const id = Number(parts[1])
    if (method === "GET" && parts.length === 2) return send(res, 200, await publisher.status(id)), true
    if (method === "POST" && parts[2] === "update") return send(res, 200, await publisher.update(id, await readJson(req))), true
    if (method === "POST" && parts[2] === "draft") return send(res, 200, await publisher.createDraft(id)), true
    if (method === "POST" && parts[2] === "link") {
      const body = await readJson(req)
      return send(res, 200, await publisher.linkPublished(id, String(body.galleryUrl ?? ""))), true
    }
  }
  return false
}
