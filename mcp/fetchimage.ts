/**
 * Download a picture the caller named by URL.
 *
 * The server fetches whatever it is told to, so the URL is held to the public
 * internet: http(s) only, and every address the host resolves to must be a
 * public one — no loopback, private, link-local or carrier-grade NAT ranges,
 * which on this box would reach the MCP itself and the other local services.
 * Redirects are followed by hand so each hop is checked the same way.
 *
 * The check and the connection resolve the name separately, so a host that
 * changes its answer in between could still slip through; the endpoint is
 * behind the bearer token, which is what this is defending in depth for.
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const MAX_BYTES = 30 * 1024 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 30_000

function privateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number)
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address)
  const v6 = address.toLowerCase()
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return privateV4(mapped[1])
  return (
    v6 === "::" || v6 === "::1" ||
    v6.startsWith("fc") || v6.startsWith("fd") ||
    v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") ||
    v6.startsWith("ff")
  )
}

async function checkUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`图片链接不是合法的 URL：${raw}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`图片链接只支持 http / https：${url.protocol}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address)
  const blocked = addresses.filter(isPrivateAddress)
  if (blocked.length) throw new Error(`图片链接指向内网地址（${blocked.join(", ")}），不允许`)
  return url
}

export async function fetchImage(raw: string): Promise<Buffer> {
  let url = await checkUrl(raw)
  for (let hop = 0; ; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (novelai-mcp page composer)" },
    })
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error("图片链接跳转次数太多")
      url = await checkUrl(new URL(response.headers.get("location")!, url).href)
      continue
    }
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length") ?? 0)
    if (declared > MAX_BYTES) throw new Error(`图片太大：${(declared / 1048576).toFixed(1)}MB，上限 30MB`)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length
      if (size > MAX_BYTES) throw new Error("图片太大：超过 30MB")
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }
}
