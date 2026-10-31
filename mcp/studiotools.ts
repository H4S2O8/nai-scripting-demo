/**
 * MCP tools over the studio: projects, novel text, shots, drawing, verdicts
 * and review. The rules live in studio.ts; this file only turns them into
 * tools and readable results.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import { z } from "zod"

import { DEFAULT_PARAMS, GenerateParams, fitSize, maxCharacterPrompts, modelLabel } from "../nai"
import { ImageRow, Library } from "./library"
import { ensureFont } from "./page"
import { PageRow, STATUS_LABEL, Shot, Studio, pageFooter } from "./studio"

export type StudioDeps = {
  library: () => Library
  generate: (
    params: GenerateParams,
    count: number,
    filing: { project: string | null; tags: string[]; shotId: number | null },
  ) => Promise<{
    results: { seed: number; png: Buffer; filed: number | string; cost: number; path: string; remote: string | null }[]
    failure?: string
  }>
  publicUrl: (path: string, remote?: string | null) => string | null
  /** The bundled font, for the contact sheet's labels: the server has no system fonts. */
  fontPath: () => string
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

const text = (body: string, isError = false) =>
  isError ? { isError: true, content: [{ type: "text" as const, text: body }] } : { content: [{ type: "text" as const, text: body }] }
const fail = (error: unknown) => text(error instanceof Error ? error.message : String(error), true)

const caption = z.object({
  prompt: z.string(),
  negative: z.string().optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
})

const counts = (c: Shot["counts"] | null) =>
  c ? `候选 ${c.candidate} · 选中 ${c.picked} · 淘汰 ${c.rejected}${c.favorite ? ` · 推荐 ${c.favorite}` : ""}` : "无镜头"

function pageLine(p: PageRow): string {
  const head = p.text.replace(/\n/g, " ").slice(0, 24)
  return `页 #${p.id} · ${p.route ? p.route + " · " : ""}第${p.chapter}章第${p.page}页 · 页脚「${pageFooter(p)}」 · ${p.chars}字 · ${STATUS_LABEL[p.status]}` +
    (p.shotId ? ` · 镜头 #${p.shotId}（${counts(p.counts)}）` : "") + `\n  ${head}…`
}

function shotLine(s: Shot): string {
  const label = s.title || (s.pageId ? `页 #${s.pageId}` : "（脱页）")
  const prompt = s.prompt.length > 120 ? s.prompt.slice(0, 120) + "…" : s.prompt || "（还没写提示词）"
  const place = s.kind === "gallery" ? (s.seq !== null ? `第 ${s.seq} 格 · ` : "主线外 · ") : ""
  return `${place}镜头 #${s.id} · ${label} · ${STATUS_LABEL[s.status]} · ${counts(s.counts)}\n  ${prompt}`
}

/** A gallery's mainline at a glance: one line per panel, then how many shots are off it. */
function mainline(s: Studio, project: string): string {
  const shots = s.listShots(project)
  const on = shots.filter((x) => x.seq !== null)
  const off = shots.filter((x) => x.seq === null)
  return [
    `「${project}」主线 ${on.length} 格：`,
    ...on.map((x) => `  ${x.seq}. #${x.id} ${x.title || "（无标题）"} · ${STATUS_LABEL[x.status]}`),
    off.length ? `主线外 ${off.length} 个：${off.map((x) => `#${x.id}`).join(" ")}` : "",
  ].filter(Boolean).join("\n")
}

function candidateLine(row: ImageRow): string {
  const mark = row.verdict === "picked" ? "✔选中" : row.verdict === "rejected" ? "✘淘汰" : "候选"
  return `  #${row.id} ${mark}${row.favorite ? " ★推荐" : ""} · seed ${row.seed} · ${row.url ?? row.key}`
}

/**
 * The drawn candidates side by side, numbered by library id, so the agent can
 * judge a whole draw from one small image instead of opening each link.
 */
async function contactSheet(images: { id: number | string; png: Buffer }[], width: number, fontPath: string): Promise<Buffer> {
  const family = ensureFont(fontPath)
  const loaded = await Promise.all(images.map(async (i) => ({ id: i.id, img: await loadImage(i.png) })))
  const columns = Math.min(4, loaded.length)
  const gap = 6
  const cell = Math.floor((width - gap * (columns - 1)) / columns)
  const ratio = Math.max(...loaded.map((l) => l.img.height / l.img.width))
  const cellHeight = Math.round(cell * ratio)
  const rows = Math.ceil(loaded.length / columns)
  const canvas = createCanvas(width, rows * cellHeight + (rows - 1) * gap)
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = "#808080"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  loaded.forEach(({ id, img }, i) => {
    const x = (i % columns) * (cell + gap)
    const y = Math.floor(i / columns) * (cellHeight + gap)
    const scale = Math.min(cell / img.width, cellHeight / img.height)
    ctx.drawImage(img, x + (cell - img.width * scale) / 2, y + (cellHeight - img.height * scale) / 2, img.width * scale, img.height * scale)
    const label = typeof id === "number" ? `#${id}` : "?"
    ctx.font = `${Math.max(14, Math.round(cell / 9))}px "${family}"`
    const w = ctx.measureText(label).width
    ctx.fillStyle = "rgba(0,0,0,0.7)"
    ctx.fillRect(x, y, w + 12, Math.round(cell / 9) + 10)
    ctx.fillStyle = "#ffffff"
    ctx.textBaseline = "top"
    ctx.fillText(label, x + 6, y + 5)
  })
  return canvas.toBuffer("image/jpeg", 82)
}

export function registerStudioTools(server: McpServer, deps: StudioDeps) {
  const studio = () => new Studio(deps.library())

  server.registerTool(
    "novelai_project",
    {
      title: "Studio projects",
      description:
        "Projects live on the server. A `gallery` is a mainline: an ordered sequence of shots, one " +
        "panel each, with one picked main image per shot (see novelai_shot). A `novel` is chapters of text cut into pages, each " +
        "page with at most one shot and, in the end, one picked picture. A project also holds the " +
        "shared style (guidance and the prompt text to reuse — never inserted for you), character " +
        "sheets (appearance tags and outfits, for consistent prompts), layout settings and who " +
        "picks: `human` (default — the agent can only mark favourites) or `agent`. " +
        "Actions: list; get (settings, characters, progress); create; update (any setting, " +
        "characters to add or change by key, removeCharacters, renameTo).",
      inputSchema: {
        action: z.enum(["list", "get", "create", "update"]),
        name: z.string().optional().describe("The project. Required except for list."),
        kind: z.enum(["gallery", "novel"]).optional().describe("create only."),
        description: z.string().optional(),
        style: z
          .object({ notes: z.string().optional(), prompt: z.string().optional(), negative: z.string().optional() })
          .optional()
          .describe("Merged field by field into the existing style."),
        layout: z
          .object({
            split: z
              .object({ target: z.number().int(), min: z.number().int(), max: z.number().int() })
              .optional()
              .describe("Novel page length in characters; default 200 / 140 / 260."),
            screen: z.enum(["phone-landscape", "tablet-landscape"]).optional(),
            background: z.string().optional(),
            textColor: z.string().optional(),
          })
          .optional(),
        picker: z.enum(["human", "agent"]).optional(),
        characters: z
          .array(
            z.object({
              key: z.string().describe("Short id, e.g. lin."),
              name: z.string().optional(),
              tags: z.string().optional().describe("Appearance tags that do not change between scenes."),
              outfits: z.record(z.string()).optional().describe("Outfit name → tags."),
              notes: z.string().optional(),
            }),
          )
          .optional(),
        removeCharacters: z.array(z.string()).optional(),
        renameTo: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const s = studio()
        if (args.action === "list") return text(JSON.stringify(s.listProjects(), null, 2))
        if (!args.name) return text("要给项目名 name", true)
        if (args.action === "get") return text(JSON.stringify(s.getProject(args.name), null, 2))
        if (args.action === "create") {
          if (!args.kind) return text("新建项目要给 kind：gallery 或 novel", true)
          s.createProject({ name: args.name, kind: args.kind, description: args.description, style: args.style, layout: args.layout, picker: args.picker })
          if (args.characters?.length) s.setCharacters(args.name, args.characters)
          return text(JSON.stringify(s.getProject(args.name), null, 2))
        }
        if (args.kind) return text("项目建好后不能改类型", true)
        let current = s.updateProject(args.name, {
          description: args.description,
          style: args.style,
          layout: args.layout,
          picker: args.picker,
          renameTo: args.renameTo,
        })
        if (args.characters?.length || args.removeCharacters?.length) {
          current = s.setCharacters(current.name, args.characters ?? [], args.removeCharacters ?? [])
        }
        return text(JSON.stringify(current, null, 2))
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    "novelai_novel_text",
    {
      title: "Novel chapters and pages",
      description:
        "A novel's text lives on the server, one chapter at a time, and is cut into pages there " +
        "(about 200 characters each by default; quotes are never split, paragraph breaks are " +
        "preferred). Actions: set (create the next chapter or replace one's text — pages whose " +
        "text is unchanged keep their shot and images; shots on changed pages become detached and " +
        "show up in novelai_review); resplit (re-cut a chapter with new lengths, optionally only " +
        "from one page on); info (change a chapter's title or route without touching its text); " +
        "pages (each page's id, length, status and shot); read (full text of pages, with their shots). " +
        "Side stories (番外, IF routes) are chapters with a route label such as \"IF 1\": they come " +
        "after every main chapter, one route's chapters together; the first chapter's title names the " +
        "route in the upload's table of contents. Their pages are numbered within the route (footer " +
        "\"IF 1 · 3\"), and an upload gets a page with just the label before each route.",
      inputSchema: {
        action: z.enum(["set", "resplit", "info", "pages", "read"]),
        project: z.string(),
        chapter: z.number().int().positive().optional().describe("Chapter number, from 1."),
        title: z.string().optional(),
        route: z
          .string()
          .max(16)
          .optional()
          .describe("set/info: \"\" for the main story, else the side story's label, e.g. \"IF 1\". Omit to keep."),
        text: z.string().max(200_000).optional().describe("set: the chapter's whole original text."),
        target: z.number().int().optional().describe("Page length; min and max default to 0.7× and 1.3×."),
        min: z.number().int().optional(),
        max: z.number().int().optional(),
        fromPage: z.number().int().positive().optional().describe("resplit: keep the pages before this one."),
        status: z.enum(["shot", "draw", "pick", "done"]).optional().describe("pages: only pages in this state."),
        pageIds: z.array(z.number().int()).max(30).optional().describe("read: which pages."),
      },
    },
    async (args) => {
      try {
        const s = studio()
        const split =
          args.target !== undefined
            ? {
                target: args.target,
                min: args.min ?? Math.round(args.target * 0.7),
                max: args.max ?? Math.round(args.target * 1.3),
              }
            : undefined
        if (args.action === "set" || args.action === "resplit") {
          if (!args.chapter) return text("要给 chapter（章节号）", true)
          const result =
            args.action === "set"
              ? (() => {
                  if (!args.text) throw new Error("set 要给 text（这一章的完整原文）")
                  return s.setChapter(args.project, { chapter: args.chapter, title: args.title, route: args.route, text: args.text, split })
                })()
              : s.resplitChapter(args.project, { chapter: args.chapter, split, fromPage: args.fromPage })
          return text(
            [
              `第 ${result.chapter} 章${result.route ? "（番外 " + result.route + "）" : ""}${result.title ? "「" + result.title + "」" : ""}：${result.pages} 页，每页 ${result.lengths.min}–${result.lengths.max} 字`,
              result.reused > 0 ? `沿用了 ${result.reused} 页（镜头和图都还在）` : "",
              result.detached.length
                ? `这些镜头的页文字变了，已脱页（镜头和图保留，用 novelai_shot set 的 shots:[{shotId, pageId}] 重新挂到页上）：\n` +
                  result.detached.map((d) => `  镜头 #${d.shotId}：${d.text}…`).join("\n")
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          )
        }
        if (args.action === "info") {
          if (!args.chapter) return text("要给 chapter（章节号）", true)
          const info = s.setChapterInfo(args.project, { chapter: args.chapter, title: args.title, route: args.route })
          return text(`第 ${info.chapter} 章：${info.route ? "番外 " + info.route : "正文"}${info.title ? "「" + info.title + "」" : ""}`)
        }
        if (args.action === "pages") {
          const pages = s.listPages(args.project, { chapter: args.chapter, status: args.status })
          return text(pages.length ? pages.map(pageLine).join("\n") : "没有符合条件的页。")
        }
        if (!args.pageIds?.length) return text("read 要给 pageIds", true)
        const all = s.listPages(args.project)
        const wanted = args.pageIds.map((id) => {
          const page = all.find((p) => p.id === id)
          if (!page) throw new Error(`「${args.project}」里没有页 #${id}`)
          return page
        })
        const shots = new Map(s.getShots(wanted.flatMap((p) => (p.shotId ? [p.shotId] : []))).map((x) => [x.id, x]))
        return text(
          wanted
            .map((p) => {
              const shot = p.shotId ? shots.get(p.shotId) : undefined
              return [
                `页 #${p.id} · ${p.route ? p.route + " · " : ""}第${p.chapter}章第${p.page}页 · 页脚「${pageFooter(p)}」${p.cont ? "（接上页段落）" : ""} · ${p.chars}字 · ${STATUS_LABEL[p.status]}`,
                p.text,
                shot ? `镜头 #${shot.id}：${shot.prompt || "（未写提示词）"}` : "镜头：无",
              ].join("\n")
            })
            .join("\n\n"),
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  const shotSpec = z.object({
    shotId: z.number().int().optional().describe("Edit this shot; omit to create one."),
    pageId: z.number().int().optional().describe("Novel: the page; with shotId, re-attaches a detached shot."),
    title: z.string().optional().describe("Gallery: what the panel is; required for a new gallery shot."),
    prompt: z.string().optional(),
    negative: z.string().optional(),
    characters: z.array(caption).optional(),
    model: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    steps: z.number().int().min(1).max(50).optional(),
    guidance: z.number().min(0).max(10).optional(),
    sampler: z.string().optional(),
    note: z.string().optional(),
  })

  server.registerTool(
    "novelai_shot",
    {
      title: "Shots: what to draw",
      description:
        "A shot is a place that needs a picture, holding the final prompt — sent verbatim, as with " +
        "novelai_generate_image (see novelai_guide). Every shot ends with one picked main image; " +
        "everything else drawn for it stays a candidate. In a novel each page has at most one shot " +
        "(pageId). A gallery is a mainline: an ordered sequence of shots, one panel each, that is " +
        "what gets published; a shot can also sit off the mainline (character sheet, discarded " +
        "take). Redrawing the same panel — another seed, another style — means drawing more " +
        "candidates for that shot, not a new shot. Every action takes any number of shots, one " +
        "included, and applies all or nothing. Actions: set (shots: create, or change the fields " +
        "you pass on those with a shotId; new gallery shots are appended to the mainline in the " +
        "order given — or before/after/at puts all of them there as one block, or offLine keeps " +
        "them off it); get (shotIds: full spec plus every candidate with its verdict); list (a " +
        "project's shots, a gallery's in mainline order, optionally by status); order (project + " +
        "shotIds: the whole mainline, exactly these in this order; the rest go off it); place " +
        "(shotIds: insert them as one block before or after another shot, at a 1-based position, " +
        "or with none of these at the end; shots already on the mainline move); unplace (shotIds: " +
        "take them off the mainline, keeping their images); merge (shotId + shotIds: fold those " +
        "duplicate shots into this one, their images becoming its candidates, then delete them); " +
        "adopt (shotId + imageIds: make images already in the library — e.g. drawn with " +
        "novelai_generate_image — candidates of this shot. Images in another shot or archived are " +
        "refused).",
      inputSchema: {
        action: z.enum(["set", "get", "list", "order", "place", "unplace", "merge", "adopt"]),
        project: z.string().optional().describe("set, list and order."),
        shots: z.array(shotSpec).min(1).max(50).optional().describe("set: the shots, in order."),
        shotIds: z.array(z.number().int()).min(1).max(200).optional()
          .describe("get, place, unplace; order: the whole mainline; merge: the shots to fold in."),
        shotId: z.number().int().optional().describe("merge and adopt: the shot that receives."),
        before: z.number().int().optional().describe("set/place: a shot id on the mainline to go before."),
        after: z.number().int().optional().describe("set/place: a shot id on the mainline to go after."),
        at: z.number().int().min(1).optional().describe("set/place: 1-based mainline position."),
        offLine: z.boolean().optional().describe("set: keep these gallery shots off the mainline."),
        imageIds: z.array(z.number().int()).min(1).max(50).optional().describe("adopt: library image ids."),
        status: z.enum(["shot", "draw", "pick", "done"]).optional().describe("list."),
      },
    },
    async (args) => {
      try {
        const s = studio()
        if (args.action === "list") {
          if (!args.project) return text("list 要给 project", true)
          const shots = s.listShots(args.project, args.status)
          return text(shots.length ? shots.map(shotLine).join("\n") : "没有符合条件的镜头。")
        }
        const where = { before: args.before, after: args.after, at: args.at }
        const placed = [args.before, args.after, args.at].some((x) => x !== undefined)
        if (args.action === "order") {
          if (!args.project || !args.shotIds) return text("order 要给 project 和 shotIds（整条主线，按顺序）", true)
          s.order(args.project, args.shotIds)
          return text("主线已重排\n" + mainline(s, args.project))
        }
        if (args.action === "place" || args.action === "unplace") {
          if (!args.shotIds) return text(`${args.action} 要给 shotIds`, true)
          const shots = args.action === "place" ? s.place(args.shotIds, where) : s.unplace(args.shotIds)
          return text((args.action === "place" ? "已放上主线" : "已移出主线") + "\n" + mainline(s, shots[0].project))
        }
        if (args.action === "merge") {
          if (!args.shotId || !args.shotIds) return text("merge 要给 shotId（留下的）和 shotIds（并进来的）", true)
          const shot = s.merge(args.shotId, args.shotIds)
          return text(`已并入镜头 #${shot.id}：${counts(shot.counts)}\n` + (shot.kind === "gallery" ? mainline(s, shot.project) : shotLine(shot)))
        }
        if (args.action === "adopt") {
          if (!args.shotId || !args.imageIds) return text("adopt 要给 shotId 和 imageIds", true)
          const rows = s.adopt(args.shotId, args.imageIds)
          const shot = s.getShots([args.shotId])[0]
          return text(`已收进镜头 #${shot.id} 作为候选：\n` + rows.map(candidateLine).join("\n") + `\n现在：${counts(shot.counts)}`)
        }
        if (args.action === "get") {
          if (!args.shotIds) return text("get 要给 shotIds", true)
          return text(
            s
              .getShots(args.shotIds)
              .map((shot) => {
                const { counts: _, status, ...spec } = shot
                const candidates = s.candidates(shot.id)
                return [
                  `镜头 #${shot.id} · ${STATUS_LABEL[status]}`,
                  JSON.stringify(spec, null, 2),
                  candidates.length ? "候选：\n" + candidates.map(candidateLine).join("\n") : "还没有抽过。",
                ].join("\n")
              })
              .join("\n\n"),
          )
        }
        if (!args.project || !args.shots) return text("set 要给 project 和 shots", true)
        if (args.offLine && placed) return text("offLine 和 before/after/at 不能一起给", true)
        const shots = s.setShots(
          args.project,
          args.shots.map(({ shotId, pageId, ...spec }) => ({ shotId, pageId, spec })),
          args.offLine ? false : placed ? where : undefined,
        )
        const out = [`已保存 ${shots.length} 个镜头`, ...shots.map(shotLine)]
        if (shots[0].kind === "gallery") out.push(mainline(s, shots[0].project))
        return text(out.join("\n"))
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    "novelai_draw",
    {
      title: "Draw candidates for a shot",
      description:
        "Draw images from a shot's stored prompt and settings — the same prompt each time, a fresh " +
        "seed per image — and file them as the shot's candidates. Returns their library ids and, " +
        "by default, one small contact sheet with every candidate labelled by id, to judge the " +
        "draw at a glance. Then mark the good ones with novelai_verdict (favorite, or pick when " +
        "the project lets the agent pick). At 1 MP and 28 steps or fewer, Opus draws are free. " +
        "Pass seeds to draw those exact seeds instead of fresh ones — the same seed, prompt and " +
        "settings reproduce an image.",
      inputSchema: {
        shotId: z.number().int(),
        count: z.number().int().min(1).max(8).optional().describe("Default 4. Ignored when seeds is given."),
        seeds: z
          .array(z.number().int().min(1).max(4294967295))
          .min(1)
          .max(8)
          .optional()
          .describe("Draw exactly these seeds, one image each."),
        preview: z.enum(["sheet", "none"]).optional().describe("Default sheet."),
        sheetWidth: z.number().int().min(256).max(1536).optional().describe("Default 768."),
      },
    },
    async (args) => {
      let shot: Shot
      try {
        shot = studio().getShots([args.shotId])[0]
      } catch (error) {
        return fail(error)
      }
      if (!shot.prompt.trim()) return text(`镜头 #${shot.id} 还没写提示词，先用 novelai_shot set`, true)
      const fitted = fitSize(shot.width ?? DEFAULT_PARAMS.width, shot.height ?? DEFAULT_PARAMS.height)
      const params: GenerateParams = {
        ...DEFAULT_PARAMS,
        model: shot.model ?? DEFAULT_PARAMS.model,
        stylePrompt: "",
        characterPrompt: "",
        prompt: shot.prompt,
        negative: shot.negative,
        width: fitted.width,
        height: fitted.height,
        steps: shot.steps ?? DEFAULT_PARAMS.steps,
        guidance: shot.guidance ?? DEFAULT_PARAMS.guidance,
        sampler: shot.sampler ?? DEFAULT_PARAMS.sampler,
        seed: 0,
        batch: 1,
        verbatim: true,
        characters: shot.characters.map((c) => ({
          prompt: c.prompt,
          negative: c.negative ?? "",
          useCoords: c.x != null && c.y != null,
          x: c.x ?? 0.5,
          y: c.y ?? 0.5,
        })),
      }
      if (params.characters.length > 0 && maxCharacterPrompts(params.model) === 0) {
        return text(`${modelLabel(params.model)} 不支持人物 caption，请把镜头的 model 换成 V4 及以上`, true)
      }
      const filing = { project: shot.project, tags: [] as string[], shotId: shot.id }
      let batch: Awaited<ReturnType<StudioDeps["generate"]>>
      if (args.seeds?.length) {
        batch = { results: [] }
        for (const seed of args.seeds) {
          const one = await deps.generate({ ...params, seed }, 1, filing)
          batch.results.push(...one.results)
          if (one.failure) {
            batch.failure = one.failure
            break
          }
        }
      } else {
        batch = await deps.generate(params, args.count ?? 4, filing)
      }
      const lines = batch.results.map(
        (r) => `  ${typeof r.filed === "number" ? "#" + r.filed : "入库失败：" + r.filed} · seed ${r.seed} · ${deps.publicUrl(r.path, r.remote) ?? r.path}`,
      )
      const spent = batch.results.reduce((sum, r) => sum + r.cost, 0)
      const after = studio().getShots([shot.id])[0]
      const summary = [
        batch.failure ? batch.failure : `镜头 #${shot.id} 抽了 ${batch.results.length} 张 · ${spent === 0 ? "免费（Opus）" : spent + " Anlas"}`,
        ...lines,
        `现在：${counts(after.counts)}`,
      ].join("\n")
      const content: Content[] = [{ type: "text", text: summary }]
      if ((args.preview ?? "sheet") === "sheet" && batch.results.length) {
        try {
          const sheet = await contactSheet(batch.results.map((r) => ({ id: r.filed, png: r.png })), args.sheetWidth ?? 768, deps.fontPath())
          content.push({ type: "image", data: sheet.toString("base64"), mimeType: "image/jpeg" })
        } catch (error) {
          // The draw itself succeeded and is filed; say what is missing.
          content.push({ type: "text", text: "缩略图拼图生成失败：" + (error instanceof Error ? error.message : String(error)) })
        }
      }
      return batch.failure && batch.results.length === 0 ? { isError: true, content } : { content }
    },
  )

  server.registerTool(
    "novelai_verdict",
    {
      title: "Decide on candidates",
      description:
        "Mark candidates: favorite / unfavorite (a recommendation, always allowed), pick (the " +
        "shot's main image — a shot keeps one, picking another returns the old one to the " +
        "candidates), reject, or reset to candidate. pick is refused " +
        "unless the project's picker is agent: by default a person makes the final choice. When " +
        "the user names the image to use in the conversation, pass decidedBy: user — that is " +
        "their pick, recorded as such. Never pass it for your own choice.",
      inputSchema: {
        imageIds: z.array(z.number().int()).min(1).max(50),
        action: z.enum(["favorite", "unfavorite", "pick", "reject", "reset"]),
        decidedBy: z
          .enum(["agent", "user"])
          .optional()
          .describe("user only when the user chose these images themselves in the conversation. Default agent."),
      },
    },
    async (args) => {
      try {
        const rows = studio().verdict(args.imageIds, args.action, args.decidedBy === "user" ? "human" : "agent")
        return text("已更新：\n" + rows.map(candidateLine).join("\n"))
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    "novelai_review",
    {
      title: "What is waiting in a project",
      description:
        "A project's to-do list: open feedback from the human reviewer (act on it, then resolve " +
        "it), shots awaiting a pick, shots with a prompt but no draws, pages or concepts still " +
        "needing a shot, and detached shots whose page text changed. Actions: list (default); " +
        "comment (leave a note on the project, a page, a shot or an image); resolve (feedback ids).",
      inputSchema: {
        project: z.string(),
        action: z.enum(["list", "comment", "resolve"]).optional(),
        target: z.enum(["project", "page", "shot", "image"]).optional(),
        targetId: z.number().int().optional(),
        body: z.string().optional(),
        ids: z.array(z.number().int()).optional(),
      },
    },
    async (args) => {
      try {
        const s = studio()
        if (args.action === "comment") {
          if (!args.body) return text("comment 要给 body", true)
          const f = s.comment(args.project, { target: args.target ?? "project", targetId: args.targetId, body: args.body, author: "agent" })
          return text(`已留言 #${f.id}`)
        }
        if (args.action === "resolve") {
          if (!args.ids?.length) return text("resolve 要给 ids", true)
          s.resolve(args.project, args.ids)
          return text(`已解决：${args.ids.map((id) => "#" + id).join(", ")}`)
        }
        const r = s.review(args.project)
        const section = (title: string, items: string[]) => (items.length ? [`## ${title}（${items.length}）`, ...items] : [])
        const out = [
          `「${r.project}」· ${r.kind === "novel" ? "小说" : "图集"} · 选图：${r.picker === "human" ? "人" : "agent"}`,
          ...section(
            "审阅意见",
            r.feedback.map((f) => `意见 #${f.id} · ${f.target}${f.targetId ? " #" + f.targetId : ""} · ${f.body}`),
          ),
          ...section("待选图", r.toPick.map(shotLine)),
          ...section("待抽卡", r.toDraw.map(shotLine)),
          ...section(
            r.kind === "novel" ? "待写镜头的页" : "待写提示词的镜头",
            (r.toWrite as (PageRow | Shot)[]).map((x) => ("chapter" in x ? pageLine(x) : shotLine(x))),
          ),
          ...section("脱页的镜头", r.detached.map(shotLine)),
        ]
        return text(out.length > 1 ? out.join("\n") : out[0] + "\n没有待办。")
      } catch (error) {
        return fail(error)
      }
    },
  )
}
