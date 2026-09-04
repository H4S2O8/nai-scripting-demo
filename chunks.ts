/**
 * NovelAI Prompt Chunks — read, write and sync.
 *
 * Protocol reverse-engineered by the companion userscript
 * (novelai-prompt-chunks-sync.user.js); this is the same wire format:
 *
 *   objects   GET/PUT  /user/objects/promptmacros
 *             PATCH/DELETE /user/objects/promptmacros/{remoteId}
 *             Every chunk AND every category is its own object.
 *
 *   obj.data  base64( magic[16] + nonce[24] + secretbox )
 *             magic = 00×15 + 01 marks a raw-DEFLATE payload; without the
 *             prefix the payload is stored uncompressed, which is equally
 *             valid and is what we fall back to when the platform's deflate
 *             turns out not to be raw.
 *   obj.meta  the chunk's containerId, which indexes into the keystore.
 *
 *   keystore  GET/PUT /user/keystore
 *             PUT body { keystore: base64(JSON{version:2,nonce,sdata}), changeIndex }
 *             The inner JSON is a secretbox under BLAKE2b-256(encryption_key).
 *             A legacy keystore's iv / data fields must be written back as-is.
 *
 * Both credentials come from the web session, not from the image API:
 *
 *   - These endpoints reject persistent (`pst-`) tokens outright, with
 *     "usage of persistent access tokens is not allowed for this endpoint".
 *     Confirmed against the live service. A web session `auth_token` is
 *     required, so the generation token is never used as a fallback here.
 *   - encryption_key is derived during login and is not in any token at all.
 *
 * Both live side by side in localStorage.session, which is why parseSession
 * exists: one paste beats two error-prone copies. They stay in the Keychain;
 * encryption_key never leaves the device, it is only hashed locally to open
 * the keystore.
 */
import { blake2b256 } from "./blake2b"
import { inflateAuto } from "./inflate"
import { SECRETBOX_KEY_BYTES, secretbox, secretboxOpen } from "./nacl"

const API = "https://image.novelai.net"
const OBJ_TYPE = "promptmacros"
/** Root category: holds the ordering of loose chunks and of categories. */
export const ROOT_ID = "default"
const MAGIC = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]

const SYNC_TOKEN_KEY = "nai_sync_token"
const ENC_KEY_KEY = "nai_encryption_key"
const CACHE_KEY = "nai.chunks.v1"
const COLLAPSE_PREFIX = "nai.chunkgroups."

export type Chunk = {
  containerId: string
  remoteId?: string
  id: string
  label: string
  expansion: string
  color: string
  version: number
  isCategory?: boolean
  childOrder?: string[]
  categoryOrder?: string[]
}

export type SyncAccount = {
  authToken: string
  encryptionKey: string
}

export type Keystore = {
  master: Uint8Array
  keys: Record<string, number[]>
  changeIndex?: number
  extras: { iv?: unknown; data?: unknown }
  dirty: boolean
}

export type SyncMode = "merge" | "update" | "mirror"

export type Log = (line: string) => void

/* ------------------------------------------------------------ byte helpers */

function utf8(text: string): Uint8Array {
  const data = Data.fromString(text)
  const bytes = data == null ? null : data.toUint8Array()
  if (!bytes) throw new Error("无法编码 UTF-8 文本")
  return bytes
}

function fromUtf8(bytes: Uint8Array): string {
  const data = Data.fromUint8Array(bytes)
  const text = data == null ? null : data.toRawString("utf-8")
  if (text == null) throw new Error("无法解码 UTF-8 文本")
  return text
}

function b64ToBytes(b64: string): Uint8Array {
  const data = Data.fromBase64String(b64)
  const bytes = data == null ? null : data.toUint8Array()
  if (!bytes) throw new Error("base64 解码失败")
  return bytes
}

function bytesToB64(bytes: Uint8Array): string {
  const data = Data.fromUint8Array(bytes)
  if (data == null) throw new Error("base64 编码失败")
  return data.toBase64String()
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * Random bytes.
 *
 * There is no getRandomValues here; Crypto.generateSymmetricKey is the only
 * CSPRNG exposed. Only the standard AES sizes are certain to be accepted, so
 * always ask for 256-bit keys and take as many as needed.
 */
function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count)
  let offset = 0
  while (offset < count) {
    const chunk = Crypto.generateSymmetricKey(256).toUint8Array()
    if (!chunk) throw new Error("无法生成随机数")
    const take = Math.min(chunk.length, count - offset)
    out.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return out
}

/* ------------------------------------------------------------- compression */

/**
 * NovelAI compresses payloads with raw DEFLATE (fflate).
 *
 * Reading uses the vendored decoder, not `Data.decompressed("zlib")`. Apple's
 * compression framework documents COMPRESSION_ZLIB as raw DEFLATE, but the
 * on-device probe said otherwise, and every existing chunk on an account is
 * compressed — so this cannot be left to the platform.
 *
 * Writing compressed still needs an *encoder*, which we do not vendor (the
 * format allows uncompressed payloads, so it is optional). Whether the
 * platform's encoder is usable is decided by inflating its output with our own
 * decoder — the one fuzzed against zlib — rather than by round-tripping it
 * against itself, which would pass even for a format NovelAI cannot read.
 */
const PROBE_PLAIN = "novelai-prompt-chunks probe"
/** Produced by a real raw-DEFLATE encoder; proves the decoder runs correctly here. */
const PROBE_RAW_DEFLATE_B64 = "y8svS81JzNQtKMrPLSjRTc4ozcsuVigoyk9KBQA="

let decoderProbe: boolean | null = null
let compressionProbe: boolean | null = null

/** Does the vendored inflate work in this JS engine? */
export function decoderUsable(): boolean {
  if (decoderProbe != null) return decoderProbe
  try {
    decoderProbe = fromUtf8(inflateAuto(b64ToBytes(PROBE_RAW_DEFLATE_B64))) === PROBE_PLAIN
  } catch {
    decoderProbe = false
  }
  return decoderProbe
}

/** Can we *write* compressed payloads, i.e. is the platform encoder raw DEFLATE? */
export function compressionUsable(): boolean {
  if (compressionProbe != null) return compressionProbe
  compressionProbe = false
  try {
    const packed = deflateRawUnchecked(utf8(PROBE_PLAIN))
    compressionProbe = fromUtf8(inflateAuto(packed)) === PROBE_PLAIN
  } catch {
    compressionProbe = false
  }
  return compressionProbe
}

function deflateRawUnchecked(bytes: Uint8Array): Uint8Array {
  const data = Data.fromUint8Array(bytes)
  if (data == null) throw new Error("压缩输入无效")
  const out = data.compressed("zlib").toUint8Array()
  if (!out) throw new Error("压缩失败")
  return out
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false
  for (let i = 0; i < 16; i++) if (bytes[i] !== MAGIC[i]) return false
  return true
}

/* ---------------------------------------------------------------- accounts */

export function loadSyncToken(): string {
  return (Keychain.get(SYNC_TOKEN_KEY) ?? "").trim()
}

export function saveSyncToken(token: string): boolean {
  const value = token.trim()
  if (!value) {
    Keychain.remove(SYNC_TOKEN_KEY)
    return true
  }
  return Keychain.set(SYNC_TOKEN_KEY, value)
}

export function loadEncryptionKey(): string {
  return (Keychain.get(ENC_KEY_KEY) ?? "").trim()
}

export function saveEncryptionKey(key: string): boolean {
  const value = key.trim()
  if (!value) {
    Keychain.remove(ENC_KEY_KEY)
    return true
  }
  return Keychain.set(ENC_KEY_KEY, value)
}

/**
 * Pull both credentials out of a pasted localStorage.session object.
 *
 * They are always issued together, so copying the whole object once is both
 * less work and less error-prone than copying two long opaque strings.
 */
export function parseSession(text: string): {
  authToken: string
  encryptionKey: string
} {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("剪贴板里不是 JSON。复制整个 localStorage.session 对象。")
  }
  const inner = parsed?.session ?? parsed
  const authToken = typeof inner?.auth_token === "string" ? inner.auth_token.trim() : ""
  const encryptionKey =
    typeof inner?.encryption_key === "string" ? inner.encryption_key.trim() : ""
  if (!authToken && !encryptionKey) {
    throw new Error("这个 JSON 里没有 auth_token / encryption_key。")
  }
  return { authToken, encryptionKey }
}

/* -------------------------------------------------------------------- HTTP */

async function api(
  path: string,
  account: SyncAccount,
  options: { method?: string; body?: unknown } = {},
): Promise<any> {
  const method = options.method ?? "GET"
  const headers: Record<string, string> = {
    Authorization: "Bearer " + account.authToken,
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json"

  const response = await fetch(API + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeout: 60,
    debugLabel: "NAI " + method + " " + path,
  })

  if (!response.ok) {
    let detail = ""
    try {
      const text = await response.text()
      try {
        const json = JSON.parse(text)
        detail = json?.message?.message ?? json?.message ?? text
      } catch {
        detail = text
      }
    } catch {
      /* body unreadable */
    }
    const message = String(detail)
    // The one failure worth spelling out: it looks like an auth problem but no
    // amount of re-issuing a pst- token will fix it.
    const hint = /persistent access token/i.test(message)
      ? " · 这些接口不收 pst- 持久令牌，需要网页会话的 auth_token（见「连接」卡片）"
      : response.status === 401
        ? " · auth_token 无效或已过期，重新从网页会话复制"
        : ""
    const error = new Error(
      `${method} ${path} → ${response.status}` +
        (message ? " · " + message.slice(0, 200) : "") +
        hint,
    ) as Error & { status?: number }
    error.status = response.status
    throw error
  }

  if (response.status === 204) return null
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status
}

/* ---------------------------------------------------------------- keystore */

export async function loadKeystore(account: SyncAccount): Promise<Keystore> {
  if (!account.encryptionKey) {
    throw new Error("缺少 encryption_key，无法解密 keystore。")
  }
  const master = blake2b256(utf8(account.encryptionKey))

  let payload: any = null
  let changeIndex: number | undefined
  try {
    const response = await api("/user/keystore", account)
    changeIndex = response?.changeIndex
    payload = response?.keystore
    if (typeof payload === "string") {
      payload = JSON.parse(fromUtf8(b64ToBytes(payload)))
    }
  } catch (error) {
    // A brand-new account has no keystore yet; anything else is fatal.
    if (statusOf(error) !== 404) throw error
  }

  // Only the legacy iv / data fields get written back; unknown fields are not
  // ours to carry, and the official frontend drops them too.
  const extras: Keystore["extras"] = {}
  if (payload && typeof payload === "object") {
    if (payload.iv !== undefined) extras.iv = payload.iv
    if (payload.data !== undefined) extras.data = payload.data
  }

  let keys: Record<string, number[]> = {}
  if (payload && payload.sdata && payload.nonce) {
    const opened = secretboxOpen(
      new Uint8Array(payload.sdata),
      new Uint8Array(payload.nonce),
      master,
    )
    if (!opened) throw new Error("keystore 解密失败：encryption_key 不匹配。")
    keys = JSON.parse(fromUtf8(opened)).keys ?? {}
  }

  return { master, keys, changeIndex, extras, dirty: false }
}

export function encodeKeystoreBlob(ks: Keystore): string {
  const keys: Record<string, number[]> = {}
  for (const id of Object.keys(ks.keys)) keys[id] = Array.from(ks.keys[id])
  const nonce = randomBytes(24)
  const sdata = secretbox(utf8(JSON.stringify({ keys })), nonce, ks.master)
  const inner: Record<string, unknown> = {
    version: 2,
    nonce: Array.from(nonce),
    sdata: Array.from(sdata),
  }
  if (ks.extras.iv !== undefined) inner.iv = ks.extras.iv
  if (ks.extras.data !== undefined) inner.data = ks.extras.data
  return bytesToB64(utf8(JSON.stringify(inner)))
}

export async function storeKeystore(
  account: SyncAccount,
  ks: Keystore,
  force = false,
): Promise<void> {
  const body: Record<string, unknown> = { keystore: encodeKeystoreBlob(ks) }
  if (!force && Number.isFinite(ks.changeIndex)) body.changeIndex = ks.changeIndex

  try {
    await api("/user/keystore", account, { method: "PUT", body })
  } catch (error) {
    const status = statusOf(error)
    if (status === 409 && !force) {
      // Someone else wrote first. Re-read, keep every key both sides have, and
      // retry — dropping a key here would orphan the objects it decrypts.
      const fresh = await loadKeystore(account)
      for (const id of Object.keys(ks.keys)) {
        if (!fresh.keys[id]) fresh.keys[id] = ks.keys[id]
      }
      ks.keys = fresh.keys
      ks.extras = fresh.extras
      ks.changeIndex = (fresh.changeIndex ?? 0) + 1
      return storeKeystore(account, ks, true)
    }
    if (status === 400 && !force && body.changeIndex !== undefined) {
      // Some accounts have no changeIndex at all and reject the field.
      await api("/user/keystore", account, {
        method: "PUT",
        body: { keystore: body.keystore },
      })
    } else {
      throw error
    }
  }
  ks.dirty = false
}

/**
 * Coerce one keystore entry into bytes.
 *
 * The inner JSON normally holds a plain number array, but `new Uint8Array(x)`
 * fails *silently* — producing an empty key, and therefore a decryption failure
 * on every object — for two shapes that do turn up: a base64 string, and the
 * `{"0":12,"1":34,...}` that JSON.stringify makes of a typed array. Handle all
 * three explicitly rather than letting a wrong shape look like a wrong key.
 */
function toKeyBytes(value: unknown): Uint8Array | null {
  if (value == null) return null
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return new Uint8Array(value)
  if (typeof value === "string") {
    const bytes = Data.fromBase64String(value)?.toUint8Array()
    return bytes && bytes.length > 0 ? bytes : null
  }
  if (typeof value === "object") {
    const indexed = value as Record<string, number>
    const length = Object.keys(indexed).length
    if (length === 0) return null
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i++) {
      const byte = indexed[String(i)]
      if (typeof byte !== "number") return null
      out[i] = byte
    }
    return out
  }
  return null
}

function keyFor(
  ks: Keystore,
  containerId: string,
  createIfMissing: boolean,
): Uint8Array | null {
  const existing = ks.keys[containerId]
  if (existing !== undefined) {
    const bytes = toKeyBytes(existing)
    if (bytes && bytes.length === SECRETBOX_KEY_BYTES) return bytes
    throw new Error(
      `keystore 里 ${containerId} 的密钥形状不对（` +
        `${describeKeyShape(existing)}），无法使用`,
    )
  }
  if (!createIfMissing) return null
  const key = randomBytes(32)
  ks.keys[containerId] = Array.from(key)
  ks.dirty = true
  return key
}

/** Human-readable shape of a keystore value, for diagnostics. */
export function describeKeyShape(value: unknown): string {
  if (value == null) return "空"
  if (Array.isArray(value)) return `数组 长度 ${value.length}`
  if (typeof value === "string") return `字符串 长度 ${value.length}`
  if (typeof value === "object") {
    return `对象 ${Object.keys(value as object).length} 个字段`
  }
  return typeof value
}

/* ----------------------------------------------------------- chunk codec */

const CHUNK_FIELDS = [
  "containerId",
  "id",
  "label",
  "expansion",
  "color",
  "version",
  "isCategory",
  "childOrder",
  "categoryOrder",
]

export function decodeChunk(obj: any, ks: Keystore): Chunk {
  const key = keyFor(ks, obj.meta, false)
  if (!key) throw new Error("keystore 中缺少 meta=" + obj.meta + " 的密钥")

  let raw = b64ToBytes(obj.data)
  const compressed = hasMagic(raw)
  if (compressed) raw = raw.subarray(16)
  const nonce = raw.subarray(0, 24)
  const box = raw.subarray(24)

  let plain = secretboxOpen(box, nonce, key)
  if (!plain) throw new Error("对象 " + obj.id + " 解密失败")
  if (compressed) plain = inflateAuto(plain)

  const chunk = JSON.parse(fromUtf8(plain)) as Chunk
  chunk.remoteId = obj.id
  return chunk
}

export function encodeChunk(chunk: Chunk, ks: Keystore): { data: string; meta: string } {
  const containerId = chunk.containerId || UUID.string()
  chunk.containerId = containerId
  const key = keyFor(ks, containerId, true)
  if (!key) throw new Error("无法为 " + containerId + " 建立密钥")

  const clean: Record<string, unknown> = {
    containerId,
    remoteId: "",
    id: chunk.id,
    label: chunk.label ?? "",
    expansion: chunk.expansion ?? "",
    color: chunk.color ?? "#6B7280",
    version: chunk.version ?? 1,
  }
  if (chunk.isCategory) {
    clean.isCategory = true
    clean.childOrder = Array.isArray(chunk.childOrder) ? chunk.childOrder : []
    clean.categoryOrder = Array.isArray(chunk.categoryOrder) ? chunk.categoryOrder : []
  } else if (chunk.isCategory === false) {
    clean.isCategory = false
  }

  let payload = utf8(JSON.stringify(clean))
  let prefix = new Uint8Array(0)
  if (compressionUsable()) {
    payload = deflateRawUnchecked(payload)
    prefix = new Uint8Array(MAGIC)
  }

  const nonce = randomBytes(24)
  const box = secretbox(payload, nonce, key)
  return { data: bytesToB64(concat(prefix, nonce, box)), meta: containerId }
}

/** Round-trip one chunk through the codec without touching the network. */
export function selfTestCodec(): string {
  const ks: Keystore = {
    master: randomBytes(32),
    keys: {},
    extras: {},
    dirty: false,
  }
  const sample: Chunk = {
    containerId: "",
    id: "self-test",
    label: "自检",
    expansion: "1girl, {blue eyes}",
    color: "#7C5CFA",
    version: 1,
    isCategory: false,
  }
  const encoded = encodeChunk({ ...sample }, ks)
  const decoded = decodeChunk({ id: "local", data: encoded.data, meta: encoded.meta }, ks)
  const ok =
    decoded.label === sample.label &&
    decoded.expansion === sample.expansion &&
    decoded.id === sample.id
  if (!ok) throw new Error("chunk 编解码自检失败")
  return (
    `读取${decoderUsable() ? "可解压" : "解压异常"}` +
    ` · 写入${compressionUsable() ? "压缩" : "未压缩"}`
  )
}

/* ------------------------------------------------------------- chunk CRUD */

export type DecodeFailure = {
  /** Object id, for cross-referencing against the account. */
  id: string
  /** The container id the object says its key is under. */
  meta: string
  reason: string
  /** Whether the keystore has any entry at all under that meta. */
  keyPresent: boolean
  compressed: boolean
}

export type ListResult = {
  chunks: Chunk[]
  failed: number
  failures: DecodeFailure[]
  total: number
}

export async function listChunks(
  account: SyncAccount,
  ks: Keystore,
): Promise<ListResult> {
  let response: any
  try {
    response = await api("/user/objects/" + OBJ_TYPE, account)
  } catch (error) {
    if (statusOf(error) === 404) {
      return { chunks: [], failed: 0, failures: [], total: 0 }
    }
    throw error
  }
  const objects = response?.objects ?? []
  const chunks: Chunk[] = []
  const failures: DecodeFailure[] = []
  for (const obj of objects) {
    try {
      chunks.push(decodeChunk(obj, ks))
    } catch (error) {
      let compressed = false
      try {
        compressed = hasMagic(b64ToBytes(obj?.data ?? ""))
      } catch {
        /* unreadable data is itself the answer */
      }
      failures.push({
        id: String(obj?.id ?? "?"),
        meta: String(obj?.meta ?? "?"),
        reason: error instanceof Error ? error.message : String(error),
        keyPresent: ks.keys[String(obj?.meta)] !== undefined,
        compressed,
      })
    }
  }
  return { chunks, failed: failures.length, failures, total: objects.length }
}

/**
 * Collapse failures into "reason × count", with the detail needed to tell the
 * three systemic causes apart: a keystore that opened but is empty, keys stored
 * in an unexpected shape, and a compression format we cannot read.
 */
export function summarizeFailures(result: ListResult, ks: Keystore): string[] {
  if (result.failures.length === 0) return []
  const lines: string[] = []
  const buckets: Record<string, number> = {}
  for (const failure of result.failures) {
    // Strip the object id so the same cause groups together.
    const key = failure.reason.replace(/对象 \S+ /, "对象 ").slice(0, 90)
    buckets[key] = (buckets[key] ?? 0) + 1
  }
  for (const reason of Object.keys(buckets)) {
    lines.push(`   ${reason} × ${buckets[reason]}`)
  }

  const sample = result.failures[0]
  const keyCount = Object.keys(ks.keys).length
  lines.push(
    `   示例 meta=${sample.meta.slice(0, 12)}… keystore 中${sample.keyPresent ? "有" : "没有"}这个密钥，` +
      `该对象${sample.compressed ? "带" : "不带"}压缩头`,
  )
  if (keyCount === 0) {
    lines.push("   ⚠ keystore 解开了但一个密钥都没有——账户可能从未在网页上建过 chunk，或读到的是另一个账户的 keystore。")
  } else if (!sample.keyPresent) {
    lines.push(
      `   ⚠ keystore 有 ${keyCount} 个密钥，但对不上这些对象的 meta——` +
        "auth_token 和 encryption_key 可能来自不同的账户。",
    )
  } else if (/形状不对/.test(sample.reason)) {
    const raw = ks.keys[sample.meta]
    lines.push(`   ⚠ 密钥形状：${describeKeyShape(raw)}，期望 32 字节数组。`)
  } else if (sample.compressed && !decoderUsable()) {
    lines.push("   ⚠ 对象是压缩的，但本机的 raw DEFLATE 解码自检没通过——请把这条发给作者。")
  } else {
    lines.push("   ⚠ 密钥在、形状对、解压可用，那么就是 encryption_key 不是这个账户的。")
  }
  return lines
}

async function putChunk(account: SyncAccount, chunk: Chunk, ks: Keystore) {
  const body = encodeChunk(chunk, ks)
  const response = await api("/user/objects/" + OBJ_TYPE, account, {
    method: "PUT",
    body,
  })
  return response?.id
}

async function patchChunk(account: SyncAccount, chunk: Chunk, ks: Keystore) {
  const body = encodeChunk(chunk, ks)
  const response = await api(
    "/user/objects/" + OBJ_TYPE + "/" + chunk.remoteId,
    account,
    { method: "PATCH", body },
  )
  return response?.id
}

async function deleteChunk(account: SyncAccount, remoteId: string) {
  await api("/user/objects/" + OBJ_TYPE + "/" + remoteId, account, {
    method: "DELETE",
  })
}

/* -------------------------------------------------------- export / import */

export type ExportFile = {
  format: "novelai-prompt-chunks"
  version: 1
  exportedAt: string
  counts: { chunks: number; categories: number; objects: number }
  chunks: Chunk[]
}

function stripped(chunk: Chunk): Chunk {
  const out: Record<string, unknown> = {}
  for (const field of CHUNK_FIELDS) {
    const value = (chunk as Record<string, unknown>)[field]
    if (value !== undefined) out[field] = value
  }
  return out as Chunk
}

export function makeExport(chunks: Chunk[]): ExportFile {
  const categories = chunks.filter((c) => c.isCategory && c.id !== ROOT_ID).length
  const items = chunks.filter((c) => !c.isCategory).length
  return {
    format: "novelai-prompt-chunks",
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { chunks: items, categories, objects: chunks.length },
    chunks: chunks.map(stripped),
  }
}

/** Accepts the userscript's export file, or a bare array of chunks. */
export function parseImport(text: string): Chunk[] {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("不是合法的 JSON。")
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.chunks
  if (!Array.isArray(list)) {
    throw new Error("JSON 里没有 chunks 数组。")
  }
  if (!Array.isArray(parsed) && parsed.format && parsed.format !== "novelai-prompt-chunks") {
    throw new Error("文件格式是 " + parsed.format + "，不是 novelai-prompt-chunks。")
  }
  const out: Chunk[] = []
  for (const raw of list) {
    if (!raw || typeof raw.id !== "string" || !raw.id) continue
    out.push({
      containerId: typeof raw.containerId === "string" ? raw.containerId : "",
      id: raw.id,
      label: typeof raw.label === "string" ? raw.label : "",
      expansion: typeof raw.expansion === "string" ? raw.expansion : "",
      color: typeof raw.color === "string" ? raw.color : "#6B7280",
      version: Number.isFinite(raw.version) ? raw.version : 1,
      isCategory: raw.isCategory === true ? true : raw.isCategory === false ? false : undefined,
      childOrder: Array.isArray(raw.childOrder) ? raw.childOrder : undefined,
      categoryOrder: Array.isArray(raw.categoryOrder) ? raw.categoryOrder : undefined,
    })
  }
  if (out.length === 0) throw new Error("文件里没有可用的 chunk。")
  return out
}

/* --------------------------------------------------------------- syncing */

function makeRoot(): Chunk {
  return {
    id: ROOT_ID,
    containerId: ROOT_ID,
    label: "Root Category",
    isCategory: true,
    childOrder: [],
    categoryOrder: [],
    expansion: "",
    color: "#808080",
    version: 1,
  }
}

function mergeOrder(target: string[] | undefined, source: string[] | undefined): string[] {
  const out = [...(target ?? [])]
  for (const id of source ?? []) if (out.indexOf(id) === -1) out.push(id)
  return out
}

export async function pullChunks(
  account: SyncAccount,
  log: Log,
): Promise<Chunk[]> {
  log("正在读取 keystore…")
  const ks = await loadKeystore(account)
  log(
    `keystore：${Object.keys(ks.keys).length} 个密钥` +
      `，changeIndex=${ks.changeIndex ?? "无"}` +
      `，解压${decoderUsable() ? "可用" : "不可用"}` +
      `，写入${compressionUsable() ? "压缩" : "未压缩"}`,
  )
  const result = await listChunks(account, ks)
  if (result.failed) {
    log(`⚠ ${result.failed}/${result.total} 个对象无法解密：`)
    for (const line of summarizeFailures(result, ks)) log(line)
  }
  const categories = result.chunks.filter((c) => c.isCategory && c.id !== ROOT_ID).length
  const items = result.chunks.filter((c) => !c.isCategory).length
  log(`✔ 读取到 ${items} 个 chunk、${categories} 个分类。`)
  return result.chunks
}

export type SyncPlan = {
  create: Chunk[]
  update: Chunk[]
  remove: Chunk[]
}

/**
 * Work out what a push would do, without doing it.
 *
 * `mirror` deletes remote chunks that the source does not have, so the caller
 * is expected to show this plan and get a confirmation first.
 */
export function planSync(
  source: Chunk[],
  existing: Chunk[],
  mode: SyncMode,
): SyncPlan {
  const byId: Record<string, Chunk> = {}
  for (const chunk of existing) byId[chunk.id] = chunk

  const create: Chunk[] = []
  const update: Chunk[] = []
  for (const src of source) {
    if (src.id === ROOT_ID) continue
    const target = byId[src.id]
    if (!target) {
      create.push({ ...src, containerId: src.containerId || UUID.string(), remoteId: "" })
    } else if (mode !== "merge") {
      update.push({ ...src, containerId: target.containerId, remoteId: target.remoteId })
    }
  }

  const remove: Chunk[] = []
  if (mode === "mirror") {
    const sourceIds: Record<string, boolean> = {}
    for (const chunk of source) sourceIds[chunk.id] = true
    for (const chunk of existing) {
      if (chunk.id !== ROOT_ID && !sourceIds[chunk.id]) remove.push(chunk)
    }
  }
  return { create, update, remove }
}

export async function pushChunks(
  account: SyncAccount,
  source: Chunk[],
  mode: SyncMode,
  log: Log,
): Promise<void> {
  const ks = await loadKeystore(account)
  const listed = await listChunks(account, ks)
  const existing = listed.chunks
  if (listed.failed) {
    log(`⚠ 目标账户有 ${listed.failed} 个对象无法解密，同步时会忽略它们：`)
    for (const line of summarizeFailures(listed, ks)) log(line)
  }

  const plan = planSync(source, existing, mode)
  const srcRoot = source.find((c) => c.id === ROOT_ID)
  let root = existing.find((c) => c.id === ROOT_ID)
  const rootIsNew = !root
  if (!root) root = makeRoot()

  // The root category holds ordering, so merge its lists instead of replacing
  // them — an overwrite would drop chunks the target has and the source lacks.
  if (srcRoot) {
    root.childOrder = mergeOrder(root.childOrder, srcRoot.childOrder)
    root.categoryOrder = mergeOrder(root.categoryOrder, srcRoot.categoryOrder)
    if (mode === "mirror") {
      const keep: Record<string, boolean> = {}
      for (const chunk of source) keep[chunk.id] = true
      root.childOrder = (root.childOrder ?? []).filter((id) => keep[id])
      root.categoryOrder = (root.categoryOrder ?? []).filter((id) => keep[id])
    }
  }

  log(
    `计划：新增 ${plan.create.length}、更新 ${plan.update.length}、删除 ${plan.remove.length}。`,
  )
  if (!plan.create.length && !plan.update.length && !plan.remove.length && !srcRoot) {
    log("没有需要变更的内容。")
    return
  }

  // Register every key and save the keystore FIRST. Failing halfway after
  // objects are written would leave chunks nobody can decrypt.
  for (const chunk of plan.create) keyFor(ks, chunk.containerId, true)
  keyFor(ks, root.containerId || ROOT_ID, true)
  if (ks.dirty) {
    log("正在写入 keystore…")
    await storeKeystore(account, ks)
    log("✔ keystore 已更新。")
  } else {
    log("keystore 无需更新。")
  }

  const total = plan.create.length + plan.update.length + plan.remove.length + 1
  let done = 0
  for (const chunk of plan.create) {
    await putChunk(account, chunk, ks)
    log(`  [${++done}/${total}] 新增「${chunk.label || chunk.id}」`)
  }
  for (const chunk of plan.update) {
    await patchChunk(account, chunk, ks)
    log(`  [${++done}/${total}] 更新「${chunk.label || chunk.id}」`)
  }
  for (const chunk of plan.remove) {
    if (!chunk.remoteId) continue
    await deleteChunk(account, chunk.remoteId)
    log(`  [${++done}/${total}] 删除「${chunk.label || chunk.id}」`)
  }
  if (rootIsNew) await putChunk(account, root, ks)
  else await patchChunk(account, root, ks)
  log(`  [${++done}/${total}] 写入排序信息`)
  log("✅ 完成。")
}

/* --------------------------------------------------------- local library */

export function loadCache(): Chunk[] {
  const raw = Storage.get<Chunk[]>(CACHE_KEY)
  return Array.isArray(raw) ? raw : []
}

export function saveCache(chunks: Chunk[]): Chunk[] {
  Storage.set(CACHE_KEY, chunks)
  return chunks
}

/**
 * Which category groups are collapsed, remembered per picker.
 *
 * Each prompt block gets its own scope: in the art-style block you keep the
 * style category open and everything else shut, and the character block wants
 * the opposite. One shared setting would make both wrong.
 */
export function loadCollapsed(scope: string): string[] {
  const raw = Storage.get<string[]>(COLLAPSE_PREFIX + scope)
  return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []
}

export function saveCollapsed(scope: string, ids: string[]): string[] {
  Storage.set(COLLAPSE_PREFIX + scope, ids)
  return ids
}

export type ChunkGroup = { category: Chunk | null; items: Chunk[] }

/**
 * Group loose chunks under their category, following each category's
 * childOrder and the root's categoryOrder; anything unreferenced falls into a
 * trailing "未分类" bucket so nothing silently disappears from the picker.
 */
export function groupChunks(chunks: Chunk[]): ChunkGroup[] {
  const items = chunks.filter((c) => !c.isCategory)
  const categories = chunks.filter((c) => c.isCategory && c.id !== ROOT_ID)
  const root = chunks.find((c) => c.id === ROOT_ID)

  const byId: Record<string, Chunk> = {}
  for (const item of items) byId[item.id] = item

  const claimed: Record<string, boolean> = {}
  const order = mergeOrder(root?.categoryOrder, categories.map((c) => c.id))
  const groups: ChunkGroup[] = []

  for (const categoryId of order) {
    const category = categories.find((c) => c.id === categoryId)
    if (!category) continue
    const children: Chunk[] = []
    for (const childId of category.childOrder ?? []) {
      const child = byId[childId]
      if (child && !claimed[childId]) {
        claimed[childId] = true
        children.push(child)
      }
    }
    groups.push({ category, items: children })
  }

  const loose: Chunk[] = []
  for (const id of mergeOrder(root?.childOrder, items.map((c) => c.id))) {
    if (claimed[id]) continue
    const item = byId[id]
    if (item) {
      claimed[id] = true
      loose.push(item)
    }
  }
  if (loose.length) groups.push({ category: null, items: loose })
  return groups.filter((group) => group.items.length > 0 || group.category != null)
}

/* ------------------------------------------------------- local authoring */

function rootOf(chunks: Chunk[]): Chunk {
  const existing = chunks.find((c) => c.id === ROOT_ID)
  if (existing) return existing
  return {
    id: ROOT_ID,
    containerId: ROOT_ID,
    label: "Root Category",
    isCategory: true,
    childOrder: [],
    categoryOrder: [],
    expansion: "",
    color: "#808080",
    version: 1,
  }
}

/**
 * Add a chunk to the local library.
 *
 * Ordering lives in the category objects, not in the chunk, so a new chunk has
 * to be threaded into the right childOrder as well — otherwise it shows up in
 * the picker's "unsorted" bucket and lands in a different place once the
 * account syncs it back.
 */
export function createChunk(
  chunks: Chunk[],
  draft: { label: string; expansion: string; color?: string; categoryId?: string },
): Chunk[] {
  const chunk: Chunk = {
    id: UUID.string(),
    containerId: UUID.string(),
    label: draft.label.trim(),
    expansion: draft.expansion.trim(),
    color: draft.color || "#6B7280",
    version: 1,
    isCategory: false,
  }

  const out = chunks.slice()
  const categoryId = draft.categoryId && draft.categoryId !== ROOT_ID ? draft.categoryId : ""
  const holderIndex = out.findIndex((c) =>
    categoryId ? c.id === categoryId : c.id === ROOT_ID,
  )

  if (holderIndex === -1) {
    const root = rootOf(out)
    root.childOrder = (root.childOrder ?? []).concat(chunk.id)
    out.push(root)
  } else {
    const holder = { ...out[holderIndex] }
    holder.childOrder = (holder.childOrder ?? []).concat(chunk.id)
    out[holderIndex] = holder
  }

  out.push(chunk)
  return out
}

export function updateChunk(
  chunks: Chunk[],
  id: string,
  next: { label?: string; expansion?: string; color?: string },
): Chunk[] {
  return chunks.map((chunk) =>
    chunk.id === id
      ? {
          ...chunk,
          label: next.label !== undefined ? next.label.trim() : chunk.label,
          expansion:
            next.expansion !== undefined ? next.expansion.trim() : chunk.expansion,
          color: next.color !== undefined ? next.color : chunk.color,
          // Bumping the version is what marks the object as edited for a sync.
          version: (chunk.version ?? 1) + 1,
        }
      : chunk,
  )
}

/** Remove a chunk and every ordering entry that referenced it. */
export function deleteChunkLocal(chunks: Chunk[], id: string): Chunk[] {
  return chunks
    .filter((chunk) => chunk.id !== id)
    .map((chunk) =>
      chunk.isCategory
        ? {
            ...chunk,
            childOrder: (chunk.childOrder ?? []).filter((child) => child !== id),
            categoryOrder: (chunk.categoryOrder ?? []).filter((child) => child !== id),
          }
        : chunk,
    )
}

/** Categories a new chunk can be filed under. */
export function categoriesOf(chunks: Chunk[]): Chunk[] {
  return chunks.filter((chunk) => chunk.isCategory && chunk.id !== ROOT_ID)
}

export function searchChunks(chunks: Chunk[], query: string): Chunk[] {
  const needle = query.trim().toLowerCase()
  const items = chunks.filter((c) => !c.isCategory)
  if (!needle) return items
  return items.filter(
    (c) =>
      c.label.toLowerCase().indexOf(needle) !== -1 ||
      c.expansion.toLowerCase().indexOf(needle) !== -1,
  )
}
