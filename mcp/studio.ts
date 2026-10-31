/**
 * The studio: projects as structured work, on top of the image library.
 *
 * Two kinds of project share one model. A gallery is a mainline: an ordered
 * sequence of shots, each one panel, drawn as many times as it takes; shots
 * can also sit off the mainline (a character sheet, a discarded take) and are
 * then kept but not published. A novel is chapters of text, cut into pages;
 * each page may have one shot. Either way a shot ends with exactly one picked
 * image, its main image; every other drawing stays a candidate.
 *
 * Every drawing is a candidate first. Whether a candidate is picked is the
 * project's `picker`'s call: by default a person, in the review page, with the
 * agent limited to marking favourites; a project set to `agent` lets the agent
 * pick too. Everything here is shared by the MCP tools and the web front end,
 * so the rules live in one place.
 *
 * Prompts stay verbatim. Style and character sheets are reference for whoever
 * writes the shot's prompt; nothing is spliced into it on the way to NovelAI.
 */
import { Library, cleanName } from "./library"
import { DEFAULT_SPLIT, SplitSettings, checkSplit, countChars, joinPages, reconcile, splitPages } from "./split"

export type Kind = "gallery" | "novel"

/** A side story's label as stored: trimmed, one line, short enough for a page footer. */
export function cleanRoute(route: string): string {
  const clean = route.trim()
  if (/[\r\n]/.test(clean)) throw new Error("番外标签只能是一行")
  if ([...clean].length > 16) throw new Error(`番外标签最多 16 个字：「${clean}」`)
  return clean
}

/** What a page's footer says: "12" on the main story, "IF 1 · 3" on a side story. */
export function pageFooter(page: { route: string; routePage: number }): string {
  return page.route ? `${page.route} · ${page.routePage}` : String(page.routePage)
}
export type Picker = "human" | "agent"
export type Actor = "human" | "agent"

export type Style = {
  /** Free-form guidance: the look, the artist tags, what to avoid. */
  notes?: string
  /** Text the agent is expected to put in every prompt, e.g. style and quality tags. */
  prompt?: string
  negative?: string
}

export type Layout = {
  split?: SplitSettings
  /** The screen the composed pages are tuned for. */
  screen?: "phone-landscape" | "tablet-landscape"
  background?: string
  textColor?: string
}

export type Character = {
  key: string
  name?: string
  /** Appearance tags that do not change between scenes. */
  tags?: string
  /** Outfit name → tags. */
  outfits?: Record<string, string>
  notes?: string
}

export type ShotCaption = { prompt: string; negative?: string; x?: number; y?: number }

/** Where a shot goes on the mainline: before or after a shot on it, or at a 1-based position; none of these appends. */
export type Place = { before?: number; after?: number; at?: number }

export type ShotSpec = {
  title?: string
  prompt?: string
  negative?: string
  characters?: ShotCaption[]
  model?: string | null
  width?: number | null
  height?: number | null
  steps?: number | null
  guidance?: number | null
  sampler?: string | null
  note?: string
}

export type Shot = {
  id: number
  project: string
  kind: Kind
  pageId: number | null
  /** A gallery shot's place on the mainline, from 1; null when it is off it (and for novel shots). */
  seq: number | null
  title: string
  prompt: string
  negative: string
  characters: ShotCaption[]
  model: string | null
  width: number | null
  height: number | null
  steps: number | null
  guidance: number | null
  sampler: string | null
  note: string
  counts: { candidate: number; picked: number; rejected: number; favorite: number }
  status: ShotStatus
}

/**
 * Where a page or shot stands. `shot` needs a prompt written, `draw` has a
 * prompt and nothing to choose from yet, `pick` has candidates awaiting a
 * decision, `done` has its picture.
 */
export type ShotStatus = "shot" | "draw" | "pick" | "done"

export type PageRow = {
  id: number
  chapter: number
  page: number
  /** '' on the main story, else the side story's label, e.g. "IF 1". */
  route: string
  /** Where the page falls in its story: the main story and each side story count from 1. */
  routePage: number
  text: string
  cont: boolean
  chars: number
  shotId: number | null
  status: ShotStatus
  counts: Shot["counts"] | null
}

export type ChapterResult = {
  chapter: number
  title: string
  route: string
  pages: number
  reused: number
  /** Shots whose page's text changed: still in the project, now without a page. */
  detached: { shotId: number; text: string }[]
  lengths: { min: number; max: number }
}

export type Feedback = {
  id: number
  target: "project" | "page" | "shot" | "image"
  targetId: number | null
  author: Actor
  body: string
  createdAt: string
  resolvedAt: string | null
}

const now = () => new Date().toISOString()

function statusOf(hasPrompt: boolean, counts: Shot["counts"]): ShotStatus {
  if (!hasPrompt) return "shot"
  if (counts.picked > 0) return "done"
  if (counts.candidate > 0) return "pick"
  return "draw"
}

export const STATUS_LABEL: Record<ShotStatus, string> = {
  shot: "待写镜头",
  draw: "待抽卡",
  pick: "待选图",
  done: "已完成",
}

export class Studio {
  constructor(readonly library: Library) {}

  private get db() {
    return this.library.handle
  }

  /* ------------------------------------------------------------ projects */

  private projectRow(name: string): { id: number; name: string; kind: Kind; picker: Picker; layout: string; style: string; description: string } {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(cleanName(name, "项目名")) as any
    if (!row) throw new Error(`没有叫「${name}」的项目`)
    return row
  }

  createProject(input: { name: string; kind: Kind; description?: string; style?: Style; layout?: Layout; picker?: Picker }) {
    const name = cleanName(input.name, "项目名")
    if (this.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name)) {
      throw new Error(`已经有叫「${name}」的项目了`)
    }
    if (input.layout?.split) checkSplit(input.layout.split)
    this.db
      .prepare(
        "INSERT INTO projects (name, kind, description, style, layout, picker, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        name,
        input.kind,
        input.description?.trim() ?? "",
        JSON.stringify(input.style ?? {}),
        JSON.stringify(input.layout ?? {}),
        input.picker ?? "human",
        now(),
      )
    return this.getProject(name)
  }

  updateProject(
    name: string,
    patch: { description?: string; style?: Style; layout?: Layout; picker?: Picker; renameTo?: string },
  ) {
    return this.db.transaction(() => {
      const row = this.projectRow(name)
      if (patch.layout?.split) checkSplit(patch.layout.split)
      const set = (column: string, value: unknown) =>
        this.db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(value, row.id)
      if (patch.description !== undefined) set("description", patch.description.trim())
      // Style and layout merge field by field, so one setting can change alone.
      if (patch.style) set("style", JSON.stringify({ ...JSON.parse(row.style), ...patch.style }))
      if (patch.layout) set("layout", JSON.stringify({ ...JSON.parse(row.layout), ...patch.layout }))
      if (patch.picker) set("picker", patch.picker)
      let current = row.name
      if (patch.renameTo !== undefined) {
        const to = cleanName(patch.renameTo, "项目名")
        if (this.db.prepare("SELECT 1 FROM projects WHERE name = ? AND id <> ?").get(to, row.id)) {
          throw new Error(`已经有叫「${to}」的项目了`)
        }
        set("name", to)
        current = to
      }
      return this.getProject(current)
    })()
  }

  setCharacters(name: string, upserts: Character[] = [], remove: string[] = []) {
    return this.db.transaction(() => {
      const { id } = this.projectRow(name)
      for (const c of upserts) {
        const key = cleanName(c.key, "角色 key")
        const existing = this.db.prepare("SELECT * FROM characters WHERE project_id = ? AND key = ?").get(id, key) as any
        const merged = {
          name: c.name ?? existing?.name ?? "",
          tags: c.tags ?? existing?.tags ?? "",
          outfits: JSON.stringify(c.outfits ?? (existing ? JSON.parse(existing.outfits) : {})),
          notes: c.notes ?? existing?.notes ?? "",
        }
        if (existing) {
          this.db
            .prepare("UPDATE characters SET name = ?, tags = ?, outfits = ?, notes = ? WHERE id = ?")
            .run(merged.name, merged.tags, merged.outfits, merged.notes, existing.id)
        } else {
          this.db
            .prepare("INSERT INTO characters (project_id, key, name, tags, outfits, notes) VALUES (?, ?, ?, ?, ?, ?)")
            .run(id, key, merged.name, merged.tags, merged.outfits, merged.notes)
        }
      }
      for (const key of remove) {
        const gone = this.db.prepare("DELETE FROM characters WHERE project_id = ? AND key = ?").run(id, key)
        if (gone.changes === 0) throw new Error(`没有 key 为「${key}」的角色`)
      }
      return this.getProject(name)
    })()
  }

  private characters(projectId: number): Character[] {
    return (this.db.prepare("SELECT * FROM characters WHERE project_id = ? ORDER BY key").all(projectId) as any[]).map(
      (c) => ({ key: c.key, name: c.name, tags: c.tags, outfits: JSON.parse(c.outfits), notes: c.notes }),
    )
  }

  /** Shot status counts for a project, by status. */
  private progress(projectId: number, kind: Kind) {
    const shots = this.shotRows("s.project_id = ?", [projectId])
    const byStatus: Record<ShotStatus, number> = { shot: 0, draw: 0, pick: 0, done: 0 }
    for (const shot of shots) if (shot.pageId !== null || kind === "gallery") byStatus[shot.status]++
    const open = (this.db.prepare("SELECT count(*) AS n FROM feedback WHERE project_id = ? AND resolved_at IS NULL").get(projectId) as { n: number }).n
    if (kind === "gallery") return { shots: shots.length, mainline: shots.filter((s) => s.seq !== null).length, ...byStatus, openFeedback: open }
    const pages = (this.db
      .prepare("SELECT count(*) AS n FROM pages p JOIN chapters c ON c.id = p.chapter_id WHERE c.project_id = ?")
      .get(projectId) as { n: number }).n
    const withShot = shots.filter((s) => s.pageId !== null).length
    const chapters = (this.db.prepare("SELECT count(*) AS n FROM chapters WHERE project_id = ?").get(projectId) as { n: number }).n
    return {
      chapters,
      pages,
      ...byStatus,
      // A page with no shot row at all also still needs one written.
      shot: byStatus.shot + (pages - withShot),
      detachedShots: shots.filter((s) => s.pageId === null).length,
      openFeedback: open,
    }
  }

  getProject(name: string) {
    const row = this.projectRow(name)
    return {
      name: row.name,
      kind: row.kind,
      description: row.description,
      picker: row.picker,
      style: JSON.parse(row.style) as Style,
      layout: JSON.parse(row.layout) as Layout,
      characters: this.characters(row.id),
      progress: this.progress(row.id, row.kind),
    }
  }

  listProjects() {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY name").all() as any[]
    return rows.map((row) => ({
      name: row.name,
      kind: row.kind as Kind,
      description: row.description as string,
      picker: row.picker as Picker,
      images: (this.db.prepare("SELECT count(*) AS n FROM images WHERE project_id = ?").get(row.id) as { n: number }).n,
      progress: this.progress(row.id, row.kind),
    }))
  }

  /* --------------------------------------------------------------- novel */

  private novel(name: string) {
    const row = this.projectRow(name)
    if (row.kind !== "novel") throw new Error(`「${row.name}」是图集项目，没有章节和页`)
    return row
  }

  private splitFor(projectLayout: string, chapterSplit?: string): SplitSettings {
    const layout = JSON.parse(projectLayout) as Layout
    return { ...DEFAULT_SPLIT, ...(layout.split ?? {}), ...(chapterSplit ? JSON.parse(chapterSplit) : {}) }
  }

  private chapterPages(chapterId: number) {
    return this.db.prepare("SELECT id, ord, text, cont FROM pages WHERE chapter_id = ? ORDER BY ord").all(chapterId) as {
      id: number
      ord: number
      text: string
      cont: number
    }[]
  }

  /**
   * Write a chapter's pages from text: old pages whose text and continuation
   * are unchanged keep their id (and so their shot and images); the rest are
   * replaced, and shots on replaced pages are detached rather than deleted.
   */
  private rewritePages(chapterId: number, keep: number, pagesText: { text: string; cont: boolean }[]) {
    const old = this.chapterPages(chapterId).slice(keep).map((p) => ({ ...p, cont: p.cont === 1 }))
    const { reuse, lost } = reconcile(old, pagesText)
    const detached = lost.flatMap((page) => {
      const shot = this.db.prepare("SELECT id FROM shots WHERE page_id = ?").get(page.id) as { id: number } | undefined
      return shot ? [{ shotId: shot.id, text: page.text.slice(0, 40) }] : []
    })
    // Ords are rewritten from scratch; park the survivors out of the way first.
    this.db.prepare("UPDATE pages SET ord = -ord - 1000000 WHERE chapter_id = ? AND ord > ?").run(chapterId, keep)
    for (const page of lost) this.db.prepare("DELETE FROM pages WHERE id = ?").run(page.id)
    pagesText.forEach((page, i) => {
      const ord = keep + i + 1
      const hit = reuse[i]
      if (hit) this.db.prepare("UPDATE pages SET ord = ? WHERE id = ?").run(ord, hit.id)
      else {
        this.db
          .prepare("INSERT INTO pages (chapter_id, ord, text, cont) VALUES (?, ?, ?, ?)")
          .run(chapterId, ord, page.text, page.cont ? 1 : 0)
      }
    })
    return { reused: reuse.filter(Boolean).length, detached }
  }

  /** Create chapter n (the next one) or replace an existing chapter's text. */
  setChapter(
    project: string,
    input: { chapter: number; title?: string; route?: string; text: string; split?: SplitSettings },
  ): ChapterResult {
    return this.db.transaction(() => {
      const row = this.novel(project)
      if (input.split) checkSplit(input.split)
      if (!input.text.trim()) throw new Error("章节原文不能为空")
      const route = input.route === undefined ? undefined : cleanRoute(input.route)
      let chapter = this.db.prepare("SELECT * FROM chapters WHERE project_id = ? AND ord = ?").get(row.id, input.chapter) as any
      if (!chapter) {
        const prev = this.db.prepare("SELECT ord, route FROM chapters WHERE project_id = ? ORDER BY ord DESC LIMIT 1").get(row.id) as
          | { ord: number; route: string }
          | undefined
        const last = prev?.ord ?? 0
        if (input.chapter !== last + 1) throw new Error(`现在有 ${last} 章，新章节只能是第 ${last + 1} 章`)
        if (route === undefined && prev?.route) {
          throw new Error(`第 ${last} 章是番外「${prev.route}」，新章节要用 route 说明：同一条番外给 "${prev.route}"，另一条番外给它的名字`)
        }
        const id = Number(
          this.db
            .prepare("INSERT INTO chapters (project_id, ord, title, route, split, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(row.id, input.chapter, input.title?.trim() ?? "", route ?? "", JSON.stringify(input.split ?? {}), now())
            .lastInsertRowid,
        )
        chapter = this.db.prepare("SELECT * FROM chapters WHERE id = ?").get(id)
      } else {
        this.db
          .prepare("UPDATE chapters SET title = ?, route = ?, split = ?, updated_at = ? WHERE id = ?")
          .run(
            input.title !== undefined ? input.title.trim() : chapter.title,
            route ?? chapter.route,
            input.split ? JSON.stringify(input.split) : chapter.split,
            now(),
            chapter.id,
          )
        chapter = this.db.prepare("SELECT * FROM chapters WHERE id = ?").get(chapter.id)
      }
      this.checkRoutes(row.id)
      const pagesText = splitPages(input.text, this.splitFor(row.layout, chapter.split))
      const { reused, detached } = this.rewritePages(chapter.id, 0, pagesText)
      return this.chapterResult(chapter, pagesText, reused, detached)
    })()
  }

  /** Change a chapter's title or route without touching its text or pages. */
  setChapterInfo(project: string, input: { chapter: number; title?: string; route?: string }) {
    return this.db.transaction(() => {
      const row = this.novel(project)
      const chapter = this.db.prepare("SELECT * FROM chapters WHERE project_id = ? AND ord = ?").get(row.id, input.chapter) as any
      if (!chapter) throw new Error(`没有第 ${input.chapter} 章`)
      if (input.title === undefined && input.route === undefined) throw new Error("要给 title 或 route")
      this.db
        .prepare("UPDATE chapters SET title = ?, route = ?, updated_at = ? WHERE id = ?")
        .run(
          input.title !== undefined ? input.title.trim() : chapter.title,
          input.route !== undefined ? cleanRoute(input.route) : chapter.route,
          now(),
          chapter.id,
        )
      this.checkRoutes(row.id)
      const updated = this.db.prepare("SELECT ord, title, route FROM chapters WHERE id = ?").get(chapter.id) as any
      return { chapter: updated.ord as number, title: updated.title as string, route: updated.route as string }
    })()
  }

  /**
   * Side stories come after the main story, and each one's chapters sit
   * together, so the book reads: the story, then each extra in turn.
   */
  private checkRoutes(projectId: number) {
    const chapters = this.db.prepare("SELECT ord, route FROM chapters WHERE project_id = ? ORDER BY ord").all(projectId) as {
      ord: number
      route: string
    }[]
    const seen = new Set<string>()
    let prev = ""
    for (const c of chapters) {
      if (!c.route && prev) throw new Error(`第 ${c.ord} 章是正文，不能排在番外后面；番外章节要放在全部正文之后`)
      if (c.route && c.route !== prev && seen.has(c.route)) {
        throw new Error(`番外「${c.route}」的章节要连在一起，第 ${c.ord} 章和前面的「${c.route}」之间隔着别的章节`)
      }
      if (c.route) seen.add(c.route)
      prev = c.route
    }
  }

  /** Re-cut a chapter's existing text with new settings, optionally only from one page on. */
  resplitChapter(project: string, input: { chapter: number; split?: SplitSettings; fromPage?: number }): ChapterResult {
    return this.db.transaction(() => {
      const row = this.novel(project)
      const chapter = this.db.prepare("SELECT * FROM chapters WHERE project_id = ? AND ord = ?").get(row.id, input.chapter) as any
      if (!chapter) throw new Error(`没有第 ${input.chapter} 章`)
      if (input.split) {
        checkSplit(input.split)
        this.db.prepare("UPDATE chapters SET split = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(input.split), now(), chapter.id)
      }
      const pages = this.chapterPages(chapter.id).map((p) => ({ ...p, cont: p.cont === 1 }))
      const from = input.fromPage ?? 1
      if (from < 1 || from > pages.length) throw new Error(`fromPage 超出范围 1–${pages.length}`)
      const tail = pages.slice(from - 1)
      const settings = input.split ?? this.splitFor(row.layout, chapter.split)
      const pagesText = splitPages(joinPages(tail), settings)
      pagesText[0].cont = tail[0].cont
      const { reused, detached } = this.rewritePages(chapter.id, from - 1, pagesText)
      return this.chapterResult(chapter, pagesText, reused, detached)
    })()
  }

  private chapterResult(chapter: any, pagesText: { text: string }[], reused: number, detached: ChapterResult["detached"]): ChapterResult {
    const lengths = pagesText.map((p) => countChars(p.text))
    return {
      chapter: chapter.ord,
      title: chapter.title,
      route: chapter.route,
      pages: this.chapterPages(chapter.id).length,
      reused,
      detached,
      lengths: { min: Math.min(...lengths), max: Math.max(...lengths) },
    }
  }

  listPages(project: string, filter: { chapter?: number; status?: ShotStatus } = {}): PageRow[] {
    const row = this.novel(project)
    // All pages, even for one chapter: a page's number in its story counts the chapters before it.
    const rows = this.db
      .prepare(
        `SELECT p.id, p.ord AS page, p.text, p.cont, c.ord AS chapter, c.route, s.id AS shot_id
         FROM pages p JOIN chapters c ON c.id = p.chapter_id LEFT JOIN shots s ON s.page_id = p.id
         WHERE c.project_id = ? ORDER BY c.ord, p.ord`,
      )
      .all(row.id) as any[]
    const shots = new Map(this.shotRows("s.project_id = ?", [row.id]).map((s) => [s.id, s]))
    const counted = new Map<string, number>()
    return rows
      .map((r) => {
        const shot = r.shot_id ? shots.get(r.shot_id) ?? null : null
        const routePage = (counted.get(r.route) ?? 0) + 1
        counted.set(r.route, routePage)
        return {
          id: r.id,
          chapter: r.chapter,
          page: r.page,
          route: r.route as string,
          routePage,
          text: r.text,
          cont: r.cont === 1,
          chars: countChars(r.text),
          shotId: shot?.id ?? null,
          status: shot ? shot.status : ("shot" as ShotStatus),
          counts: shot?.counts ?? null,
        }
      })
      .filter((p) => (!filter.chapter || p.chapter === filter.chapter) && (!filter.status || p.status === filter.status))
  }

  /* --------------------------------------------------------------- shots */

  private shotRows(where: string, args: unknown[]): Shot[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, p.name AS project, p.kind AS kind,
           (SELECT count(*) FROM images i WHERE i.shot_id = s.id AND i.verdict = 'candidate') AS n_candidate,
           (SELECT count(*) FROM images i WHERE i.shot_id = s.id AND i.verdict = 'picked') AS n_picked,
           (SELECT count(*) FROM images i WHERE i.shot_id = s.id AND i.verdict = 'rejected') AS n_rejected,
           (SELECT count(*) FROM images i WHERE i.shot_id = s.id AND i.favorite = 1 AND i.verdict <> 'rejected') AS n_favorite
         FROM shots s JOIN projects p ON p.id = s.project_id WHERE ${where} ORDER BY s.seq IS NULL, s.seq, s.id`,
      )
      .all(...args) as any[]
    return rows.map((r) => {
      const counts = { candidate: r.n_candidate, picked: r.n_picked, rejected: r.n_rejected, favorite: r.n_favorite }
      return {
        id: r.id,
        project: r.project,
        kind: r.kind,
        pageId: r.page_id,
        seq: r.seq,
        title: r.title,
        prompt: r.prompt,
        negative: r.negative,
        characters: JSON.parse(r.characters),
        model: r.model,
        width: r.width,
        height: r.height,
        steps: r.steps,
        guidance: r.guidance,
        sampler: r.sampler,
        note: r.note,
        counts,
        status: statusOf(r.prompt.trim().length > 0, counts),
      }
    })
  }

  getShots(ids: number[]): Shot[] {
    if (ids.length === 0) return []
    const shots = this.shotRows(`s.id IN (${ids.map(() => "?").join(",")})`, ids)
    const missing = ids.filter((id) => !shots.some((s) => s.id === id))
    if (missing.length) throw new Error(`没有这些镜头 id：${missing.join(", ")}`)
    return ids.map((id) => shots.find((s) => s.id === id)!)
  }

  listShots(project: string, status?: ShotStatus): Shot[] {
    const row = this.projectRow(project)
    return this.shotRows("s.project_id = ?", [row.id]).filter((s) => !status || s.status === status)
  }

  /** The images drawn for a shot, newest first, with their verdicts. */
  candidates(shotId: number) {
    const rows = this.db
      .prepare(
        `SELECT i.*, p.name AS project FROM images i LEFT JOIN projects p ON p.id = i.project_id
         WHERE i.shot_id = ? ORDER BY i.created_at DESC, i.id DESC`,
      )
      .all(shotId)
    return this.library.hydrate(rows)
  }

  /**
   * Create or change a shot. A novel shot hangs on a page (one per page); a
   * gallery shot stands alone with a title, and a new one goes to the end of
   * the mainline unless `place` says where (or `false`: off it). Passing shotId
   * edits that shot — and with pageId, moves a detached shot onto a page.
   */
  setShot(input: { project: string; shotId?: number; pageId?: number; place?: Place | false; spec: ShotSpec }): Shot {
    return this.setShots(input.project, [input], input.place)[0]
  }

  /**
   * Several shots at once, all or nothing, in the order given. New gallery
   * shots are appended in that order; `place` puts all of them, new or edited,
   * on the mainline as one block in that order (or `false`: off it).
   */
  setShots(project: string, items: { shotId?: number; pageId?: number; spec: ShotSpec }[], place?: Place | false): Shot[] {
    return this.db.transaction(() => {
      if (items.length === 0) throw new Error("至少要给一个镜头")
      const row = this.projectRow(project)
      if (place !== undefined && row.kind !== "gallery") throw new Error("只有图集有主线，小说的镜头跟着页走")
      const ids = items.map((item) => this.writeShot(row, item))
      if (new Set(ids).size !== ids.length) throw new Error("同一个镜头在这次里出现了不止一次")
      if (place === false) this.unplace(ids)
      else if (place) this.place(ids, place)
      else if (row.kind === "gallery") {
        const created = ids.filter((_, i) => items[i].shotId === undefined)
        if (created.length) this.place(created, {})
      }
      return this.getShots(ids)
    })()
  }

  private writeShot(row: ReturnType<Studio["projectRow"]>, input: { shotId?: number; pageId?: number; spec: ShotSpec }): number {
    const spec = input.spec
    if (spec.characters) {
      for (const c of spec.characters) {
        if (!c.prompt?.trim()) throw new Error("角色 caption 的 prompt 不能为空")
        if ((c.x == null) !== (c.y == null)) throw new Error("角色坐标 x、y 要么都给，要么都不给")
      }
    }
    let shotId = input.shotId
    if (input.pageId !== undefined) {
      if (row.kind !== "novel") throw new Error("图集项目的镜头不挂在页上")
      const page = this.db
        .prepare("SELECT p.id FROM pages p JOIN chapters c ON c.id = p.chapter_id WHERE p.id = ? AND c.project_id = ?")
        .get(input.pageId, row.id)
      if (!page) throw new Error(`「${row.name}」里没有 id 为 ${input.pageId} 的页`)
      const onPage = this.db.prepare("SELECT id FROM shots WHERE page_id = ?").get(input.pageId) as { id: number } | undefined
      if (onPage && shotId !== undefined && onPage.id !== shotId) {
        throw new Error(`第 ${input.pageId} 页已经有镜头 #${onPage.id}；一页只能有一个镜头`)
      }
      if (onPage && shotId === undefined) shotId = onPage.id
    } else if (shotId === undefined && row.kind === "novel") {
      throw new Error("小说的镜头要指定 pageId（或用 shotId 改已有镜头）")
    }
    if (shotId === undefined) {
      if (row.kind === "gallery" && !spec.title?.trim()) throw new Error("图集镜头要有 title，说明这是什么构思")
      shotId = Number(
        this.db
          .prepare("INSERT INTO shots (project_id, page_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(row.id, input.pageId ?? null, now(), now()).lastInsertRowid,
      )
    } else {
      const own = this.db.prepare("SELECT project_id FROM shots WHERE id = ?").get(shotId) as { project_id: number } | undefined
      if (!own) throw new Error(`没有 id 为 ${shotId} 的镜头`)
      if (own.project_id !== row.id) throw new Error(`镜头 #${shotId} 不属于「${row.name}」`)
      if (input.pageId !== undefined) this.db.prepare("UPDATE shots SET page_id = ? WHERE id = ?").run(input.pageId, shotId)
    }
    const fields: [string, unknown][] = [
      ["title", spec.title?.trim()],
      ["prompt", spec.prompt],
      ["negative", spec.negative],
      ["characters", spec.characters ? JSON.stringify(spec.characters) : undefined],
      ["model", spec.model],
      ["width", spec.width],
      ["height", spec.height],
      ["steps", spec.steps],
      ["guidance", spec.guidance],
      ["sampler", spec.sampler],
      ["note", spec.note],
    ]
    for (const [column, value] of fields) {
      if (value !== undefined) this.db.prepare(`UPDATE shots SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, now(), shotId)
    }
    return shotId
  }

  /* ------------------------------------------------------------ mainline */

  /** A gallery's mainline, as shot ids in order. */
  private line(projectId: number): number[] {
    return (this.db.prepare("SELECT id FROM shots WHERE project_id = ? AND seq IS NOT NULL ORDER BY seq, id").all(projectId) as { id: number }[]).map((r) => r.id)
  }

  /** Number the mainline 1..n in this order; shots of the project not in it go off it. */
  private renumber(projectId: number, order: number[]) {
    this.db.prepare("UPDATE shots SET seq = NULL WHERE project_id = ?").run(projectId)
    const set = this.db.prepare("UPDATE shots SET seq = ? WHERE id = ?")
    order.forEach((id, i) => set.run(i + 1, id))
  }

  /** These gallery shots and their project; all must be in the same one. */
  private galleryShots(shotIds: number[]) {
    if (shotIds.length === 0) throw new Error("至少要给一个镜头")
    if (new Set(shotIds).size !== shotIds.length) throw new Error("镜头 id 有重复")
    const shots = this.getShots(shotIds)
    const row = this.projectRow(shots[0].project)
    if (row.kind !== "gallery") throw new Error(`镜头 #${shots[0].id} 属于小说「${row.name}」；只有图集有主线`)
    const stray = shots.find((s) => s.project !== row.name)
    if (stray) throw new Error(`镜头 #${stray.id} 属于「${stray.project}」，不是「${row.name}」`)
    return { shots, row }
  }

  /**
   * Put gallery shots on the mainline as one block, in the order given: before
   * or after another shot on it, at a position (1 is the first; past the end
   * appends), or with none of these at the end. Shots already on the mainline
   * move.
   */
  place(shotIds: number | number[], where: Place = {}): Shot[] {
    const ids = [shotIds].flat()
    return this.db.transaction(() => {
      const { row } = this.galleryShots(ids)
      const given = [where.before, where.after, where.at].filter((x) => x !== undefined).length
      if (given > 1) throw new Error("before、after、at 只能给一个")
      const order = this.line(row.id).filter((id) => !ids.includes(id))
      let index = order.length
      const anchor = where.before ?? where.after
      if (anchor !== undefined) {
        if (ids.includes(anchor)) throw new Error("参照的镜头不能是正在挪的镜头")
        const at = order.indexOf(anchor)
        if (at < 0) throw new Error(`镜头 #${anchor} 不在「${row.name}」的主线上`)
        index = where.before !== undefined ? at : at + 1
      } else if (where.at !== undefined) {
        if (!Number.isInteger(where.at) || where.at < 1) throw new Error("at 是从 1 开始的位置")
        index = Math.min(where.at - 1, order.length)
      }
      order.splice(index, 0, ...ids)
      this.renumber(row.id, order)
      return this.getShots(ids)
    })()
  }

  /** Take gallery shots off the mainline; they keep their images and can go back on later. */
  unplace(shotIds: number | number[]): Shot[] {
    const ids = [shotIds].flat()
    return this.db.transaction(() => {
      const { row } = this.galleryShots(ids)
      this.renumber(row.id, this.line(row.id).filter((id) => !ids.includes(id)))
      return this.getShots(ids)
    })()
  }

  /** Rewrite the whole mainline: exactly these shots, in this order; the project's other shots go off it. */
  order(project: string, shotIds: number[]): Shot[] {
    return this.db.transaction(() => {
      const row = this.projectRow(project)
      if (row.kind !== "gallery") throw new Error("只有图集有主线，小说的镜头跟着页走")
      if (shotIds.length) {
        const { row: own } = this.galleryShots(shotIds)
        if (own.id !== row.id) throw new Error(`镜头 #${shotIds[0]} 不属于「${row.name}」`)
      }
      this.renumber(row.id, shotIds)
      return this.listShots(row.name)
    })()
  }

  /**
   * Fold other shots into this one — a panel that was drawn again under a new
   * shot, say in another style — so their images become its candidates and
   * the duplicates go away. Picks from the others become starred candidates;
   * if this shot had no main image yet, the newest of them becomes it. Their
   * feedback moves along. A shot on a novel page cannot be folded away.
   */
  merge(intoId: number, fromIds: number[]): Shot {
    return this.db.transaction(() => {
      const into = this.getShots([intoId])[0]
      const from = this.getShots([...new Set(fromIds)].filter((id) => id !== intoId))
      if (from.length === 0) throw new Error("要给至少一个别的镜头来合并")
      for (const shot of from) {
        if (shot.project !== into.project) throw new Error(`镜头 #${shot.id} 属于「${shot.project}」，不是「${into.project}」`)
        if (shot.pageId !== null) throw new Error(`镜头 #${shot.id} 挂在页 #${shot.pageId} 上，不能合并掉`)
      }
      const ids = from.map((s) => s.id)
      const marks = ids.map(() => "?").join(",")
      const newestPick = this.db
        .prepare(`SELECT id FROM images WHERE verdict = 'picked' AND shot_id IN (${marks}) ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(...ids) as { id: number } | undefined
      this.db.prepare(`UPDATE images SET verdict = 'candidate', favorite = 1 WHERE verdict = 'picked' AND shot_id IN (${marks})`).run(...ids)
      this.db.prepare(`UPDATE images SET shot_id = ? WHERE shot_id IN (${marks})`).run(intoId, ...ids)
      if (into.counts.picked === 0 && newestPick) {
        this.db.prepare("UPDATE images SET verdict = 'picked', favorite = 0 WHERE id = ?").run(newestPick.id)
      }
      this.db.prepare(`UPDATE feedback SET target_id = ? WHERE target = 'shot' AND target_id IN (${marks})`).run(intoId, ...ids)
      const projectId = this.projectRow(into.project).id
      const line = this.line(projectId).filter((id) => !ids.includes(id))
      this.db.prepare(`DELETE FROM shots WHERE id IN (${marks})`).run(...ids)
      if (into.kind === "gallery") this.renumber(projectId, line)
      return this.getShots([intoId])[0]
    })()
  }

  /**
   * Make images that were drawn outside any shot — with novelai_generate_image,
   * or by an older shot's prompt — candidates of this shot, so they can be
   * picked like anything novelai_draw produced. All or nothing.
   *
   * An image already in another shot is refused rather than moved: taking it
   * would silently change what that shot offers, or unpick its page. An
   * archived image is refused too — without its original on R2 it can be
   * neither previewed nor laid out.
   */
  adopt(shotId: number, imageIds: number[]) {
    return this.db.transaction(() => {
      const shot = this.getShots([shotId])[0]
      const project = this.projectRow(shot.project)
      const images = this.library.get(imageIds)
      for (const image of images) {
        if (image.shotId === shot.id) continue
        if (image.shotId !== null) {
          throw new Error(`#${image.id} 已经是镜头 #${image.shotId} 的候选图，不能直接挪过来`)
        }
        if (image.stored === "archive" || image.purgedAt) {
          throw new Error(`#${image.id} 已归档，线上没有原图，不能用作候选`)
        }
      }
      const take = this.db.prepare(
        "UPDATE images SET shot_id = ?, verdict = 'candidate', project_id = ? WHERE id = ? AND shot_id IS NULL",
      )
      for (const image of images) take.run(shot.id, project.id, image.id)
      return this.library.get(imageIds)
    })()
  }

  /* ------------------------------------------------------------ verdicts */

  /**
   * Decide on candidates. `pick` is reserved for the project's picker: the
   * agent may only `favorite` unless the project lets it choose. A shot has
   * one main image, so picking returns the previous one to the candidates.
   */
  verdict(imageIds: number[], action: "pick" | "reject" | "reset" | "favorite" | "unfavorite", by: Actor) {
    return this.db.transaction(() => {
      const images = this.library.get(imageIds)
      for (const image of images) {
        if (image.shotId === null) {
          throw new Error(`#${image.id} 不是任何镜头的候选图。要用它，先用 novelai_shot 的 adopt 把它收进镜头，再选`)
        }
        const shot = this.getShots([image.shotId])[0]
        const project = this.projectRow(shot.project)
        if (action === "pick" && by === "agent" && project.picker !== "agent") {
          throw new Error(
            `「${project.name}」由人来选图：agent 只能用 favorite 标推荐。要让 agent 直接选，把项目的 picker 设为 agent。`,
          )
        }
        if (action === "pick") {
          this.db.prepare("UPDATE images SET verdict = 'candidate' WHERE shot_id = ? AND verdict = 'picked' AND id <> ?").run(shot.id, image.id)
          this.db.prepare("UPDATE images SET verdict = 'picked' WHERE id = ?").run(image.id)
        } else if (action === "reject") {
          this.db.prepare("UPDATE images SET verdict = 'rejected', favorite = 0 WHERE id = ?").run(image.id)
        } else if (action === "reset") {
          this.db.prepare("UPDATE images SET verdict = 'candidate' WHERE id = ?").run(image.id)
        } else {
          this.db.prepare("UPDATE images SET favorite = ? WHERE id = ?").run(action === "favorite" ? 1 : 0, image.id)
        }
      }
      return this.library.get(imageIds)
    })()
  }

  /* ----------------------------------------------------- web read views */

  /** The picked image of each shot. */
  private picks(shotIds: number[]): Map<number, number[]> {
    const out = new Map<number, number[]>()
    if (shotIds.length === 0) return out
    const rows = this.db
      .prepare(
        `SELECT shot_id, id FROM images WHERE verdict = 'picked' AND shot_id IN (${shotIds.map(() => "?").join(",")})
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...shotIds) as { shot_id: number; id: number }[]
    for (const row of rows) out.set(row.shot_id, [...(out.get(row.shot_id) ?? []), row.id])
    return out
  }

  /**
   * What to show for a shot before anything is picked: the agent's favourite,
   * else the newest candidate. Rejected images never stand in.
   */
  private covers(shotIds: number[]): Map<number, number> {
    const out = new Map<number, number>()
    if (shotIds.length === 0) return out
    const rows = this.db
      .prepare(
        `SELECT shot_id, id FROM images WHERE verdict = 'candidate' AND shot_id IN (${shotIds.map(() => "?").join(",")})
         ORDER BY favorite DESC, created_at DESC, id DESC`,
      )
      .all(...shotIds) as { shot_id: number; id: number }[]
    for (const row of rows) if (!out.has(row.shot_id)) out.set(row.shot_id, row.id)
    return out
  }

  /** Chapters with their pages, each page carrying its picked image id (or a stand-in) for a thumbnail. */
  novelOverview(project: string) {
    const row = this.novel(project)
    const chapters = this.db.prepare("SELECT ord, title, route FROM chapters WHERE project_id = ? ORDER BY ord").all(row.id) as {
      ord: number
      title: string
      route: string
    }[]
    const pages = this.listPages(project)
    const shotIds = pages.flatMap((p) => (p.shotId ? [p.shotId] : []))
    const picks = this.picks(shotIds)
    const covers = this.covers(shotIds)
    return chapters.map((c) => ({
      chapter: c.ord,
      title: c.title,
      route: c.route,
      pages: pages
        .filter((p) => p.chapter === c.ord)
        .map((p) => ({
          ...p,
          picked: p.shotId ? picks.get(p.shotId)?.[0] ?? null : null,
          cover: p.shotId ? covers.get(p.shotId) ?? null : null,
        })),
    }))
  }

  /** A gallery's shots: the mainline in order, then the ones off it, each with its main image. */
  galleryOverview(project: string) {
    const shots = this.listShots(project)
    const picks = this.picks(shots.map((s) => s.id))
    const covers = this.covers(shots.map((s) => s.id))
    return shots.map((s) => ({ ...s, picked: picks.get(s.id) ?? [], cover: covers.get(s.id) ?? null }))
  }

  /**
   * A project's images that belong to no shot — generated with only a project
   * name, or filed into it afterwards. Newest first.
   */
  looseImages(project: string, limit = 120) {
    const row = this.projectRow(project)
    const total = (this.db.prepare("SELECT count(*) AS n FROM images WHERE project_id = ? AND shot_id IS NULL").get(row.id) as { n: number }).n
    const rows = this.db
      .prepare(
        `SELECT i.*, p.name AS project FROM images i LEFT JOIN projects p ON p.id = i.project_id
         WHERE i.project_id = ? AND i.shot_id IS NULL ORDER BY i.created_at DESC, i.id DESC LIMIT ?`,
      )
      .all(row.id, limit)
    return { total, images: this.library.hydrate(rows) }
  }

  /** Open and resolved feedback on any of these targets, oldest first. */
  feedbackOn(project: string, targets: { target: Feedback["target"]; id: number | null }[]): Feedback[] {
    const all = this.feedback(project, true)
    return all.filter((f) => targets.some((t) => t.target === f.target && (t.target === "project" || t.id === f.targetId)))
  }

  shotDetail(shotId: number) {
    const shot = this.getShots([shotId])[0]
    const candidates = this.candidates(shotId)
    return {
      shot,
      candidates,
      feedback: this.feedbackOn(shot.project, [
        { target: "shot", id: shot.id },
        ...candidates.map((c) => ({ target: "image" as const, id: c.id })),
      ]),
    }
  }

  pageDetail(pageId: number) {
    const page = this.db
      .prepare(
        `SELECT p.id, p.ord, p.text, p.cont, c.ord AS chapter, c.title AS chapter_title, pr.name AS project, pr.layout AS layout
         FROM pages p JOIN chapters c ON c.id = p.chapter_id JOIN projects pr ON pr.id = c.project_id WHERE p.id = ?`,
      )
      .get(pageId) as any
    if (!page) throw new Error(`没有 id 为 ${pageId} 的页`)
    const order = this.listPages(page.project)
    const index = order.findIndex((p) => p.id === pageId)
    const shotRow = this.db.prepare("SELECT id FROM shots WHERE page_id = ?").get(pageId) as { id: number } | undefined
    const shot = shotRow ? this.shotDetail(shotRow.id) : null
    return {
      project: page.project as string,
      layout: JSON.parse(page.layout) as Layout,
      page: {
        id: page.id as number,
        chapter: page.chapter as number,
        chapterTitle: page.chapter_title as string,
        page: page.ord as number,
        number: index + 1,
        total: order.length,
        route: order[index].route,
        routePage: order[index].routePage,
        /** The title of the side story: its first chapter's title. */
        routeTitle: order[index].route ? this.routeTitle(page.project, order[index].route) : "",
        text: page.text as string,
        cont: page.cont === 1,
        chars: countChars(page.text),
        status: order[index].status,
      },
      prev: index > 0 ? order[index - 1].id : null,
      next: index < order.length - 1 ? order[index + 1].id : null,
      shot: shot?.shot ?? null,
      candidates: shot?.candidates ?? [],
      feedback: [
        ...this.feedbackOn(page.project, [{ target: "page", id: pageId }]),
        ...(shot?.feedback ?? []),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }
  }

  /** A side story's title, from its first chapter. */
  routeTitle(project: string, route: string): string {
    const row = this.novel(project)
    const first = this.db
      .prepare("SELECT title FROM chapters WHERE project_id = ? AND route = ? ORDER BY ord LIMIT 1")
      .get(row.id, route) as { title: string } | undefined
    if (!first) throw new Error(`「${row.name}」没有番外「${route}」`)
    return first.title
  }

  /* ------------------------------------------------------------- review */

  comment(project: string, input: { target: Feedback["target"]; targetId?: number; body: string; author: Actor }) {
    const row = this.projectRow(project)
    if (!input.body.trim()) throw new Error("意见内容不能为空")
    if (input.target !== "project" && input.targetId == null) throw new Error(`评论 ${input.target} 要给 targetId`)
    const id = Number(
      this.db
        .prepare("INSERT INTO feedback (project_id, target, target_id, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.id, input.target, input.targetId ?? null, input.author, input.body.trim(), now()).lastInsertRowid,
    )
    return this.feedback(project, true).find((f) => f.id === id)!
  }

  resolve(project: string, ids: number[]) {
    const row = this.projectRow(project)
    const mark = this.db.prepare("UPDATE feedback SET resolved_at = ? WHERE id = ? AND project_id = ? AND resolved_at IS NULL")
    const missing = ids.filter((id) => mark.run(now(), id, row.id).changes === 0)
    if (missing.length) throw new Error(`这些意见不存在、不属于该项目或已经解决：${missing.join(", ")}`)
  }

  feedback(project: string, includeResolved = false): Feedback[] {
    const row = this.projectRow(project)
    return (this.db
      .prepare(
        `SELECT * FROM feedback WHERE project_id = ? ${includeResolved ? "" : "AND resolved_at IS NULL"} ORDER BY created_at`,
      )
      .all(row.id) as any[]).map((f) => ({
      id: f.id,
      target: f.target,
      targetId: f.target_id,
      author: f.author,
      body: f.body,
      createdAt: f.created_at,
      resolvedAt: f.resolved_at,
    }))
  }

  /** What is waiting, and on whom. */
  review(project: string) {
    const info = this.getProject(project)
    const shots = this.listShots(project)
    const open = this.feedback(project)
    const base = {
      project: info.name,
      kind: info.kind,
      picker: info.picker,
      feedback: open.filter((f) => f.author === "human"),
      toPick: shots.filter((s) => s.status === "pick" && (info.kind === "gallery" || s.pageId !== null)),
      toDraw: shots.filter((s) => s.status === "draw" && (info.kind === "gallery" || s.pageId !== null)),
    }
    if (info.kind === "gallery") return { ...base, toWrite: shots.filter((s) => s.status === "shot"), detached: [] as Shot[] }
    const pages = this.listPages(project)
    return {
      ...base,
      toWrite: pages.filter((p) => p.status === "shot"),
      detached: shots.filter((s) => s.pageId === null),
    }
  }
}
