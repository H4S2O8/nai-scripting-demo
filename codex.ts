/**
 * Prompt codices from novelai.quicktagcloud.com (法典图鉴), for drawing a
 * random entry into the prompt.
 *
 * The site is a static bundle: data/current.json names the current release,
 * releases/<release>/codexes.json lists the codices, and each codex is one
 * JSON file with a category tree and every entry. Nothing is per-category, so
 * the whole codex has to come down once — 8 MB for the biggest, most of it
 * image metadata this app never uses. It is slimmed to {title, path, tags}
 * (about half) and cached on disk, keyed by release, so a second use costs
 * one small pointer fetch.
 *
 * The site's ?p= short code is FNV-1a of the category path, base36. It is a
 * pure function of the path, so a link from the site can be resolved without
 * asking the site anything — encodePathCode below is a line-for-line port of
 * its path-code.js.
 */
const SITE = "https://novelai.quicktagcloud.com"
const DATA = SITE + "/data"
const CACHE_DIR = "/.codex"
const CODEX_LIST_KEY = "nai.codex.list.v1"

/** The codex this feature was built for; the picker starts here. */
export const DEFAULT_CODEX = "suozhang_r18"

export type CodexMeta = {
  id: string
  name: string
  entryCount: number
  nsfw: boolean
  /** Some codices are hosted elsewhere and only listed here. */
  dataUrl?: string
}

export type CodexNode = {
  name: string
  count: number
  children: CodexNode[]
}

export type CodexEntry = {
  title: string
  path: string[]
  tags: string
}

export type Codex = {
  id: string
  title: string
  version: string
  release: string
  tree: CodexNode[]
  entries: CodexEntry[]
}

/* -------------------------------------------------------------- short code */

// path-code.js: the separator is the ASCII unit separator, a control character,
// because category names have contained both "/" and "+".
const PATH_SEP = "\u001f"

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    hash ^= code & 0xff
    hash = Math.imul(hash, 0x01000193)
    hash ^= (code >>> 8) & 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The site's ?p= code for a category path. Empty for the root. */
export function encodePathCode(path: string[]): string {
  const segments = path.map((seg) => String(seg || "").trim()).filter(Boolean)
  if (segments.length === 0) return ""
  return fnv1a(segments.join(PATH_SEP)).toString(36)
}

/** Resolve a ?p= code against a tree. Empty when nothing matches. */
export function pathFromCode(tree: CodexNode[], code: string): string[] {
  const wanted = String(code || "").trim()
  if (!wanted) return []
  let found: string[] = []
  const walk = (nodes: CodexNode[], prefix: string[]): boolean => {
    for (const node of nodes) {
      const path = prefix.concat(node.name)
      if (encodePathCode(path) === wanted) {
        found = path
        return true
      }
      if (walk(node.children, path)) return true
    }
    return false
  }
  walk(tree, [])
  return found
}

/**
 * Pull the codex id and ?p= code out of a pasted site URL.
 *
 * Accepts the full address, or just the query string, or just a code. Returns
 * null only when there is nothing usable at all.
 */
export function parseSiteLink(text: string): { codex: string; code: string } | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const query = trimmed.indexOf("?") >= 0 ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed
  const params: Record<string, string> = {}
  for (const pair of query.split(/[&#]/)) {
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    try {
      params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
    } catch {
      /* a malformed escape is not worth failing the whole paste over */
    }
  }
  if (params.c || params.p) return { codex: params.c ?? "", code: params.p ?? "" }
  // A bare short code, as someone might copy from the address bar's tail.
  if (/^[0-9a-z]{4,10}$/.test(trimmed)) return { codex: "", code: trimmed }
  return null
}

/* ------------------------------------------------------------ tree helpers */

/** The node at a path, or null. */
export function nodeAt(tree: CodexNode[], path: string[]): CodexNode | null {
  let nodes = tree
  let node: CodexNode | null = null
  for (const name of path) {
    node = nodes.find((n) => n.name === name) ?? null
    if (!node) return null
    nodes = node.children
  }
  return node
}

/** Children of a path; the root's children for an empty path. */
export function childrenAt(tree: CodexNode[], path: string[]): CodexNode[] {
  if (path.length === 0) return tree
  return nodeAt(tree, path)?.children ?? []
}

/**
 * Entries filed under a category, including every subcategory.
 *
 * Any node is a valid pick, not only leaves: the site's own ?p= links point at
 * top-level categories as readily as at deep ones. Entries with no prompt are
 * excluded here rather than at draw time, so the count shown is the count that
 * can actually be drawn from.
 */
export function entriesUnder(entries: CodexEntry[], path: string[]): CodexEntry[] {
  return entries.filter((entry) => {
    if (!entry.tags.trim()) return false
    if (entry.path.length < path.length) return false
    for (let i = 0; i < path.length; i++) {
      if (entry.path[i] !== path[i]) return false
    }
    return true
  })
}

export function randomEntry(list: CodexEntry[]): CodexEntry | null {
  if (list.length === 0) return null
  return list[Math.floor(Math.random() * list.length)]
}

/* ------------------------------------------------------------------ fetch */

async function fetchJson(url: string, timeout: number): Promise<any> {
  const response = await fetch(url, { method: "GET", timeout, debugLabel: "codex " + url })
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${url}`)
  return response.json()
}

async function currentRelease(): Promise<string> {
  const pointer = await fetchJson(DATA + "/current.json", 20)
  const release = String(pointer?.release ?? "").trim()
  if (!release) throw new Error("current.json 里没有 release")
  return release
}

function parseCodexList(raw: any): CodexMeta[] {
  const list = Array.isArray(raw) ? raw : raw?.codexes ?? raw?.items ?? []
  return list
    .filter((item: any) => item && typeof item.id === "string")
    .map((item: any) => ({
      id: item.id,
      name: String(item.name ?? item.title ?? item.id),
      entryCount: Number(item.entryCount ?? 0),
      nsfw: item.nsfw === true,
      dataUrl: typeof item.dataUrl === "string" ? item.dataUrl : undefined,
    }))
}

/** The codex list. Small, so it is fetched fresh and only cached as a fallback. */
export async function loadCodexList(): Promise<CodexMeta[]> {
  try {
    const release = await currentRelease()
    const list = parseCodexList(await fetchJson(`${DATA}/releases/${release}/codexes.json`, 20))
    if (list.length) Storage.set(CODEX_LIST_KEY, list)
    return list
  } catch (error) {
    const cached = Storage.get<CodexMeta[]>(CODEX_LIST_KEY)
    if (Array.isArray(cached) && cached.length) return cached
    throw error
  }
}

function cachePath(id: string): string {
  const root = FileManager.documentsDirectory.replace(/\/+$/, "") + "/NAI-Studio" + CACHE_DIR
  return root + "/" + id.replace(/[^A-Za-z0-9_-]/g, "_") + ".json"
}

function readCache(id: string): Codex | null {
  const path = cachePath(id)
  try {
    if (!FileManager.existsSync(path)) return null
    const parsed = JSON.parse(FileManager.readAsStringSync(path))
    if (parsed && typeof parsed.release === "string" && Array.isArray(parsed.entries)) {
      return parsed as Codex
    }
  } catch {
    /* a corrupt cache is the same as no cache */
  }
  return null
}

function writeCache(codex: Codex) {
  const path = cachePath(codex.id)
  const dir = path.slice(0, path.lastIndexOf("/"))
  if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
  FileManager.writeAsStringSync(path, JSON.stringify(codex))
}

function normalizeTree(raw: any): CodexNode[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((node) => node && typeof node.name === "string" && node.name.trim())
    .map((node) => ({
      name: String(node.name).trim(),
      count: Number(node.count ?? 0),
      children: normalizeTree(node.children),
    }))
}

/** Keep what the picker needs and drop the image metadata, which is most of the file. */
function slim(raw: any, id: string, release: string): Codex {
  const entries: CodexEntry[] = (Array.isArray(raw?.entries) ? raw.entries : [])
    .filter((entry: any) => entry && typeof entry === "object")
    .map((entry: any) => ({
      title: String(entry.title ?? "").trim(),
      path: Array.isArray(entry.path) ? entry.path.map((seg: any) => String(seg)) : [],
      tags: String(entry.tags ?? "").trim(),
    }))
  return {
    id,
    title: String(raw?.title ?? id),
    version: String(raw?.version ?? ""),
    release,
    tree: normalizeTree(raw?.tree),
    entries,
  }
}

export type CodexLoad = { codex: Codex; fromCache: boolean }

/**
 * Load a codex, from disk when the site's release has not moved.
 *
 * The release check is one small fetch. When it fails — offline, say — a cached
 * copy is served anyway, marked as such: a slightly stale codex beats no
 * codex for a feature whose whole job is drawing something at random.
 */
export async function loadCodex(
  meta: CodexMeta,
  onStatus?: (line: string) => void,
): Promise<CodexLoad> {
  const say = onStatus ?? (() => {})
  const cached = readCache(meta.id)

  let release: string
  try {
    release = await currentRelease()
  } catch (error) {
    if (cached) {
      say("网络不可用，使用本地缓存")
      return { codex: cached, fromCache: true }
    }
    throw error
  }

  if (cached && cached.release === release) {
    return { codex: cached, fromCache: true }
  }

  const url = meta.dataUrl || `${DATA}/releases/${release}/${meta.id}.json`
  say(cached ? "网站有更新，正在重新下载…" : "首次使用，正在下载词典（约几 MB）…")
  const raw = await fetchJson(url, 180)
  const codex = slim(raw, meta.id, release)
  if (codex.entries.length === 0) throw new Error("词典是空的")
  try {
    writeCache(codex)
  } catch {
    /* no cache is a slower next time, not a failure now */
  }
  return { codex, fromCache: false }
}

/** Drop the on-disk copy, so the next load fetches again. */
export function clearCodexCache(id: string) {
  const path = cachePath(id)
  if (FileManager.existsSync(path)) FileManager.removeSync(path)
}
