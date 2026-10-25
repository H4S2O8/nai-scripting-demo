/**
 * Small images for the review page: candidate thumbnails and page previews.
 *
 * A candidate is a 1–2 MB PNG; a phone listing a dozen of them would pull
 * twenty megabytes. Thumbnails live on R2 next to the originals: the first
 * time an image is viewed its 512 px JPEG is made, uploaded under
 * <prefix>-thumbs/ and its link recorded, and from then on the browser is
 * sent straight to the CDN — this server carries no thumbnail traffic and
 * keeps none on its small disk. Transparent cut-outs are laid on dark grey,
 * since JPEG has no alpha and would otherwise turn the empty area black.
 *
 * A deployment without R2 (a local preview) gets the JPEG served directly.
 * One with R2 whose upload fails gets an error, not a quiet local copy.
 *
 * Page previews are composed here, since they are the picture laid out with
 * the page's text, and cached on disk under a size cap.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { basename } from "node:path"

import { ImageRow, Library } from "./library"
import { composePage } from "./page"
import { putObject, r2Config } from "./r2"

const CACHE_LIMIT = 150 * 1024 * 1024
const THUMB_WIDTH = 512
/** Thumbnails made at once: a page of new images must not swamp a 2 GB box. */
const PARALLEL = 3

export class Thumbs {
  private writes = 0
  private running = 0
  private queue: (() => void)[] = []
  private pending = new Map<number, Promise<{ url: string } | { data: Buffer }>>()

  constructor(
    private outputDir: string,
    private fontPath: () => string,
    private library: () => Library,
  ) {}

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= PARALLEL) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.running++
    try {
      return await work()
    } finally {
      this.running--
      this.queue.shift()?.()
    }
  }

  private get dir() {
    const dir = join(this.outputDir, "cache")
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * The original PNG: this server's copy if it still has one, else its link.
   *
   * The link is one this server recorded itself, so it is fetched directly —
   * the private-address guard in fetchimage.ts is for links a caller hands
   * in, and would trip on a resolver that answers with fake-IP addresses.
   */
  async original(image: ImageRow): Promise<Buffer> {
    if (image.stored === "archive" || image.purgedAt) {
      throw new Error(`#${image.id} 已归档，线上没有原图（只在 Mac 备份里：${image.key}）`)
    }
    const local = join(this.outputDir, image.key.split("/").pop() ?? "")
    if (existsSync(local) && statSync(local).isFile()) return readFileSync(local)
    if (!image.url) throw new Error(`#${image.id} 没有可用的链接`)
    const response = await fetch(image.url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`#${image.id} 原图下载失败：HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  private cached(name: string, make: () => Promise<Buffer>): Promise<Buffer> {
    const file = join(this.dir, name)
    if (existsSync(file)) return Promise.resolve(readFileSync(file))
    return make().then((data) => {
      writeFileSync(file, data)
      if (++this.writes % 20 === 0) this.sweep()
      return data
    })
  }

  /** Oldest cache files go until the cache is back under its cap. */
  sweep() {
    const files = readdirSync(this.dir)
      .map((name) => {
        const path = join(this.dir, name)
        const st = statSync(path)
        return { path, size: st.size, at: st.mtimeMs }
      })
      .sort((a, b) => a.at - b.at)
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const file of files) {
      if (total <= CACHE_LIMIT) break
      rmSync(file.path, { force: true })
      total -= file.size
    }
  }

  private async makeThumb(image: ImageRow): Promise<Buffer> {
    const img = await loadImage(await this.original(image))
    const w = Math.min(THUMB_WIDTH, img.width)
    const h = Math.round((img.height * w) / img.width)
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext("2d")
    ctx.fillStyle = "#3a3a3a"
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toBuffer("image/jpeg", 80)
  }

  /**
   * Where the image's thumbnail is: its R2 link, made and recorded on first
   * request. Concurrent requests for one image share the work.
   */
  thumbnail(image: ImageRow): Promise<{ url: string } | { data: Buffer }> {
    if (image.thumbUrl) return Promise.resolve({ url: image.thumbUrl })
    const inFlight = this.pending.get(image.id)
    if (inFlight) return inFlight
    const work = this.slot(async () => {
      const data = await this.makeThumb(image)
      const config = r2Config()
      if (!config) return { data }
      const key = config.prefix.replace(/\/?$/, "") + "-thumbs/" + basename(image.key).replace(/\.png$/i, "") + ".jpg"
      await putObject(config, config.bucket, key, data, "image/jpeg", "public, max-age=31536000, immutable")
      const url = `${config.publicUrl}/${key}`
      this.library().setThumb(image.id, url)
      return { url }
    }).finally(() => this.pending.delete(image.id))
    this.pending.set(image.id, work)
    return work
  }

  /** A page as it will be composed, scaled to `width`, for previewing a candidate on its page. */
  async page(
    image: ImageRow,
    page: { id: number; text: string; cont: boolean },
    options: { title?: string; pageNumber?: string; background?: string; textColor?: string },
    width: number,
  ): Promise<Buffer> {
    const w = Math.min(2400, Math.max(320, Math.round(width / 64) * 64))
    const key = createHash("sha1")
      .update(JSON.stringify([page.text, page.cont, options]))
      .digest("hex")
      .slice(0, 12)
    return this.cached(`page-${page.id}-${image.id}-${key}-${w}.jpg`, async () => {
      const composed = await composePage(
        await this.original(image),
        { text: page.text, continued: page.cont, ...options },
        this.fontPath(),
      )
      const img = await loadImage(composed.png)
      const scale = Math.min(1, w / img.width)
      const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale))
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height)
      return canvas.toBuffer("image/jpeg", 85)
    })
  }
}
