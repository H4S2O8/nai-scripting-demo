/**
 * The studio: projects as structured work, on top of the image library.
 *
 * Two kinds of project share one model. A gallery is a set of shots, each a
 * concept that is drawn several times and keeps whichever candidates are good.
 * A novel is chapters of text, cut into pages; each page may have one shot,
 * and a novel shot ends with exactly one picked image — the page's picture.
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
    if (kind === "gallery") return { shots: shots.length, ...byStatus, openFeedback: open }
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
  setChapter(project: string, input: { chapter: number; title?: string; text: string; split?: SplitSettings }): ChapterResult {
    return this.db.transaction(() => {
      const row = this.novel(project)
      if (input.split) checkSplit(input.split)
      if (!input.text.trim()) throw new Error("章节原文不能为空")
      let chapter = this.db.prepare("SELECT * FROM chapters WHERE project_id = ? AND ord = ?").get(row.id, input.chapter) as any
      if (!chapter) {
        const last = (this.db.prepare("SELECT max(ord) AS n FROM chapters WHERE project_id = ?").get(row.id) as { n: number | null }).n ?? 0
        if (input.chapter !== last + 1) throw new Error(`现在有 ${last} 章，新章节只能是第 ${last + 1} 章`)
        const id = Number(
          this.db
            .prepare("INSERT INTO chapters (project_id, ord, title, split, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run(row.id, input.chapter, input.title?.trim() ?? "", JSON.stringify(input.split ?? {}), now()).lastInsertRowid,
        )
        chapter = this.db.prepare("SELECT * FROM chapters WHERE id = ?").get(id)
      } else {
        this.db
          .prepare("UPDATE chapters SET title = ?, split = ?, updated_at = ? WHERE id = ?")
          .run(
            input.title !== undefined ? input.title.trim() : chapter.title,
            input.split ? JSON.stringify(input.split) : chapter.split,
            now(),
            chapter.id,
          )
        chapter = this.db.prepare("SELECT * FROM chapters WHERE id = ?").get(chapter.id)
      }
      const pagesText = splitPages(input.text, this.splitFor(row.layout, chapter.split))
      const { reused, detached } = this.rewritePages(chapter.id, 0, pagesText)
      return this.chapterResult(chapter, pagesText, reused, detached)
    })()
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
      pages: this.chapterPages(chapter.id).length,
      reused,
      detached,
      lengths: { min: Math.min(...lengths), max: Math.max(...lengths) },
    }
  }

  listPages(project: string, filter: { chapter?: number; status?: ShotStatus } = {}): PageRow[] {
    const row = this.novel(project)
    const rows = this.db
      .prepare(
        `SELECT p.id, p.ord AS page, p.text, p.cont, c.ord AS chapter, s.id AS shot_id
         FROM pages p JOIN chapters c ON c.id = p.chapter_id LEFT JOIN shots s ON s.page_id = p.id
         WHERE c.project_id = ? ${filter.chapter ? "AND c.ord = ?" : ""}
         ORDER BY c.ord, p.ord`,
      )
      .all(...(filter.chapter ? [row.id, filter.chapter] : [row.id])) as any[]
    const shots = new Map(this.shotRows("s.project_id = ?", [row.id]).map((s) => [s.id, s]))
    return rows
      .map((r) => {
        const shot = r.shot_id ? shots.get(r.shot_id) ?? null : null
        return {
          id: r.id,
          chapter: r.chapter,
          page: r.page,
          text: r.text,
          cont: r.cont === 1,
          chars: countChars(r.text),
          shotId: shot?.id ?? null,
          status: shot ? shot.status : ("shot" as ShotStatus),
          counts: shot?.counts ?? null,
        }
      })
      .filter((p) => !filter.status || p.status === filter.status)
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
         FROM shots s JOIN projects p ON p.id = s.project_id WHERE ${where} ORDER BY s.id`,
      )
      .all(...args) as any[]
    return rows.map((r) => {
      const counts = { candidate: r.n_candidate, picked: r.n_picked, rejected: r.n_rejected, favorite: r.n_favorite }
      return {
        id: r.id,
        project: r.project,
        kind: r.kind,
        pageId: r.page_id,
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
   * gallery shot stands alone with a title. Passing shotId edits that shot —
   * and with pageId, moves a detached shot onto a page.
   */
  setShot(input: { project: string; shotId?: number; pageId?: number; spec: ShotSpec }): Shot {
    return this.db.transaction(() => {
      const row = this.projectRow(input.project)
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
      return this.getShots([shotId])[0]
    })()
  }

  /* ------------------------------------------------------------ verdicts */

  /**
   * Decide on candidates. `pick` is reserved for the project's picker: the
   * agent may only `favorite` unless the project lets it choose. Picking in a
   * novel shot returns the previously picked image to the candidates.
   */
  verdict(imageIds: number[], action: "pick" | "reject" | "reset" | "favorite" | "unfavorite", by: Actor) {
    return this.db.transaction(() => {
      const images = this.library.get(imageIds)
      for (const image of images) {
        if (image.shotId === null) throw new Error(`#${image.id} 不是任何镜头的候选图，没有选不选的问题`)
        const shot = this.getShots([image.shotId])[0]
        const project = this.projectRow(shot.project)
        if (action === "pick" && by === "agent" && project.picker !== "agent") {
          throw new Error(
            `「${project.name}」由人来选图：agent 只能用 favorite 标推荐。要让 agent 直接选，把项目的 picker 设为 agent。`,
          )
        }
        if (action === "pick") {
          if (project.kind === "novel") {
            this.db.prepare("UPDATE images SET verdict = 'candidate' WHERE shot_id = ? AND verdict = 'picked' AND id <> ?").run(shot.id, image.id)
          }
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
