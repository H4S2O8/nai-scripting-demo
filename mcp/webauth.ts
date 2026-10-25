/**
 * Who may use the review web page.
 *
 * Three ways in, any one enough, and nothing else:
 *
 *   Cloudflare Access  The intended front door. When CF_ACCESS_TEAM and
 *                      CF_ACCESS_AUD are set, the Cf-Access-Jwt-Assertion
 *                      header is verified here — signature against the team's
 *                      published keys, audience, issuer, expiry — so a request
 *                      that did not come through Access is not trusted just
 *                      because it reached the origin.
 *   Session cookie     Log in once on /app/login; the browser gets a 90-day
 *                      signed cookie. The login takes the web password when
 *                      NOVELAI_WEB_PASSWORD_HASH is set (see webpass.ts), else
 *                      the MCP access key. It works before Access is
 *                      configured, and on localhost.
 *   Bearer header      The same key, for scripts and tests.
 *
 * Without any of them the answer is no: an unconfigured Access setup leaves
 * the page closed, never open.
 */
import { createHmac, createPublicKey, randomBytes, scryptSync, timingSafeEqual, verify, KeyObject } from "node:crypto"
import { IncomingMessage } from "node:http"

export type Visitor = { via: "access" | "session" | "bearer"; email?: string }

/**
 * The web password is kept only as a scrypt hash:
 * scrypt$N$r$p$<salt, base64url>$<hash, base64url>.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), hash.toString("base64url")].join("$")
}

/** Throws on a malformed hash, so a bad config is reported rather than read as "wrong password". */
function parseHash(encoded: string) {
  const parts = encoded.split("$")
  const [kind, N, r, p, salt, hash] = parts
  if (parts.length !== 6 || kind !== "scrypt" || !salt || !hash || ![N, r, p].every((n) => /^\d+$/.test(n))) {
    throw new Error("NOVELAI_WEB_PASSWORD_HASH 格式不对，要用 webpass.mjs 生成")
  }
  return { N: Number(N), r: Number(r), p: Number(p), salt: Buffer.from(salt, "base64url"), hash: Buffer.from(hash, "base64url") }
}

export function checkPassword(password: string, encoded: string): boolean {
  const h = parseHash(encoded)
  const got = scryptSync(password, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p })
  return timingSafeEqual(got, h.hash)
}

const COOKIE = "nai_session"
const SESSION_DAYS = 90

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url")

function sameSecret(presented: string, secret: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class WebAuth {
  private keys = new Map<string, KeyObject>()
  private keysFetched = 0
  private failures = new Map<string, number[]>()

  /** Why the configured web password cannot be used, if it cannot. */
  readonly passwordProblem: string | null = null

  constructor(
    private secret: string,
    private access: { team: string; aud: string } | null = null,
    private passwordHash: string | null = null,
  ) {
    if (!secret) throw new Error("WebAuth 需要 MCP_AUTH_TOKEN")
    if (passwordHash) {
      try {
        parseHash(passwordHash)
      } catch (error) {
        // Logins are refused with this message; the MCP endpoint keeps running.
        this.passwordProblem = error instanceof Error ? error.message : String(error)
        console.error("[web] " + this.passwordProblem)
      }
    }
  }

  static fromEnv(secret: string): WebAuth {
    const team = process.env.CF_ACCESS_TEAM?.trim()
    const aud = process.env.CF_ACCESS_AUD?.trim()
    if ((team && !aud) || (!team && aud)) {
      throw new Error("CF_ACCESS_TEAM 和 CF_ACCESS_AUD 要一起设置")
    }
    return new WebAuth(secret, team && aud ? { team, aud } : null, process.env.NOVELAI_WEB_PASSWORD_HASH?.trim() || null)
  }

  /** Whether /app/login asks for the web password rather than the MCP access key. */
  get usesPassword(): boolean {
    return this.passwordHash !== null
  }

  /* ------------------------------------------------------------ session */

  /** Keyed on the password hash too, so changing the password signs everyone out. */
  private sign(payload: string): string {
    return createHmac("sha256", `nai-web-session:${this.secret}:${this.passwordHash ?? ""}`).update(payload).digest("base64url")
  }

  /** A Set-Cookie value for a fresh session. */
  sessionCookie(now = Date.now()): string {
    const payload = b64url(JSON.stringify({ exp: now + SESSION_DAYS * 86400_000 }))
    const value = `${payload}.${this.sign(payload)}`
    return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`
  }

  static clearCookie(): string {
    return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  }

  private sessionValid(cookieHeader: string | undefined, now = Date.now()): boolean {
    const match = (cookieHeader ?? "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))
    if (!match) return false
    const [payload, mac] = match.slice(COOKIE.length + 1).split(".")
    if (!payload || !mac || !sameSecret(mac, this.sign(payload))) return false
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > now
    } catch {
      return false
    }
  }

  /**
   * Check a login: the web password when one is configured, else the MCP
   * access key. Ten wrong tries from one address within ten minutes lock that
   * address out for the rest of the window.
   */
  login(presented: string, client: string, now = Date.now()): "ok" | "wrong" | "locked" | "misconfigured" {
    if (this.passwordProblem) return "misconfigured"
    const recent = (this.failures.get(client) ?? []).filter((t) => now - t < 600_000)
    if (recent.length >= 10) return "locked"
    const ok = this.passwordHash ? checkPassword(presented, this.passwordHash) : sameSecret(presented.trim(), this.secret)
    if (ok) {
      this.failures.delete(client)
      return "ok"
    }
    this.failures.set(client, [...recent, now])
    return "wrong"
  }

  /* ------------------------------------------------------------- access */

  private async accessKey(kid: string): Promise<KeyObject | null> {
    if (!this.access) return null
    // Refetched hourly, or at once for a kid we have not seen: Access rotates keys.
    if (!this.keys.has(kid) || Date.now() - this.keysFetched > 3600_000) {
      const response = await fetch(`https://${this.access.team}.cloudflareaccess.com/cdn-cgi/access/certs`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Cloudflare Access 公钥获取失败：HTTP ${response.status}`)
      const { keys } = (await response.json()) as { keys: (JsonWebKey & { kid: string })[] }
      this.keys = new Map(keys.map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]))
      this.keysFetched = Date.now()
    }
    return this.keys.get(kid) ?? null
  }

  /** The verified email of an Access JWT, or null if it is not one of ours. */
  async verifyAccess(token: string, now = Date.now()): Promise<string | null> {
    if (!this.access) return null
    const parts = token.split(".")
    if (parts.length !== 3) return null
    try {
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString())
      if (header.alg !== "RS256" || typeof header.kid !== "string") return null
      const key = await this.accessKey(header.kid)
      if (!key) return null
      const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))
      if (!ok) return null
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (!audiences.includes(this.access.aud)) return null
      if (claims.iss !== `https://${this.access.team}.cloudflareaccess.com`) return null
      if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null
      return typeof claims.email === "string" ? claims.email : "(Access)"
    } catch {
      return null
    }
  }

  /** Test hook: install a key as if fetched from the team's certs endpoint. */
  setAccessKeyForTest(kid: string, key: KeyObject) {
    this.keys.set(kid, key)
    this.keysFetched = Date.now()
  }

  /* -------------------------------------------------------------- check */

  async visitor(req: IncomingMessage): Promise<Visitor | null> {
    const jwt = req.headers["cf-access-jwt-assertion"]
    if (typeof jwt === "string" && this.access) {
      const email = await this.verifyAccess(jwt)
      if (email) return { via: "access", email }
    }
    if (this.sessionValid(req.headers.cookie)) return { via: "session" }
    const header = req.headers.authorization ?? ""
    if (header.startsWith("Bearer ") && sameSecret(header.slice(7).trim(), this.secret)) return { via: "bearer" }
    return null
  }

  get accessConfigured(): boolean {
    return this.access !== null
  }
}
