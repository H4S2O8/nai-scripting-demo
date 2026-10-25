/**
 * Publishing a project to E-Hentai, through the publisher MCP on this host.
 *
 * A gallery uploads the images picked in its shots, in shot order, and
 * whichever loose images the person adds. A novel uploads its composed pages —
 * the picture with the page's text, laid out as the review page shows it — in
 * page order; each composed page is uploaded to R2 once and remembered, so a
 * second attempt does not redo the work.
 *
 * The flow mirrors the publisher's own and stops where it does: prepare
 * (download, check, draw the cover; nothing reaches the site), create a draft
 * (the upload), then the person reviews and publishes on the site and hands
 * back the public link for the required tags. Nothing here publishes.
 *
 * Preparing can take minutes for a long novel, longer than a request through
 * the tunnel may stay open, so it runs in the background and the publication
 * row carries its progress.
 */
import { createHash, randomBytes } from "node:crypto"
import { loadImage } from "@napi-rs/canvas"

import { EhClient } from "./ehclient"
import { ImageRow, Library } from "./library"
import { composePage } from "./page"
import { putObject, r2Config } from "./r2"
import { Studio } from "./studio"
import { Thumbs } from "./thumbs"

export type Item = { imageId: number; pageId?: number }

export type PublishSettings = {
  title: string
  titleJpn?: string
  description?: string
  language?: string
  languageType?: string
  coverStyle: "ai" | "ai_guro"
  guroGender?: "female" | "male" | "both" | null
  coverSpec?: Record<string, unknown> | null
  /** Library image whose original is the cover background; default the first item's. */
  backgroundImageId?: number | null
  acceptSiteTerms?: boolean
}

export type Candidate = {
  imageId: number
  pageId?: number
  label: string
  /** On by default: picked in a shot (gallery) or a finished page (novel). */
  selected: boolean
  /** Why it cannot be uploaded, if it cannot. */
  blocked?: string
}

const now = () => new Date().toISOString()
const MASCOT_MIN_SIDE = 100

/** Puts a file somewhere the publisher can download it from, and says where. */
export type Store = (name: string, body: Buffer, contentType: string) => Promise<string>

/** Files on the configured R2 bucket, next to the images: <prefix>-assets/… and <prefix>-pages/…. */
export const r2Store: Store = async (name, body, contentType) => {
  const config = r2Config()
  if (!config) throw new Error("这台服务器没有配置 R2，无法上传")
  const key = `${config.prefix.replace(/\/?$/, "")}-${name}`
  await putObject(config, config.bucket, key, body, contentType, "public, max-age=31536000, immutable")
  return `${config.publicUrl}/${key}`
}

export class Publisher {
  constructor(
    private library: () => Library,
    private thumbs: Thumbs,
    private fontPath: () => string,
    private eh: () => EhClient | null,
    private store: Store = r2Store,
  ) {}

  private get db() {
    return this.library().handle
  }

  private client(): EhClient {
    const eh = this.eh()
    if (!eh) throw new Error("这台服务器没有配置 E-Hentai 发布服务（EH_MCP_URL、EH_MCP_TOKEN）")
    return eh
  }

  private projectId(name: string): { id: number; name: string; kind: string; layout: string; publish: string } {
    const row = this.db.prepare("SELECT id, name, kind, layout, publish FROM projects WHERE name = ?").get(name) as any
    if (!row) throw new Error(`没有叫「${name}」的项目`)
    return row
  }

  /** An image's link the publisher can download: the original on R2. */
  private uploadable(image: ImageRow): string | null {
    if (image.stored === "archive" || image.purgedAt) return null
    if (image.stored !== "r2" || !image.url) return null
    return image.url
  }

  /* -------------------------------------------------------- candidates */

  candidates(project: string): Candidate[] {
    const row = this.projectId(project)
    const studio = new Studio(this.library())
    if (row.kind === "novel") {
      return studio.novelOverview(row.name).flatMap((chapter) =>
        chapter.pages.map((page): Candidate => {
          const label = `第${chapter.chapter}章 第${page.page}页`
          if (!page.picked) return { imageId: 0, pageId: page.id, label, selected: false, blocked: "这页还没选图" }
          const image = this.library().get([page.picked])[0]
          const blocked = this.uploadable(image) ? undefined : "这页的图只在 Mac 备份里，线上没有原图"
          return { imageId: page.picked, pageId: page.id, label, selected: !blocked, blocked }
        }),
      )
    }
    const shots = studio.galleryOverview(row.name).slice().reverse() // oldest shot first
    const picked = shots.flatMap((shot) =>
      this.library()
        .get(shot.picked.slice().reverse())
        .map((image): Candidate => {
          const blocked = this.uploadable(image) ? undefined : "只在 Mac 备份里，线上没有原图"
          return { imageId: image.id, label: shot.title || `镜头 #${shot.id}`, selected: !blocked, blocked }
        }),
    )
    const loose = studio.looseImages(row.name, 500).images.reverse().map((image): Candidate => {
      const blocked = this.uploadable(image) ? undefined : "只在 Mac 备份里，线上没有原图"
      return { imageId: image.id, label: "其他图片", selected: false, blocked }
    })
    return [...picked, ...loose]
  }

  /* ----------------------------------------------------------- mascots */

  mascots() {
    return this.db
      .prepare("SELECT id, name, url, width, height, created_at AS createdAt FROM mascots WHERE removed_at IS NULL ORDER BY id")
      .all()
  }

  private addMascot(name: string, url: string, width: number, height: number) {
    const clean = name.trim().slice(0, 40) || "吉祥物"
    const id = Number(
      this.db
        .prepare("INSERT INTO mascots (name, url, width, height, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(clean, url, width, height, now()).lastInsertRowid,
    )
    return this.db.prepare("SELECT id, name, url, width, height, created_at AS createdAt FROM mascots WHERE id = ?").get(id)
  }

  private static checkSize(width: number, height: number) {
    if (Math.min(width, height) < MASCOT_MIN_SIDE) {
      throw new Error(`吉祥物图片太小（${width}×${height}），每边至少 ${MASCOT_MIN_SIDE} 像素`)
    }
  }

  /** A PNG, WebP or JPEG uploaded from the page, stored on R2 for the publisher to fetch. */
  async uploadMascot(name: string, data: Buffer) {
    const kind =
      data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? { ext: "png", type: "image/png" }
      : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP" ? { ext: "webp", type: "image/webp" }
      : data[0] === 0xff && data[1] === 0xd8 ? { ext: "jpg", type: "image/jpeg" }
      : null
    if (!kind) throw new Error("吉祥物只接受 PNG、WebP 或 JPEG")
    if (data.length > 8 * 1024 * 1024) throw new Error("吉祥物图片超过 8MB")
    let image
    try {
      image = await loadImage(data)
    } catch {
      throw new Error("吉祥物图片无法解码")
    }
    Publisher.checkSize(image.width, image.height)
    const url = await this.store(`assets/mascots/${randomBytes(12).toString("hex")}.${kind.ext}`, data, kind.type)
    return this.addMascot(name, url, image.width, image.height)
  }

  /** A library image — say a transparent cut-out drawn for the purpose — as a mascot. */
  mascotFromImage(name: string, imageId: number) {
    const image = this.library().get([imageId])[0]
    const url = this.uploadable(image)
    if (!url) throw new Error(`#${imageId} 线上没有原图，不能用作吉祥物`)
    Publisher.checkSize(image.width ?? 0, image.height ?? 0)
    return this.addMascot(name || `图 #${imageId}`, url, image.width ?? 0, image.height ?? 0)
  }

  removeMascot(id: number) {
    const gone = this.db.prepare("UPDATE mascots SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(now(), id)
    if (gone.changes === 0) throw new Error(`没有 id 为 ${id} 的吉祥物`)
  }

  /* ------------------------------------------------------------- cover */

  private backgroundUrl(imageId: number): string {
    const image = this.library().get([imageId])[0]
    const url = this.uploadable(image)
    if (!url) throw new Error(`#${imageId} 线上没有原图，不能作封面背景`)
    return url
  }

  async previewCover(input: { backgroundImageId: number; coverStyle: string; coverSpec?: unknown; maxWidth?: number }) {
    const result = await this.client().call("preview_cover", {
      background_url: this.backgroundUrl(input.backgroundImageId),
      cover_style: input.coverStyle,
      cover_spec: input.coverSpec ?? null,
      max_width: Math.min(1600, Math.max(256, Math.round(input.maxWidth ?? 900))),
    })
    if (!result.image) throw new Error("E-Hentai 服务没有返回封面预览图")
    return { image: result.image, info: result.json }
  }

  /* ----------------------------------------------------------- publish */

  settings(project: string): Partial<PublishSettings> {
    return JSON.parse(this.projectId(project).publish || "{}")
  }

  publications(project: string) {
    const row = this.projectId(project)
    return (this.db.prepare("SELECT * FROM publications WHERE project_id = ? ORDER BY id DESC").all(row.id) as any[]).map(
      (p) => this.view(p),
    )
  }

  private view(p: any) {
    return {
      id: p.id as number,
      ehJobId: p.eh_job_id as string | null,
      state: p.state as string,
      progress: p.progress as string,
      error: p.error as string | null,
      items: JSON.parse(p.items) as Item[],
      settings: JSON.parse(p.settings) as PublishSettings,
      createdAt: p.created_at as string,
      updatedAt: p.updated_at as string,
    }
  }

  private row(id: number) {
    const p = this.db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as any
    if (!p) throw new Error(`没有 id 为 ${id} 的发布记录`)
    return p
  }

  private mark(id: number, fields: { state?: string; progress?: string; error?: string | null; ehJobId?: string }) {
    const p = this.row(id)
    this.db
      .prepare("UPDATE publications SET state = ?, progress = ?, error = ?, eh_job_id = ?, updated_at = ? WHERE id = ?")
      .run(
        fields.state ?? p.state,
        fields.progress ?? p.progress,
        fields.error === undefined ? p.error : fields.error,
        fields.ehJobId ?? p.eh_job_id,
        now(),
        id,
      )
  }

  /**
   * Check everything that can be checked without the network, record the
   * publication and its settings as the project's next defaults, then do the
   * slow part in the background.
   */
  start(project: string, items: Item[], settings: PublishSettings): number {
    const row = this.projectId(project)
    this.client()
    if (!settings.title?.trim()) throw new Error("要有标题")
    if (!["ai", "ai_guro"].includes(settings.coverStyle)) throw new Error("封面样式只能是 ai 或 ai_guro")
    if (settings.coverStyle === "ai_guro" && !settings.guroGender) throw new Error("GURO 投稿要指定受伤者性别")
    if (items.length === 0) throw new Error("没有选任何图")
    if (items.length > 1999) throw new Error("一个画廊最多 1999 张")
    const allowed = new Map(this.candidates(row.name).filter((c) => !c.blocked).map((c) => [`${c.pageId ?? 0}:${c.imageId}`, c]))
    for (const item of items) {
      if (!allowed.has(`${item.pageId ?? 0}:${item.imageId}`)) {
        throw new Error(row.kind === "novel" ? `页 #${item.pageId} 不能上传（没选图或线上没有原图）` : `#${item.imageId} 不在这个项目可上传的图里`)
      }
    }
    if (settings.backgroundImageId) this.backgroundUrl(settings.backgroundImageId)
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO publications (project_id, state, progress, items, settings, created_at, updated_at)
           VALUES (?, 'composing', '', ?, ?, ?, ?)`,
        )
        .run(row.id, JSON.stringify(items), JSON.stringify(settings), now(), now()).lastInsertRowid,
    )
    this.db.prepare("UPDATE projects SET publish = ? WHERE id = ?").run(JSON.stringify(settings), row.id)
    void this.prepare(id, row.name, row.kind, items, settings).catch((error) => {
      this.mark(id, { state: "failed", error: error instanceof Error ? error.message : String(error) })
    })
    return id
  }

  private async prepare(id: number, project: string, kind: string, items: Item[], settings: PublishSettings) {
    const urls: string[] = []
    if (kind === "novel") {
      for (const [index, item] of items.entries()) {
        this.mark(id, { progress: `合成第 ${index + 1}/${items.length} 页` })
        urls.push(await this.composedPage(project, item.pageId!, item.imageId))
      }
    } else {
      for (const item of items) urls.push(this.backgroundUrl(item.imageId))
    }
    this.mark(id, { state: "preparing", progress: "E-Hentai 服务下载图片、生成封面" })
    const background = settings.backgroundImageId ? this.backgroundUrl(settings.backgroundImageId) : null
    const result = await this.client().call("prepare_gallery", {
      image_urls: urls,
      title: settings.title,
      title_jpn: settings.titleJpn ?? "",
      description: settings.description ?? "",
      language: settings.language ?? (kind === "novel" ? "Chinese" : "No Text"),
      language_type: settings.languageType ?? "Official / Textless",
      accept_site_terms: settings.acceptSiteTerms === true,
      cover_style: settings.coverStyle,
      cover_background_url: background,
      guro_gender: settings.coverStyle === "ai_guro" ? settings.guroGender : null,
      cover_spec: settings.coverSpec ?? null,
    })
    this.mark(id, { ehJobId: String(result.json?.id ?? ""), progress: "" })
  }

  /** A novel page composed with its picked picture, on R2 — made once per page, picture and text. */
  private async composedPage(project: string, pageId: number, imageId: number): Promise<string> {
    const studio = new Studio(this.library())
    const detail = studio.pageDetail(pageId)
    if (detail.project !== project) throw new Error(`页 #${pageId} 不属于「${project}」`)
    const image = detail.candidates.find((c) => c.id === imageId)
    if (!image) throw new Error(`#${imageId} 不是页 #${pageId} 的候选图`)
    const options = {
      text: detail.page.text,
      continued: detail.page.cont,
      title: detail.project,
      pageNumber: String(detail.page.number),
      background: detail.layout.background,
      textColor: detail.layout.textColor,
    }
    const digest = createHash("sha1").update(JSON.stringify(options)).digest("hex").slice(0, 16)
    const known = this.db
      .prepare("SELECT url FROM page_renders WHERE page_id = ? AND image_id = ? AND digest = ?")
      .get(pageId, imageId, digest) as { url: string } | undefined
    if (known) return known.url
    const composed = await composePage(await this.thumbs.original(image), options, this.fontPath())
    const url = await this.store(`pages/${digest}-${pageId}-${imageId}.png`, composed.png, "image/png")
    this.db
      .prepare("INSERT OR REPLACE INTO page_renders (page_id, image_id, digest, url, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(pageId, imageId, digest, url, now())
    return url
  }

  /** The publication with the publisher's own view of its job. */
  async status(id: number) {
    const view = this.view(this.row(id))
    let job: any = null
    let jobError: string | null = null
    if (view.ehJobId) {
      try {
        job = (await this.client().call("get_job", { job_id: view.ehJobId })).json
      } catch (error) {
        jobError = error instanceof Error ? error.message : String(error)
      }
    }
    return { ...view, job, jobError }
  }

  private job(id: number): string {
    const view = this.view(this.row(id))
    if (!view.ehJobId) throw new Error("这次发布还没在 E-Hentai 服务上建好任务，等准备完成")
    return view.ehJobId
  }

  /** Change a prepared gallery's details or cover before it is uploaded. */
  async update(id: number, changes: Partial<PublishSettings>) {
    const args: Record<string, unknown> = { job_id: this.job(id) }
    if (changes.title !== undefined) args.title = changes.title
    if (changes.titleJpn !== undefined) args.title_jpn = changes.titleJpn
    if (changes.description !== undefined) args.description = changes.description
    if (changes.language !== undefined) args.language = changes.language
    if (changes.languageType !== undefined) args.language_type = changes.languageType
    if (changes.acceptSiteTerms !== undefined) args.accept_site_terms = changes.acceptSiteTerms
    if (changes.coverStyle !== undefined) args.cover_style = changes.coverStyle
    if (changes.guroGender !== undefined) args.guro_gender = changes.guroGender
    if (changes.coverSpec !== undefined) args.cover_spec = changes.coverSpec ?? {}
    if (changes.backgroundImageId) args.cover_background_url = this.backgroundUrl(changes.backgroundImageId)
    const result = await this.client().call("update_gallery", args)
    const p = this.row(id)
    const settings = { ...JSON.parse(p.settings), ...changes }
    this.db.prepare("UPDATE publications SET settings = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(settings), now(), id)
    return result.json
  }

  /** The upload: the gallery becomes a draft on the site, for the person to review there. */
  async createDraft(id: number) {
    return (await this.client().call("create_draft", { job_id: this.job(id) })).json
  }

  /** After the person published on the site: tie the public gallery to the job and add the required tags. */
  async linkPublished(id: number, galleryUrl: string) {
    if (!/^https:\/\/(e-hentai|exhentai)\.org\/g\/\d+\/[0-9a-f]+\/?$/.test(galleryUrl.trim())) {
      throw new Error("画廊链接要像 https://e-hentai.org/g/1234567/abcdef1234/")
    }
    return (await this.client().call("apply_required_tags", { job_id: this.job(id), gallery_url: galleryUrl.trim() })).json
  }
}
