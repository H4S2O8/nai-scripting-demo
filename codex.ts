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
  /** The site's own id, so a draw can be remembered across sessions. */
  id: string
  title: string
  path: string[]
  /** The base prompt: scene, framing, and whatever is not per-character. */
  tags: string
  /**
   * Per-character prompts, in slot order — the site stores V4-style split
   * prompts, and for about a quarter of 所长色色 this is where the action is.
   * They are choreography ("standing before character1", "holding leash"),
   * meant to be appended to whatever character already sits in each slot.
   */
  characters: string[]
  /**
   * Whether any character prompt names hair, eyes, ears, horns and the like.
   * Rare (4%), but such an entry will fight the user's own character rather
   * than pose it, so the picker says so.
   */
  identity: boolean
}

export type Codex = {
  id: string
  title: string
  version: string
  release: string
  /** Bumped when the slimmed shape changes; an older cache is re-fetched. */
  schema: number
  tree: CodexNode[]
  entries: CodexEntry[]
}

const CACHE_SCHEMA = 3

/* ------------------------------------------------------------ tree helpers */

/** The node at a path, or null. */
function nodeAt(tree: CodexNode[], path: string[]): CodexNode | null {
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
    // An entry whose base is empty but whose characters are not is still a
    // draw — that is exactly the shape a quarter of the codex takes.
    if (!entry.tags.trim() && entry.characters.length === 0) return false
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

/* ---------------------------------------------------------- drawn record */

const DRAWN_PREFIX = "nai.codex.drawn."

/** Ids already drawn from this codex, so they are not offered again. */
export function loadDrawn(codexId: string): Record<string, boolean> {
  const raw = Storage.get<string[]>(DRAWN_PREFIX + codexId)
  const out: Record<string, boolean> = {}
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === "string") out[id] = true
  return out
}

export function markDrawn(codexId: string, id: string): Record<string, boolean> {
  const drawn = loadDrawn(codexId)
  drawn[id] = true
  Storage.set(DRAWN_PREFIX + codexId, Object.keys(drawn))
  return drawn
}

/**
 * Forget draws. With `ids`, only those — used to reset one category without
 * touching the record for the rest of the codex.
 */
export function resetDrawn(codexId: string, ids?: string[]): Record<string, boolean> {
  if (!ids) {
    Storage.set(DRAWN_PREFIX + codexId, [])
    return {}
  }
  const drawn = loadDrawn(codexId)
  for (const id of ids) delete drawn[id]
  Storage.set(DRAWN_PREFIX + codexId, Object.keys(drawn))
  return drawn
}

/** The entries not yet drawn. */
export function undrawn(list: CodexEntry[], drawn: Record<string, boolean>): CodexEntry[] {
  return list.filter((entry) => !drawn[entry.id])
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
    if (
      parsed &&
      typeof parsed.release === "string" &&
      Array.isArray(parsed.entries) &&
      parsed.schema === CACHE_SCHEMA
    ) {
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

/**
 * Words that describe who a character IS rather than what they are doing.
 *
 * Drawn from a census of 所长色色's character prompts: 87% carry pose and
 * interaction, and only these identity words — in 4% of them — would override
 * a character the user has already written. Body-shape words (curvy, small
 * breasts) are left out on purpose: they are part of most poses' vocabulary
 * and flagging them would mark half the codex.
 */
const IDENTITY_WORDS =
  /\b(?:blonde|(?:black|brown|silver|white|grey|gray|red|blue|pink|purple|green|orange|blonde) hair|twintails?|ponytail|braids?|bangs|(?:blue|red|green|brown|purple|yellow|golden|amber|grey|gray|pink|heterochromia) eyes|heterochromia|elf|(?:cat|fox|dog|wolf|bunny|rabbit|animal) ears|horns?|wings|halo)\b/i

function characterPromptsOf(entry: any): string[] {
  if (!Array.isArray(entry?.characterPrompts)) return []
  return entry.characterPrompts
    .map((character: any) => String(character?.prompt ?? "").trim().replace(/^[,\s]+|[,\s]+$/g, ""))
    .filter((prompt: string) => prompt.length > 0)
}

/** Keep what the picker needs and drop the image metadata, which is most of the file. */
export function slim(raw: any, id: string, release: string): Codex {
  const entries: CodexEntry[] = (Array.isArray(raw?.entries) ? raw.entries : [])
    .filter((entry: any) => entry && typeof entry === "object")
    .map((entry: any, index: number) => ({
      // The site's id when it has one; otherwise something stable enough to
      // remember a draw by, which a position in the file is not.
      id: String(entry.id ?? "").trim() || `${(entry.path ?? []).join("/")}#${entry.title ?? index}`,
      title: String(entry.title ?? "").trim(),
      path: Array.isArray(entry.path) ? entry.path.map((seg: any) => String(seg)) : [],
      tags: String(entry.tags ?? "").trim().replace(/^[,\s]+|[,\s]+$/g, ""),
      characters: characterPromptsOf(entry),
      identity: characterPromptsOf(entry).some((prompt) => IDENTITY_WORDS.test(prompt)),
    }))
  return {
    id,
    title: String(raw?.title ?? id),
    version: String(raw?.version ?? ""),
    release,
    schema: CACHE_SCHEMA,
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
