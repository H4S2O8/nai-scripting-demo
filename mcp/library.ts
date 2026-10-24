/**
 * The image library: every generated image, with its parameters, filed under
 * a project and any number of tags.
 *
 * R2 holds the pixels and this holds the index. Projects and tags live only
 * here and never in the object key, because keys are immutable and a link
 * handed out once has to keep working however the image is re-filed later.
 *
 * Images whose R2 object has been deleted stay in the library as `archive`:
 * the key is also their path inside the Mac backup
 * (~/Backups/r2/socialsight-previews/<key>), so the record still says where the
 * file is even though it has no public link any more.
 *
 * SQLite through better-sqlite3: one file next to the images, synchronous, and
 * a few thousand rows is nothing. Node 20 on the server has no node:sqlite.
 */
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type Stored = "r2" | "local" | "archive"

export type CharacterRecord = {
  prompt: string
  negative: string
  /** Null when the model was left to place the character. */
  x: number | null
  y: number | null
}

export type NewImage = {
  key: string
  url: string | null
  stored: Stored
  createdAt: string
  model: string | null
  /** NovelAI's own `Source` text chunk, e.g. "NovelAI Diffusion V5 0ADF9AB7". */
  source: string | null
  width: number | null
  height: number | null
  steps: number | null
  guidance: number | null
  sampler: string | null
  seed: number | null
  prompt: string
  negative: string
  characters: CharacterRecord[]
  /** Share of see-through pixels, 0..1; null when it could not be measured. */
  transparent: number | null
  bytes: number | null
  account: string | null
  cost: number | null
  origin: "generate" | "backfill"
  project?: string | null
  tags?: string[]
  note?: string
  /** The shot this image was drawn for, as one of its candidates. */
  shotId?: number | null
}

/**
 * Where an image stands within its shot. Null for images drawn outside any
 * shot. A novel shot has at most one `picked`; a gallery shot keeps as many as
 * it likes.
 */
export type Verdict = "candidate" | "picked" | "rejected"

export type ImageRow = Omit<NewImage, "project" | "tags" | "note" | "shotId"> & {
  id: number
  project: string | null
  tags: string[]
  note: string
  shotId: number | null
  verdict: Verdict | null
  /** Recommended by the agent; the pick itself is the project's picker's call. */
  favorite: boolean
  /** When the pixels were deleted from R2 (rejected and expired); the record stays. */
  purgedAt: string | null
}

export type SearchFilters = {
  project?: string
  /** Only images filed under no project. */
  unfiled?: boolean
  /** Every one of these tags. */
  tags?: string[]
  /** Substring of the prompt, the character captions, the note or the key. */
  text?: string
  model?: string
  stored?: Stored
  /** ISO date or datetime, inclusive. */
  since?: string
  /** ISO date or datetime, exclusive. */
  until?: string
  oldestFirst?: boolean
  limit?: number
  offset?: number
}

export type Changes = {
  /** A name files the images there (creating the project); null unfiles them. */
  project?: string | null
  addTags?: string[]
  removeTags?: string[]
  note?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  url         TEXT,
  stored      TEXT NOT NULL CHECK (stored IN ('r2', 'local', 'archive')),
  created_at  TEXT NOT NULL,
  model       TEXT,
  source      TEXT,
  width       INTEGER,
  height      INTEGER,
  steps       INTEGER,
  guidance    REAL,
  sampler     TEXT,
  seed        INTEGER,
  prompt      TEXT NOT NULL DEFAULT '',
  negative    TEXT NOT NULL DEFAULT '',
  characters  TEXT NOT NULL DEFAULT '[]',
  transparent REAL,
  bytes       INTEGER,
  account     TEXT,
  cost        INTEGER,
  origin      TEXT NOT NULL CHECK (origin IN ('generate', 'backfill')),
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS images_created ON images(created_at);
CREATE INDEX IF NOT EXISTS images_project ON images(project_id, created_at);
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS image_tags (
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (image_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS image_tags_tag ON image_tags(tag_id);
`

/** Tables added by schema version 2: the studio's structure around the images. */
const STUDIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS characters (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL COLLATE NOCASE,
  name       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',
  outfits    TEXT NOT NULL DEFAULT '{}',
  notes      TEXT NOT NULL DEFAULT '',
  UNIQUE (project_id, key)
);
CREATE TABLE IF NOT EXISTS chapters (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  split      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, ord)
);
CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  cont       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pages_chapter ON pages(chapter_id, ord);
CREATE TABLE IF NOT EXISTS shots (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id    INTEGER UNIQUE REFERENCES pages(id) ON DELETE SET NULL,
  title      TEXT NOT NULL DEFAULT '',
  prompt     TEXT NOT NULL DEFAULT '',
  negative   TEXT NOT NULL DEFAULT '',
  characters TEXT NOT NULL DEFAULT '[]',
  model      TEXT,
  width      INTEGER,
  height     INTEGER,
  steps      INTEGER,
  guidance   REAL,
  sampler    TEXT,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shots_project ON shots(project_id);
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target      TEXT NOT NULL CHECK (target IN ('project', 'page', 'shot', 'image')),
  target_id   INTEGER,
  author      TEXT NOT NULL CHECK (author IN ('human', 'agent')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS feedback_open ON feedback(project_id, resolved_at);
`

/** Trimmed, inner whitespace collapsed; empty is refused rather than stored. */
export function cleanName(raw: string, what: string): string {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ")
  if (!name) throw new Error(`${what}不能为空`)
  if (name.length > 80) throw new Error(`${what}太长（最多 80 字）：${name.slice(0, 20)}…`)
  return name
}

export function cleanTags(raw: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of raw ?? []) {
    const name = cleanName(tag, "标签")
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

export class Library {
  readonly path: string
  private db: Database.Database

  constructor(path: string) {
    this.path = path
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
    this.db.pragma("busy_timeout = 5000")
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /**
   * Schema versions, by PRAGMA user_version. 0/1 is the image library as first
   * deployed; 2 adds the studio — project kinds, characters, chapters and
   * pages, shots, candidate verdicts and review feedback. Each step only adds
   * columns and tables, so a live database upgrades in place.
   */
  private migrate() {
    const version = this.db.pragma("user_version", { simple: true }) as number
    if (version < 2) {
      this.db.transaction(() => {
        this.db.exec(STUDIO_SCHEMA)
        const has = (table: string, column: string) =>
          (this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column) ?? null) !== null
        const add = (table: string, column: string, ddl: string) => {
          if (!has(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
        }
        add("projects", "kind", "TEXT NOT NULL DEFAULT 'gallery' CHECK (kind IN ('gallery', 'novel'))")
        add("projects", "style", "TEXT NOT NULL DEFAULT '{}'")
        add("projects", "layout", "TEXT NOT NULL DEFAULT '{}'")
        add("projects", "picker", "TEXT NOT NULL DEFAULT 'human' CHECK (picker IN ('human', 'agent'))")
        add("images", "shot_id", "INTEGER REFERENCES shots(id) ON DELETE SET NULL")
        add("images", "verdict", "TEXT CHECK (verdict IN ('candidate', 'picked', 'rejected'))")
        add("images", "favorite", "INTEGER NOT NULL DEFAULT 0")
        add("images", "purged_at", "TEXT")
        this.db.exec("CREATE INDEX IF NOT EXISTS images_shot ON images(shot_id, verdict)")
        this.db.pragma("user_version = 2")
      })()
    }
  }

  close() {
    this.db.close()
  }

  /** The underlying handle, for the backup script's online copy. */
  get handle(): Database.Database {
    return this.db
  }

  private projectId(name: string): number {
    const clean = cleanName(name, "项目名")
    const found = this.db.prepare("SELECT id FROM projects WHERE name = ?").get(clean) as
      | { id: number }
      | undefined
    if (found) return found.id
    return Number(
      this.db
        .prepare("INSERT INTO projects (name, created_at) VALUES (?, ?)")
        .run(clean, new Date().toISOString()).lastInsertRowid,
    )
  }

  private tagId(name: string): number {
    const found = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as
      | { id: number }
      | undefined
    if (found) return found.id
    return Number(this.db.prepare("INSERT INTO tags (name) VALUES (?)").run(name).lastInsertRowid)
  }

  private addTagsTo(imageId: number, tags: string[]) {
    const link = this.db.prepare("INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)")
    for (const tag of tags) link.run(imageId, this.tagId(tag))
  }

  /** Record one image. Returns its id, or the existing id when the key is already known. */
  add(image: NewImage): { id: number; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM images WHERE key = ?").get(image.key) as
        | { id: number }
        | undefined
      if (existing) return { id: existing.id, created: false }
      const tags = cleanTags(image.tags)
      const projectId = image.project ? this.projectId(image.project) : null
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO images (key, url, stored, created_at, model, source, width, height, steps,
               guidance, sampler, seed, prompt, negative, characters, transparent, bytes, account,
               cost, origin, project_id, note, shot_id, verdict)
             VALUES (@key, @url, @stored, @createdAt, @model, @source, @width, @height, @steps,
               @guidance, @sampler, @seed, @prompt, @negative, @characters, @transparent, @bytes,
               @account, @cost, @origin, @projectId, @note, @shotId, @verdict)`,
          )
          .run({
            ...image,
            characters: JSON.stringify(image.characters ?? []),
            projectId,
            note: image.note ?? "",
            shotId: image.shotId ?? null,
            verdict: image.shotId ? "candidate" : null,
          }).lastInsertRowid,
      )
      this.addTagsTo(id, tags)
      return { id, created: true }
    })()
  }

  /** Mark keys as living only in the Mac backup now: no public link. */
  archive(keys: string[]): number {
    const mark = this.db.prepare("UPDATE images SET stored = 'archive', url = NULL WHERE key = ? AND stored <> 'archive'")
    return this.db.transaction(() => keys.reduce((n, key) => n + mark.run(key).changes, 0))()
  }

  hydrate(rows: any[]): ImageRow[] {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const tagRows = this.db
      .prepare(
        `SELECT it.image_id AS id, t.name AS name FROM image_tags it JOIN tags t ON t.id = it.tag_id
         WHERE it.image_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`,
      )
      .all(...ids) as { id: number; name: string }[]
    const tagsOf = new Map<number, string[]>()
    for (const row of tagRows) tagsOf.set(row.id, [...(tagsOf.get(row.id) ?? []), row.name])
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      url: r.url,
      stored: r.stored,
      createdAt: r.created_at,
      model: r.model,
      source: r.source,
      width: r.width,
      height: r.height,
      steps: r.steps,
      guidance: r.guidance,
      sampler: r.sampler,
      seed: r.seed,
      prompt: r.prompt,
      negative: r.negative,
      characters: JSON.parse(r.characters),
      transparent: r.transparent,
      bytes: r.bytes,
      account: r.account,
      cost: r.cost,
      origin: r.origin,
      project: r.project,
      tags: tagsOf.get(r.id) ?? [],
      note: r.note,
      shotId: r.shot_id ?? null,
      verdict: r.verdict ?? null,
      favorite: r.favorite === 1,
      purgedAt: r.purged_at ?? null,
    }))
  }

  search(filters: SearchFilters = {}): { total: number; rows: ImageRow[] } {
    const where: string[] = []
    const args: unknown[] = []
    if (filters.project != null && filters.unfiled) throw new Error("project 和 unfiled 不能同时用")
    if (filters.project != null) {
      const project = this.db
        .prepare("SELECT id FROM projects WHERE name = ?")
        .get(cleanName(filters.project, "项目名")) as { id: number } | undefined
      if (!project) throw new Error(`没有叫「${filters.project}」的项目`)
      where.push("i.project_id = ?")
      args.push(project.id)
    }
    if (filters.unfiled) where.push("i.project_id IS NULL")
    for (const tag of cleanTags(filters.tags)) {
      where.push(
        "EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = i.id AND t.name = ?)",
      )
      args.push(tag)
    }
    if (filters.text?.trim()) {
      const like = "%" + filters.text.trim().replace(/[\\%_]/g, (c) => "\\" + c) + "%"
      where.push(
        "(i.prompt LIKE ? ESCAPE '\\' OR i.characters LIKE ? ESCAPE '\\' OR i.note LIKE ? ESCAPE '\\' OR i.key LIKE ? ESCAPE '\\')",
      )
      args.push(like, like, like, like)
    }
    if (filters.model) {
      where.push("i.model = ?")
      args.push(filters.model)
    }
    if (filters.stored) {
      where.push("i.stored = ?")
      args.push(filters.stored)
    }
    if (filters.since) {
      where.push("i.created_at >= ?")
      args.push(filters.since)
    }
    if (filters.until) {
      where.push("i.created_at < ?")
      args.push(filters.until)
    }
    const clause = where.length ? "WHERE " + where.join(" AND ") : ""
    const total = (this.db.prepare(`SELECT count(*) AS n FROM images i ${clause}`).get(...args) as { n: number }).n
    const limit = Math.min(100, Math.max(1, Math.floor(filters.limit ?? 20)))
    const offset = Math.max(0, Math.floor(filters.offset ?? 0))
    const rows = this.db
      .prepare(
        `SELECT i.*, p.name AS project FROM images i LEFT JOIN projects p ON p.id = i.project_id
         ${clause} ORDER BY i.created_at ${filters.oldestFirst ? "ASC" : "DESC"}, i.id ${filters.oldestFirst ? "ASC" : "DESC"}
         LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset)
    return { total, rows: this.hydrate(rows) }
  }

  get(ids: number[]): ImageRow[] {
    if (ids.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT i.*, p.name AS project FROM images i LEFT JOIN projects p ON p.id = i.project_id
         WHERE i.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids)
    const found = this.hydrate(rows)
    const missing = ids.filter((id) => !found.some((row) => row.id === id))
    if (missing.length) throw new Error(`没有这些图片 id：${missing.join(", ")}`)
    return ids.map((id) => found.find((row) => row.id === id)!)
  }

  update(ids: number[], changes: Changes): ImageRow[] {
    if (ids.length === 0) throw new Error("没有给图片 id")
    const add = cleanTags(changes.addTags)
    const remove = cleanTags(changes.removeTags)
    const both = add.filter((tag) => remove.some((r) => r.toLowerCase() === tag.toLowerCase()))
    if (both.length) throw new Error(`同一个标签不能既加又删：${both.join(", ")}`)
    this.db.transaction(() => {
      this.get(ids) // throws on unknown ids before anything changes
      if (changes.project !== undefined) {
        const projectId = changes.project === null ? null : this.projectId(changes.project)
        const set = this.db.prepare("UPDATE images SET project_id = ? WHERE id = ?")
        for (const id of ids) set.run(projectId, id)
      }
      if (changes.note !== undefined) {
        const set = this.db.prepare("UPDATE images SET note = ? WHERE id = ?")
        for (const id of ids) set.run(changes.note, id)
      }
      for (const id of ids) this.addTagsTo(id, add)
      if (remove.length) {
        const unlink = this.db.prepare(
          "DELETE FROM image_tags WHERE image_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
        )
        for (const id of ids) for (const tag of remove) unlink.run(id, tag)
      }
      // A tag nothing uses any more is just noise in the overview.
      this.db.exec("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM image_tags)")
    })()
    return this.get(ids)
  }

  /** Create a project, or change an existing one's description or name. */
  project(name: string, options: { description?: string; renameTo?: string } = {}) {
    return this.db.transaction(() => {
      const id = this.projectId(name)
      if (options.description !== undefined) {
        this.db.prepare("UPDATE projects SET description = ? WHERE id = ?").run(options.description.trim(), id)
      }
      if (options.renameTo !== undefined) {
        const to = cleanName(options.renameTo, "项目名")
        const clash = this.db.prepare("SELECT id FROM projects WHERE name = ? AND id <> ?").get(to, id)
        if (clash) throw new Error(`已经有叫「${to}」的项目了`)
        this.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(to, id)
      }
      return this.db
        .prepare(
          `SELECT p.name, p.description, p.created_at AS createdAt, count(i.id) AS images
           FROM projects p LEFT JOIN images i ON i.project_id = p.id WHERE p.id = ? GROUP BY p.id`,
        )
        .get(id) as { name: string; description: string; createdAt: string; images: number }
    })()
  }

  overview(tagLimit = 50) {
    const totals = this.db
      .prepare(
        `SELECT count(*) AS images,
           sum(stored = 'r2') AS r2, sum(stored = 'local') AS local, sum(stored = 'archive') AS archive,
           sum(project_id IS NULL) AS unfiled,
           sum(NOT EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = images.id)) AS untagged,
           min(created_at) AS first, max(created_at) AS last
         FROM images`,
      )
      .get() as Record<string, number | string | null>
    const projects = this.db
      .prepare(
        `SELECT p.name, p.description, count(i.id) AS images, max(i.created_at) AS latest
         FROM projects p LEFT JOIN images i ON i.project_id = p.id
         GROUP BY p.id ORDER BY latest IS NULL, latest DESC, p.name`,
      )
      .all()
    const tags = this.db
      .prepare(
        `SELECT t.name, count(*) AS images FROM tags t JOIN image_tags it ON it.tag_id = t.id
         GROUP BY t.id ORDER BY images DESC, t.name LIMIT ?`,
      )
      .all(tagLimit)
    for (const key of ["r2", "local", "archive", "unfiled", "untagged"]) totals[key] = Number(totals[key] ?? 0)
    return { totals, projects, tags }
  }
}
