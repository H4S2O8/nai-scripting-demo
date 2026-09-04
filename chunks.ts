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
import { secretbox, secretboxOpen } from "./nacl"

const API = "https://image.novelai.net"
const OBJ_TYPE = "promptmacros"
/** Root category: holds the ordering of loose chunks and of categories. */
export const ROOT_ID = "default"
const MAGIC = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]

const SYNC_TOKEN_KEY = "nai_sync_token"
const ENC_KEY_KEY = "nai_encryption_key"
const CACHE_KEY = "nai.chunks.v1"

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
 * NovelAI compresses payloads with raw DEFLATE (fflate). Apple's compression
 * framework calls raw DEFLATE "zlib", so `Data.compressed("zlib")` should be
 * the same bytes — but "should be" is how this platform eats a week, so prove
 * it at runtime against a fixture produced by a real raw-DEFLATE encoder.
 */
const PROBE_PLAIN = "novelai-prompt-chunks probe"
const PROBE_RAW_DEFLATE_B64 = "y8svS81JzNQtKMrPLSjRTc4ozcsuVigoyk9KBQA="

let compressionProbe: boolean | null = null

export function compressionUsable(): boolean {
  if (compressionProbe != null) return compressionProbe
  compressionProbe = false
  try {
    // 1. The platform must read a blob a real raw-DEFLATE encoder produced.
    const decoded = inflateRaw(b64ToBytes(PROBE_RAW_DEFLATE_B64))
    if (fromUtf8(decoded) !== PROBE_PLAIN) return false
    // 2. And its own output must survive the same path.
    const round = inflateRaw(deflateRawUnchecked(utf8(PROBE_PLAIN)))
    compressionProbe = fromUtf8(round) === PROBE_PLAIN
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

function inflateRaw(bytes: Uint8Array): Uint8Array {
  const data = Data.fromUint8Array(bytes)
  if (data == null) throw new Error("解压输入无效")
  const out = data.decompressed("zlib").toUint8Array()
  if (!out) throw new Error("解压失败")
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

function keyFor(
  ks: Keystore,
  containerId: string,
  createIfMissing: boolean,
): Uint8Array | null {
  const existing = ks.keys[containerId]
  if (existing) return new Uint8Array(existing)
  if (!createIfMissing) return null
  const key = randomBytes(32)
  ks.keys[containerId] = Array.from(key)
  ks.dirty = true
  return key
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
  if (compressed) plain = inflateRaw(plain)

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
  return compressionUsable() ? "压缩(raw deflate)" : "未压缩"
}

/* ------------------------------------------------------------- chunk CRUD */

export async function listChunks(
  account: SyncAccount,
  ks: Keystore,
): Promise<{ chunks: Chunk[]; failed: number }> {
  let response: any
  try {
    response = await api("/user/objects/" + OBJ_TYPE, account)
  } catch (error) {
    if (statusOf(error) === 404) return { chunks: [], failed: 0 }
    throw error
  }
  const chunks: Chunk[] = []
  let failed = 0
  for (const obj of response?.objects ?? []) {
    try {
      chunks.push(decodeChunk(obj, ks))
    } catch (error) {
      failed++
      console.warn("[chunks] 跳过一个对象: " + String(error))
    }
  }
  return { chunks, failed }
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
  log(`keystore 里有 ${Object.keys(ks.keys).length} 个密钥。`)
  const { chunks, failed } = await listChunks(account, ks)
  if (failed) log(`⚠ ${failed} 个对象无法解密，已跳过。`)
  const categories = chunks.filter((c) => c.isCategory && c.id !== ROOT_ID).length
  const items = chunks.filter((c) => !c.isCategory).length
  log(`✔ 读取到 ${items} 个 chunk、${categories} 个分类。`)
  return chunks
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
  const { chunks: existing, failed } = await listChunks(account, ks)
  if (failed) log(`⚠ 目标账户有 ${failed} 个对象无法解密，同步时会忽略它们。`)

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
