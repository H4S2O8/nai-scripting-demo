/**
 * A minimal OAuth 2.1 authorization server in front of the MCP endpoint, for
 * clients that refuse a static bearer header (Gemini's web connector demands
 * "standard OAuth").
 *
 * It adds a way in; it takes nothing away. The static MCP_AUTH_TOKEN still
 * works exactly as before for Claude Code, Codex and the phone.
 *
 * Stateless by design: every code, client id and token is a payload signed
 * with a key derived from MCP_AUTH_TOKEN. Nothing is stored, a restart loses
 * nothing, and rotating MCP_AUTH_TOKEN revokes every OAuth grant at once.
 *
 * Two kinds of client:
 *
 *   static   client_id MCP_OAUTH_CLIENT_ID (default "novelai-mcp"),
 *            client_secret = MCP_AUTH_TOKEN. Authorization is approved without
 *            a prompt, because the code is worthless without the secret.
 *   dynamic  registered through /oauth/register (RFC 7591), public, PKCE
 *            mandatory. The person must type the access key on the consent
 *            page, so registration being open gives a stranger nothing.
 *
 *   MCP_OAUTH_CLIENT_ID   optional, default "novelai-mcp"
 */
import { IncomingMessage, ServerResponse } from "node:http"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const CODE_TTL = 5 * 60
const ACCESS_TTL = 24 * 3600
const REFRESH_TTL = 180 * 24 * 3600
/** Marks OAuth-issued tokens so they can never be mistaken for the static one. */
const PREFIX = "nmo_"

type Payload = Record<string, unknown> & { t: string; exp?: number }

export function createOAuth(secret: string) {
  const KEY = createHash("sha256").update("novelai-mcp-oauth\0" + secret).digest()
  const STATIC_ID = (process.env.MCP_OAUTH_CLIENT_ID ?? "").trim() || "novelai-mcp"
  // Codes are single-use; remember spent ones until they would expire anyway.
  const spent = new Map<string, number>()

  const now = () => Math.floor(Date.now() / 1000)

  function sign(p: Payload): string {
    const body = Buffer.from(JSON.stringify(p)).toString("base64url")
    const mac = createHmac("sha256", KEY).update(body).digest("base64url")
    return PREFIX + body + "." + mac
  }

  function open(token: string, type: string): Payload | undefined {
    if (!token.startsWith(PREFIX)) return undefined
    const [body, mac] = token.slice(PREFIX.length).split(".")
    if (!body || !mac) return undefined
    const want = createHmac("sha256", KEY).update(body).digest()
    const got = Buffer.from(mac, "base64url")
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined
    let p: Payload
    try {
      p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    } catch {
      return undefined
    }
    if (p.t !== type) return undefined
    if (p.exp !== undefined && p.exp < now()) return undefined
    return p
  }

  function sameSecret(presented: string): boolean {
    const a = Buffer.from(presented)
    const b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Public origin of this server, as clients reach it. */
  function origin(req: IncomingMessage): string {
    const configured = process.env.NOVELAI_PUBLIC_URL?.trim()
    if (configured) return configured.replace(/\/+$/, "")
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost")
    // Behind the Cloudflare tunnel nginx sees plain http and forwards that, so
    // the header cannot be trusted to say https for a public name.
    const local = /^(localhost|127\.|\[::1\])/.test(host)
    const proto = local ? String(req.headers["x-forwarded-proto"] ?? "http") : "https"
    return `${proto}://${host}`
  }

  /* ------------------------------------------------------------- clients */

  type Client = { id: string; name: string; redirects?: string[]; confidential: boolean }

  function client(id: string): Client | undefined {
    if (id === STATIC_ID) return { id, name: "NovelAI MCP", confidential: true }
    const p = open(id, "client")
    if (!p) return undefined
    return { id, name: String(p.n ?? "MCP client"), redirects: p.r as string[], confidential: false }
  }

  function redirectAllowed(c: Client, uri: string): boolean {
    let u: URL
    try {
      u = new URL(uri)
    } catch {
      return false
    }
    if (u.hash) return false
    if (c.redirects) return c.redirects.includes(uri)
    // Static client: any https target, or loopback for local tools.
    return u.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
  }

  /** Static clients must prove the secret; dynamic ones are public. */
  function clientAuthOk(c: Client, req: IncomingMessage, form: URLSearchParams): boolean {
    if (!c.confidential) return true
    let presented = form.get("client_secret") ?? ""
    const basic = req.headers.authorization ?? ""
    if (basic.startsWith("Basic ")) {
      const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8")
      const i = decoded.indexOf(":")
      if (i >= 0) presented = decodeURIComponent(decoded.slice(i + 1))
    }
    return sameSecret(presented)
  }

  function clientIdFrom(req: IncomingMessage, form: URLSearchParams): string {
    const basic = req.headers.authorization ?? ""
    if (basic.startsWith("Basic ")) {
      const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8")
      const i = decoded.indexOf(":")
      if (i >= 0) return decodeURIComponent(decoded.slice(0, i))
    }
    return form.get("client_id") ?? ""
  }

  /* ------------------------------------------------------------- helpers */

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    })
    res.end(JSON.stringify(body))
  }

  function oauthError(res: ServerResponse, status: number, error: string, description?: string) {
    json(res, status, { error, ...(description ? { error_description: description } : {}) })
  }

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > 64 * 1024) break
      chunks.push(chunk as Buffer)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    if (String(req.headers["content-type"] ?? "").includes("application/json")) {
      try {
        const obj = JSON.parse(text) as Record<string, unknown>
        const form = new URLSearchParams()
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string") form.set(k, v)
        }
        return form
      } catch {
        return new URLSearchParams()
      }
    }
    return new URLSearchParams(text)
  }

  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

  function consentPage(res: ServerResponse, c: Client, params: URLSearchParams, error = "") {
    const hidden = [...params.entries()]
      .filter(([k]) => k !== "key")
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("")
    res.writeHead(error ? 401 : 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *",
    })
    res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 NovelAI MCP</title>
<style>body{font:16px system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 16px;color:#222}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;font-size:15px;margin:8px 0 12px}
button{padding:10px 18px;font-size:15px}.err{color:#b00020}
@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}.err{color:#ff7a8a}}</style></head>
<body><h2>授权访问 NovelAI MCP</h2>
<p><b>${esc(c.name)}</b> 请求使用这个生图服务（会消耗 Anlas）。</p>
<p>输入访问密钥（服务器上的 MCP_AUTH_TOKEN）以同意：</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">${hidden}
<input type="password" name="key" autocomplete="current-password" autofocus required>
<button type="submit">授权</button></form></body></html>`)
  }

  function redirectWith(res: ServerResponse, uri: string, params: Record<string, string>) {
    const u = new URL(uri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    res.writeHead(302, { location: u.toString(), "cache-control": "no-store" })
    res.end()
  }

  function issueTokens(cid: string, scope: string) {
    const t = now()
    return {
      access_token: sign({ t: "at", cid, exp: t + ACCESS_TTL }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: sign({ t: "rt", cid, exp: t + REFRESH_TTL }),
      ...(scope ? { scope } : {}),
    }
  }

  /* ------------------------------------------------------------ endpoints */

  async function authorize(req: IncomingMessage, res: ServerResponse, url: URL) {
    const params = req.method === "POST" ? await readForm(req) : url.searchParams
    const c = client(params.get("client_id") ?? "")
    const redirect = params.get("redirect_uri") ?? ""
    // Until client and redirect are known good, errors must not redirect:
    // that would turn this endpoint into an open redirector.
    if (!c) return oauthError(res, 400, "invalid_client", "unknown client_id")
    if (!redirectAllowed(c, redirect)) return oauthError(res, 400, "invalid_request", "redirect_uri not allowed")

    const state = params.get("state") ?? ""
    const fail = (error: string, description: string) =>
      redirectWith(res, redirect, { error, error_description: description, ...(state ? { state } : {}) })

    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "only code is supported")
    const challenge = params.get("code_challenge") ?? ""
    const method = params.get("code_challenge_method") ?? (challenge ? "plain" : "")
    if (challenge && method !== "S256") return fail("invalid_request", "only S256 PKCE is supported")
    if (!c.confidential && !challenge) return fail("invalid_request", "PKCE is required for public clients")

    if (!c.confidential) {
      if (req.method !== "POST") return consentPage(res, c, params)
      if (!sameSecret((params.get("key") ?? "").trim())) return consentPage(res, c, params, "密钥不对，再试一次。")
    }

    const code = sign({
      t: "code",
      cid: c.id,
      ru: redirect,
      pk: challenge,
      sc: params.get("scope") ?? "",
      n: randomBytes(8).toString("hex"),
      exp: now() + CODE_TTL,
    })
    redirectWith(res, redirect, { code, ...(state ? { state } : {}) })
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST only")
    const form = await readForm(req)
    const c = client(clientIdFrom(req, form))
    if (!c || !clientAuthOk(c, req, form)) return oauthError(res, 401, "invalid_client")

    const grant = form.get("grant_type")
    if (grant === "authorization_code") {
      const raw = form.get("code") ?? ""
      const p = open(raw, "code")
      if (!p || p.cid !== c.id) return oauthError(res, 400, "invalid_grant", "bad or expired code")
      if (p.ru !== (form.get("redirect_uri") ?? p.ru)) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch")
      if (p.pk) {
        const verifier = form.get("code_verifier") ?? ""
        const computed = createHash("sha256").update(verifier).digest("base64url")
        if (!verifier || computed !== p.pk) return oauthError(res, 400, "invalid_grant", "PKCE verification failed")
      }
      for (const [k, exp] of spent) if (exp < now()) spent.delete(k)
      if (spent.has(raw)) return oauthError(res, 400, "invalid_grant", "code already used")
      spent.set(raw, p.exp ?? now() + CODE_TTL)
      return json(res, 200, issueTokens(c.id, String(p.sc ?? "")))
    }
    if (grant === "refresh_token") {
      const p = open(form.get("refresh_token") ?? "", "rt")
      if (!p || p.cid !== c.id) return oauthError(res, 400, "invalid_grant", "bad or expired refresh_token")
      return json(res, 200, issueTokens(c.id, form.get("scope") ?? ""))
    }
    return oauthError(res, 400, "unsupported_grant_type")
  }

  async function register(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") return oauthError(res, 405, "invalid_request", "POST only")
    let meta: Record<string, unknown>
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      meta = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      return oauthError(res, 400, "invalid_client_metadata", "body must be JSON")
    }
    const redirects = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((u) => typeof u === "string") : []
    if (redirects.length === 0 || redirects.length > 10) {
      return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris required")
    }
    for (const r of redirects as string[]) {
      try {
        if (new URL(r).hash) throw new Error()
      } catch {
        return oauthError(res, 400, "invalid_redirect_uri", r)
      }
    }
    const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 80) : "MCP client"
    const id = sign({ t: "client", n: name, r: redirects })
    json(res, 201, {
      client_id: id,
      client_id_issued_at: now(),
      client_name: name,
      redirect_uris: redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
  }

  function protectedResource(req: IncomingMessage, res: ServerResponse) {
    const o = origin(req)
    json(res, 200, {
      resource: o + "/mcp",
      authorization_servers: [o],
      bearer_methods_supported: ["header"],
      resource_name: "NovelAI MCP",
    })
  }

  function authorizationServer(req: IncomingMessage, res: ServerResponse) {
    const o = origin(req)
    json(res, 200, {
      issuer: o,
      authorization_endpoint: o + "/oauth/authorize",
      token_endpoint: o + "/oauth/token",
      registration_endpoint: o + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      scopes_supported: [],
    })
  }

  return {
    /** Handles OAuth routes; returns false when the path is not one of them. */
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      const p = url.pathname
      const routes: Record<string, () => unknown> = {
        "/.well-known/oauth-protected-resource": () => protectedResource(req, res),
        "/.well-known/oauth-protected-resource/mcp": () => protectedResource(req, res),
        "/.well-known/oauth-authorization-server": () => authorizationServer(req, res),
        "/.well-known/openid-configuration": () => authorizationServer(req, res),
        "/oauth/authorize": () => authorize(req, res, url),
        "/oauth/token": () => token(req, res),
        "/oauth/register": () => register(req, res),
      }
      const route = routes[p]
      if (!route) return false
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
        })
        res.end()
        return true
      }
      await route()
      return true
    },

    /** True for an unexpired access token this server issued. */
    verifyAccess(token: string): boolean {
      return open(token, "at") !== undefined
    },

    /** The value for WWW-Authenticate on a 401, pointing clients at discovery. */
    challenge(req: IncomingMessage): string {
      return `Bearer realm="novelai-mcp", resource_metadata="${origin(req)}/.well-known/oauth-protected-resource"`
    },
  }
}
