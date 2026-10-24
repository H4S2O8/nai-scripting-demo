/**
 * The NovelAI tools, shared by both entry points.
 *
 * The valuable part is not this file — it is `../nai.ts`, whose request builder
 * was diffed against the official client and is covered by the repo's tests.
 * This wraps that same builder so a desktop MCP client (stdio.ts) and a phone
 * over the network (http.ts) both send exactly the payload the app sends.
 *
 * Configuration is by environment:
 *   NOVELAI_TOKENS         the account pool: several pst- tokens separated by
 *                          commas or newlines, each optionally "label=token".
 *                          Generation picks per request — see pool.ts.
 *   NOVELAI_TOKEN          a single pst- token; folded into the same pool
 *   NOVELAI_OUTPUT_DIR     optional, defaults to ~/Pictures/NovelAI
 *   NOVELAI_INLINE_IMAGES  "1" to inline a preview when imageSize is omitted;
 *                          off by default, so an omitted imageSize means none
 *   NOVELAI_PUBLIC_URL     optional, base URL that serves NOVELAI_OUTPUT_DIR
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_PARAMS,
  GenerateParams,
  MODELS,
  SAMPLERS,
  SIZE_PRESETS,
  buildPayload,
  fetchAccount,
  fitSize,
  maxCharacterPrompts,
  modelLabel,
  rollSeed,
} from "../nai"
import { firstPng } from "./zip"
import { r2Config, uploadToR2 } from "./r2"
import { Lease, acquire, fail, poolSize, refreshAll, status, succeed } from "./pool"
import { TOPICS, TOPIC_NAMES, guideIndex, guideText } from "./guide"
import { transparentFraction } from "./png"
import { CharacterRecord, ImageRow, Library, cleanName, cleanTags } from "./library"
import { checkPageOptions, composePage } from "./page"
import { fetchImage } from "./fetchimage"
import { registerStudioTools } from "./studiotools"

const IMAGE_HOST = "https://image.novelai.net"

/**
 * Shared wording for `imageSize`, so every generation tool states the same
 * default. Nothing is inlined unless the caller asks: the picture is always
 * reachable by link, and an inlined one is paid for again on every later turn.
 */
const IMAGE_SIZE_HELP =
  "How much image to put in the conversation. none (the default) inlines nothing and returns " +
  "only the link; preview inlines a small JPEG; full inlines the original PNG (~2MB of base64). " +
  "An inlined image stays in the history and is resent every turn, so ask for preview only when " +
  "the user wants to look at the result, and leave it off while iterating on prompts or " +
  "generating drafts. The full-resolution file is linked in every case."

function outputDir(): string {
  const dir = process.env.NOVELAI_OUTPUT_DIR?.trim() || join(homedir(), "Pictures", "NovelAI")
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Keep the newest N local PNGs and drop the rest.
 *
 * R2 holds the durable copy; the local file exists so the preview can be
 * rendered and so /images/ still works if the upload failed. Without a sweep
 * the disk only ever grows.
 */
function sweepLocal(keep = Number(process.env.NOVELAI_LOCAL_KEEP ?? 50)) {
  if (!Number.isFinite(keep) || keep < 1) return
  try {
    const dir = outputDir()
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".png"))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const file of files.slice(keep)) {
      rmSync(join(dir, file.name), { force: true })
    }
  } catch {
    /* housekeeping must never break a generation */
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15)
}

/**
 * Downscaled JPEG for inlining, or null when ffmpeg is unavailable.
 *
 * A full-size PNG is ~1.7MB, ~2.3MB once base64'd, and a phone on a mobile
 * link times out pulling that through the tunnel — measured, not guessed. A
 * 512px JPEG is a few tens of KB and renders immediately; the untouched
 * original stays one URL away.
 */
function preview(
  pngPath: string,
  width = 512,
  // A JPEG has no alpha channel, so previewing a cut-out asset as one shows
  // the transparency as solid black. A cut-out asks for a PNG instead and
  // pays the extra bytes.
  format: "jpeg" | "png" = "jpeg",
): Buffer | null {
  const png = format === "png"
  const out = pngPath.replace(/\.png$/, png ? ".preview.png" : ".preview.jpg")
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error", "-i", pngPath, "-vf", `scale=${width}:-2`,
        ...(png ? [] : ["-q:v", "5"]),
        out,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 },
    )
    const data = readFileSync(out)
    rmSync(out, { force: true })
    return data
  } catch {
    return null
  }
}

type InlineContent = { type: "image"; data: string; mimeType: string }

/**
 * The image to put in the conversation, or null for none.
 *
 * Shared by every generation tool so the token-cost behaviour is identical
 * across them: an inlined image is resent on every later turn, so the default
 * is a small preview and "none" is a real option while iterating.
 */
function inlineImage(
  imageSize: "preview" | "full" | "none" | undefined,
  png: Buffer | null,
  path: string,
  previewWidth?: number,
  keepAlpha = false,
): InlineContent | null {
  const wants = imageSize === "none" ? false : imageSize != null || inlineByDefault()
  if (!wants || !path) return null
  const small =
    imageSize === "full"
      ? null
      : preview(path, previewWidth ?? defaultPreviewWidth(), keepAlpha ? "png" : "jpeg")
  if (small) {
    return {
      type: "image",
      data: small.toString("base64"),
      mimeType: keepAlpha ? "image/png" : "image/jpeg",
    }
  }
  // Either imageSize:"full" was asked for, or ffmpeg is unavailable. Send the
  // original rather than nothing, and accept that a slow link may struggle
  // with ~2MB of base64.
  if (png) return { type: "image", data: png.toString("base64"), mimeType: "image/png" }
  return null
}

async function readError(response: Response): Promise<string> {
  const hint =
    response.status === 401
      ? "令牌无效或已过期"
      : response.status === 402
        ? "Anlas 或订阅额度不足"
        : response.status === 429
          ? "请求过于频繁"
          : ""
  let detail = ""
  try {
    const text = await response.text()
    try {
      detail = JSON.parse(text)?.message ?? text
    } catch {
      detail = text
    }
  } catch {
    /* body unreadable */
  }
  return `HTTP ${response.status}${detail ? " · " + String(detail).slice(0, 200) : ""}${
    hint ? " · " + hint : ""
  }`
}

/** One image. Batches are the caller's business, as in the app. */
async function generateOne(params: GenerateParams, seed: number, authToken: string) {
  const payload = buildPayload(params, seed)
  const actualSeed = (payload.parameters as { seed: number }).seed

  // Stage timings go to the journal so a slow generation can be blamed on the
  // right leg: NovelAI's queue, the download, or the R2 upload.
  const t0 = Date.now()
  const response = await fetch(`${IMAGE_HOST}/ai/generate-image`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + authToken,
      "Content-Type": "application/json",
      Accept: "application/zip, application/octet-stream",
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await readError(response))
  const tHeaders = Date.now()

  const body = Buffer.from(await response.arrayBuffer())
  if (body.length === 0) throw new Error("响应体为空")
  const tBody = Date.now()

  // A ZIP normally, but some gateways hand back the PNG directly.
  const png =
    body.subarray(0, 2).toString("hex") === "504b"
      ? firstPng(body)
      : body.subarray(0, 4).toString("hex") === "89504e47"
        ? body
        : (() => {
            throw new Error(body.toString("utf8").slice(0, 200) || "响应既不是 ZIP 也不是 PNG")
          })()

  // The random suffix is a capability: /images/ is unauthenticated so that a
  // chat client can actually render the picture, and an unguessable name is
  // what keeps it private.
  const path = join(outputDir(), `nai_${stamp()}_${actualSeed}_${randomBytes(8).toString("hex")}.png`)
  writeFileSync(path, png)

  // Uploaded when R2 is configured, so the link survives the server's disk and
  // the tunnel does not carry every view. A failed upload is not fatal: the
  // local copy and /images/ still work.
  const config = r2Config()
  const remote = config ? await uploadToR2(config, path, png) : null
  // The library's identity for the image: its R2 key, or a marker that only
  // this server's disk has it.
  const key = remote && config ? config.prefix + basename(path) : "local:" + basename(path)
  const tDone = Date.now()
  console.error(
    `[timing] nai_ttfb=${tHeaders - t0}ms download=${tBody - tHeaders}ms ` +
      `(${(body.length / 1024).toFixed(0)}KB) r2=${tDone - tBody}ms total=${tDone - t0}ms`,
  )

  return { path, seed: actualSeed, bytes: png.length, png, remote, key }
}

/**
 * Generate one image, moving to the next account when this one is the problem.
 *
 * Each image takes its own lease rather than one lease per batch: a four-image
 * request then spreads across the pool instead of draining one account, which
 * is the whole point of having several.
 *
 * Attempts are capped at the pool size — once every account has refused, the
 * request is not going to succeed, and retrying past that only burns quota.
 */
async function generateWithFailover(params: GenerateParams, seed: number) {
  const attempts = Math.max(1, poolSize())
  let lastError: unknown = new Error("没有可用账户")
  for (let attempt = 0; attempt < attempts; attempt++) {
    let lease: Lease
    const tAcquire = Date.now()
    try {
      lease = await acquire(params)
      const spent = Date.now() - tAcquire
      if (spent > 50) console.error(`[timing] acquire=${spent}ms (account refresh)`)
    } catch (error) {
      // acquire() only fails when nothing can serve the request, and its
      // message already explains why for every account. Nothing to retry.
      throw error
    }
    try {
      const made = await generateOne(params, seed, lease.account.token)
      succeed(lease)
      return { ...made, account: lease.account.label, free: lease.free, cost: lease.cost }
    } catch (error) {
      lastError = error
      // A bad prompt fails the same way everywhere; only an account-specific
      // failure is worth handing to someone else.
      if (!fail(lease, error).retryable) throw error
    }
  }
  throw lastError
}

/**
 * Whether an omitted `imageSize` should still inline a preview.
 *
 * Off. An inlined image is resent on every later turn, so a caller that never
 * said it wanted to look at the picture should not be charged for carrying it
 * — the link is always in the text. Set NOVELAI_INLINE_IMAGES=1 to go back to
 * inlining a preview by default.
 */
function inlineByDefault(): boolean {
  return (process.env.NOVELAI_INLINE_IMAGES ?? "0").trim() === "1"
}

/**
 * Default preview width.
 *
 * An inlined image stays in the conversation and is resent on every later
 * turn, so its cost is cumulative, not one-off. Halving the width quarters the
 * pixels and roughly quarters what it costs to carry.
 */
function defaultPreviewWidth(): number {
  const raw = Number(process.env.NOVELAI_PREVIEW_WIDTH)
  return Number.isFinite(raw) && raw >= 128 && raw <= 2048 ? Math.floor(raw) : 512
}

/**
 * Public URL for a saved file.
 *
 * Prefers the R2 object when the upload succeeded; falls back to this server's
 * own /images/ route, which is why a storage outage costs a nicer link rather
 * than the picture.
 */
export function publicUrl(path: string, remote?: string | null): string | null {
  if (remote) return remote
  const base = process.env.NOVELAI_PUBLIC_URL?.trim()
  if (!base) return null
  return base.replace(/\/+$/, "") + "/images/" + encodeURIComponent(path.split("/").pop() ?? "")
}

type Generated = {
  path: string
  seed: number
  remote: string | null
  account: string
  free: boolean
  cost: number
  clear: number | null
  png: Buffer
  /** Library id, or why it could not be recorded. */
  filed: number | string
}

/**
 * Generate `count` images and record each in the library as it lands.
 *
 * Recorded per image, so a batch that fails half-way still files what it
 * already paid for; the failure then names what was saved.
 */
async function generateAndFile(
  params: GenerateParams,
  count: number,
  filing: { project: string | null; tags: string[]; shotId: number | null },
): Promise<{ results: Generated[]; lastPng: Buffer | null; lastPath: string; failure?: string }> {
  const results: Generated[] = []
  const characters: CharacterRecord[] = params.characters.map((c) => ({
    prompt: c.prompt,
    negative: c.negative,
    x: c.useCoords ? c.x : null,
    y: c.useCoords ? c.y : null,
  }))
  let lastPng: Buffer | null = null
  let lastPath = ""
  try {
    for (let i = 0; i < count; i++) {
      const seed = params.seed > 0 ? params.seed : rollSeed()
      const made = await generateWithFailover(params, seed)
      const clear = transparentFraction(made.png)
      let filed: number | string
      try {
        filed = library().add({
          key: made.key,
          url: publicUrl(made.path, made.remote),
          stored: made.remote ? "r2" : "local",
          createdAt: new Date().toISOString(),
          model: params.model,
          source: null,
          width: params.width,
          height: params.height,
          steps: params.steps,
          guidance: params.guidance,
          sampler: params.sampler,
          seed: made.seed,
          prompt: params.prompt,
          negative: params.negative,
          characters,
          transparent: clear,
          bytes: made.bytes,
          account: made.account,
          cost: made.cost,
          origin: "generate",
          project: filing.project,
          tags: filing.tags,
          shotId: filing.shotId,
        }).id
      } catch (error) {
        filed = errorText(error)
      }
      results.push({
        path: made.path,
        seed: made.seed,
        remote: made.remote,
        account: made.account,
        free: made.free,
        cost: made.cost,
        clear,
        png: made.png,
        filed,
      })
      lastPng = made.png
      lastPath = made.path
    }
  } catch (error) {
    const message = errorText(error)
    return {
      results,
      lastPng,
      lastPath,
      failure:
        results.length > 0
          ? `完成 ${results.length} 张后失败：${message}\n已保存：\n` +
            results.map((r) => (typeof r.filed === "number" ? `#${r.filed} ` : "") + r.path).join("\n")
          : `生成失败：${message}`,
    }
  }
  return { results, lastPng, lastPath }
}

/**
 * The image library, opened on first use.
 *
 * NOVELAI_LIBRARY_DB names the SQLite file; by default it sits in the output
 * directory, the one path the systemd unit lets the service write. A library
 * that cannot open is an error on every library call — never a silent no-op.
 */
let openLibrary: Library | null = null
export function library(): Library {
  if (!openLibrary) {
    const path = process.env.NOVELAI_LIBRARY_DB?.trim() || join(outputDir(), "library.db")
    openLibrary = new Library(path)
  }
  return openLibrary
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textResult(text: string, isError = false) {
  return isError
    ? { isError: true, content: [{ type: "text" as const, text }] }
    : { content: [{ type: "text" as const, text }] }
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "novelai-image", version: "1.0.0" })

  server.registerTool(
    "novelai_generate_image",
    {
      title: "Generate a NovelAI image",
      description:
        "Generate one or more images with NovelAI and save them as PNG files. " +
        "The prompt, negative and character captions are sent VERBATIM: the server adds no " +
        "quality tags, no undesired-content preset and no transparency tags, so what you write " +
        "is exactly what the model sees. Read novelai_guide before writing a prompt you are " +
        "unsure about — it has the V5 prompt rules, the official quality tags and UC presets to " +
        "copy in, text rendering (a Text: directive must come last, or the tags after it get " +
        "lettered too), multi-character captions, transparent cut-outs, visual-novel assets and " +
        "manga pages, each with a worked example. " +
        "Returns the links plus the seed, the Anlas cost and how much of each image is actually " +
        "transparent, so a cut-out that came back opaque is visible. " +
        "Call novelai_list_options for the valid model, sampler or size values.",
      inputSchema: {
        prompt: z.string().describe("The final positive prompt, sent as-is."),
        negative: z
          .string()
          .optional()
          .describe("The final negative prompt, sent as-is. Empty by default — no preset is merged in."),
        model: z
          .string()
          .optional()
          .describe(`Model id, default ${DEFAULT_PARAMS.model}. See novelai_list_options.`),
        width: z.number().int().optional().describe("Snapped to a multiple of 64; pair capped at 3 MP."),
        height: z.number().int().optional(),
        steps: z.number().int().min(1).max(50).optional().describe(`Default ${DEFAULT_PARAMS.steps}.`),
        guidance: z.number().min(0).max(10).optional().describe(`Prompt guidance, default ${DEFAULT_PARAMS.guidance}.`),
        sampler: z.string().optional(),
        seed: z.number().int().optional().describe("Omit or 0 for a fresh seed per image."),
        count: z.number().int().min(1).max(8).optional().describe("How many images, default 1."),
        characters: z
          .array(
            z.object({
              prompt: z.string(),
              negative: z.string().optional(),
              x: z.number().min(0).max(1).optional(),
              y: z.number().min(0).max(1).optional(),
            }),
          )
          .optional()
          .describe(
            "V4+/V5 per-character captions, sent as-is. Give x and y (0..1 from the top-left) " +
              "to pin a character; omit both to let the model place them. See novelai_guide " +
              "topic characters.",
          ),
        imageSize: z
          .enum(["preview", "full", "none"])
          .optional()
          .describe(IMAGE_SIZE_HELP),
        previewWidth: z
          .number()
          .int()
          .min(128)
          .max(2048)
          .optional()
          .describe(
            `Width of the inlined preview in pixels. Default ${defaultPreviewWidth()}. ` +
              "Smaller costs proportionally fewer tokens for every turn it stays in history.",
          ),
        returnImage: z
          .boolean()
          .optional()
          .describe("Also return the PNG inline. Off by default — a full-size PNG is megabytes of base64."),
        project: z
          .string()
          .optional()
          .describe(
            "File the images under this library project (created if new). Every image is " +
              "recorded in the library either way; see novelai_library_search.",
          ),
        tags: z.array(z.string()).optional().describe("Library tags for the images."),
      },
    },
    async (args) => {
      // Checked before generating: a bad name must not cost a generation.
      let filing: { project: string | null; tags: string[] }
      try {
        filing = {
          project: args.project == null ? null : cleanName(args.project, "项目名"),
          tags: cleanTags(args.tags),
        }
      } catch (error) {
        return textResult(errorText(error), true)
      }
      const fitted = fitSize(
        args.width ?? DEFAULT_PARAMS.width,
        args.height ?? DEFAULT_PARAMS.height,
      )
      const params: GenerateParams = {
        ...DEFAULT_PARAMS,
        model: args.model ?? DEFAULT_PARAMS.model,
        stylePrompt: "",
        characterPrompt: "",
        prompt: args.prompt,
        negative: args.negative ?? "",
        width: fitted.width,
        height: fitted.height,
        steps: args.steps ?? DEFAULT_PARAMS.steps,
        guidance: args.guidance ?? DEFAULT_PARAMS.guidance,
        sampler: args.sampler ?? DEFAULT_PARAMS.sampler,
        seed: args.seed ?? 0,
        batch: args.count ?? 1,
        verbatim: true,
        characters: (args.characters ?? []).map((character) => ({
          prompt: character.prompt,
          negative: character.negative ?? "",
          useCoords: character.x != null || character.y != null,
          x: character.x ?? 0.5,
          y: character.y ?? 0.5,
        })),
      }

      if (!params.prompt.trim()) {
        return { isError: true, content: [{ type: "text", text: "提示词不能为空。" }] }
      }
      if (params.characters.length > 0 && maxCharacterPrompts(params.model) === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `${modelLabel(params.model)} 不支持人物 prompt，请换 V4 及以上的模型。`,
            },
          ],
        }
      }

      const batch = await generateAndFile(params, args.count ?? 1, { ...filing, shotId: null })
      if (batch.failure) return textResult(batch.failure, true)
      const { results, lastPng, lastPath } = batch

      // Reported from the leases rather than from estimateAnlas(params) alone:
      // without an account that helper cannot know about the Opus free tier, so
      // it used to quote a price for images that in fact cost nothing.
      const spent = results.reduce((sum, r) => sum + r.cost, 0)
      const servedBy = Array.from(new Set(results.map((r) => r.account)))
      // Transparency is asked for in the prompt, so it can quietly not happen.
      // Measured from the pixels for every image: V5 sends RGBA either way, so
      // the presence of an alpha channel says nothing.
      const clearShares = results
        .map((r) => (r.clear == null ? "无法解析" : `${Math.round(r.clear * 100)}%`))
        .join(", ")
      const summary = [
        `${results.length} 张 · ${modelLabel(params.model)} · ${params.width}×${params.height} · ${params.steps} 步`,
        `seed: ${results.map((r) => r.seed).join(", ")}`,
        spent === 0
          ? `扣费: 0（走 Opus 免费额度）· 账户: ${servedBy.join("、")}`
          : `扣费: ${spent} Anlas · 账户: ${servedBy.join("、")}`,
        `透明像素占比: ${clearShares}`,
        results.every((r) => typeof r.filed === "number")
          ? `入库: ${results.map((r) => "#" + r.filed).join(", ")}` +
            (filing.project ? ` · 项目「${filing.project}」` : " · 未归项目") +
            (filing.tags.length ? ` · 标签 ${filing.tags.join("、")}` : "")
          : "入库失败: " +
            results.map((r) => (typeof r.filed === "number" ? "#" + r.filed : r.filed)).join("; "),
        "",
        ...results.map((r) => {
          const url = publicUrl(r.path, r.remote)
          return url ?? r.path
        }),
      ].join("\n")

      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] =
        [{ type: "text", text: summary }]
      const wantsImage =
        args.imageSize === "none"
          ? false
          : args.imageSize != null || (args.returnImage ?? inlineByDefault())
      if (wantsImage) {
        const inline = inlineImage(
          args.imageSize,
          lastPng,
          lastPath,
          args.previewWidth,
          (results[results.length - 1]?.clear ?? 0) > 0,
        )
        if (inline) content.push(inline)
      }
      sweepLocal()
      return { content }
    },
  )

  server.registerTool(
    "novelai_list_options",
    {
      title: "List NovelAI models and presets",
      description:
        "Valid values for the generation tool: models, samplers and size presets. The quality " +
        "tags and undesired-content presets are text you write into the prompt yourself; " +
        "novelai_guide topic quality lists them.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              models: MODELS.map((m) => ({
                id: m.id,
                label: m.label,
                characterPrompts: maxCharacterPrompts(m.id),
              })),
              samplers: SAMPLERS.map((s) => ({ id: s.id, label: s.label })),
              sizePresets: SIZE_PRESETS,
              defaults: {
                model: DEFAULT_PARAMS.model,
                width: DEFAULT_PARAMS.width,
                height: DEFAULT_PARAMS.height,
                steps: DEFAULT_PARAMS.steps,
                guidance: DEFAULT_PARAMS.guidance,
                sampler: DEFAULT_PARAMS.sampler,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  )

  server.registerTool(
    "novelai_account",
    {
      title: "NovelAI account pool",
      description:
        "Subscription state of every configured account: tier, Anlas, remaining Opus " +
        "allowance, and which ones are currently in cooldown. Tokens are never returned.",
      inputSchema: {},
    },
    async () => {
      try {
        await refreshAll(true)
        const accounts = status()
        if (accounts.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "没有配置任何账户。设置 NOVELAI_TOKENS（多个用逗号或换行分隔，可写成 " +
                  "label=pst-xxx），或 NOVELAI_TOKEN（单个）。",
              },
            ],
          }
        }
        const totals = {
          accounts: accounts.length,
          usable: accounts.filter((a) => a.active && a.cooldownSeconds === 0).length,
          anlas: accounts.reduce((sum, a) => sum + (a.anlas ?? 0), 0),
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ totals, accounts }, null, 2) },
          ],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "账户查询失败：" + (error instanceof Error ? error.message : String(error)),
            },
          ],
        }
      }
    },
  )

  // The prompt knowledge lives here rather than in per-purpose generation
  // tools. Those used to wrap the caller's subject in their own tags, and a
  // wrapper cannot know where the caller's prompt has to end — after `Text:`,
  // every appended tag is lettered into the image. A manual the agent reads
  // leaves the final prompt entirely in its hands.
  server.registerTool(
    "novelai_guide",
    {
      title: "NovelAI prompt manual",
      description:
        "How to write NovelAI prompts for novelai_generate_image, which sends your prompt " +
        "verbatim. Call with no topic for the index. Topics: " +
        TOPIC_NAMES.map((name) => `${name} (${TOPICS[name].summary})`).join("; ") +
        ".",
      inputSchema: {
        topic: z.enum(TOPIC_NAMES).optional().describe("Omit for the index of topics."),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: args.topic ? guideText(args.topic) : guideIndex() }],
    }),
  )

  registerLibraryTools(server)
  registerPageTool(server)
  registerStudioTools(server, { library, generate: generateAndFile, publicUrl, fontPath: pageFont })

  return server
}


/** One line per image, for listings: enough to pick an id, not the whole record. */
function describeRow(row: ImageRow): string {
  const when = row.createdAt.slice(0, 16).replace("T", " ")
  const where =
    row.stored === "archive"
      ? `已归档（仅 Mac 备份：${row.key}）`
      : row.url ?? row.key
  const prompt = row.prompt.length > 160 ? row.prompt.slice(0, 160) + "…" : row.prompt
  return [
    `#${row.id} · ${when} · ${row.project ? "项目「" + row.project + "」" : "未归项目"}` +
      (row.tags.length ? ` · 标签 ${row.tags.join("、")}` : "") +
      ` · ${row.width}×${row.height} · seed ${row.seed}` +
      (row.characters.length ? ` · ${row.characters.length} 个角色` : "") +
      (row.transparent ? ` · 透明 ${Math.round(row.transparent * 100)}%` : "") +
      (row.note ? ` · 备注: ${row.note}` : ""),
    `  ${where}`,
    `  ${prompt}`,
  ].join("\n")
}

/**
 * The arguments that reproduce an image through novelai_generate_image.
 *
 * Same seed, same prompt, same size: NovelAI is deterministic for those, so a
 * caller can regenerate exactly, or change one thing and keep the rest.
 */
function regenerateArgs(row: ImageRow): Record<string, unknown> {
  const args: Record<string, unknown> = { prompt: row.prompt }
  if (row.negative) args.negative = row.negative
  if (row.model) args.model = row.model
  if (row.width) args.width = row.width
  if (row.height) args.height = row.height
  if (row.steps) args.steps = row.steps
  if (row.guidance != null) args.guidance = row.guidance
  if (row.sampler) args.sampler = row.sampler
  if (row.seed) args.seed = row.seed
  if (row.characters.length) {
    args.characters = row.characters.map((c) => ({
      prompt: c.prompt,
      ...(c.negative ? { negative: c.negative } : {}),
      ...(c.x != null && c.y != null ? { x: c.x, y: c.y } : {}),
    }))
  }
  return args
}

function registerLibraryTools(server: McpServer) {
  const ids = z.array(z.number().int().positive()).min(1).max(100)

  server.registerTool(
    "novelai_library_search",
    {
      title: "Search the image library",
      description:
        "Find images in the library, newest first. All filters combine with AND. Each hit shows " +
        "its id, date, project, tags, size, seed, link and the start of its prompt; call " +
        "novelai_library_get with ids for the full record. Images marked archived have no public " +
        "link any more — they exist only in the owner's Mac backup, under the path shown.",
      inputSchema: {
        project: z.string().optional().describe("Only this project."),
        unfiled: z.boolean().optional().describe("Only images in no project."),
        tags: z.array(z.string()).optional().describe("Images carrying every one of these tags."),
        text: z
          .string()
          .optional()
          .describe("Substring of the prompt, a character caption, the note or the file name."),
        model: z.string().optional().describe("Model id, e.g. nai-diffusion-5-full."),
        stored: z
          .enum(["r2", "local", "archive"])
          .optional()
          .describe("r2 = has a public link; archive = only in the Mac backup."),
        since: z.string().optional().describe("ISO date, inclusive, e.g. 2026-10-01."),
        until: z.string().optional().describe("ISO date, exclusive."),
        oldestFirst: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args) => {
      try {
        const { total, rows } = library().search(args)
        const from = (args.offset ?? 0) + 1
        const head =
          total === 0
            ? "没有符合条件的图片。"
            : `共 ${total} 张，显示第 ${from}–${from + rows.length - 1} 张`
        return textResult([head, "", ...rows.map(describeRow)].join("\n"))
      } catch (error) {
        return textResult(errorText(error), true)
      }
    },
  )

  server.registerTool(
    "novelai_library_get",
    {
      title: "Full library records",
      description:
        "The complete record for each id: prompt, negative, character captions with positions, " +
        "model, size, steps, guidance, sampler, seed, project, tags, note and link — plus " +
        "`regenerate`, the exact novelai_generate_image arguments that reproduce the image. " +
        "Change one field of it to make a variation that keeps everything else.",
      inputSchema: { ids: ids.max(20) },
    },
    async (args) => {
      try {
        const rows = library().get(args.ids)
        return textResult(
          JSON.stringify(
            rows.map((row) => ({ ...row, regenerate: regenerateArgs(row) })),
            null,
            2,
          ),
        )
      } catch (error) {
        return textResult(errorText(error), true)
      }
    },
  )

  server.registerTool(
    "novelai_library_update",
    {
      title: "File and tag library images",
      description:
        "Move images into a project (created if new) or out of any project, add or remove tags, " +
        "or set a note. Applies to every id given, all or nothing. Images are never deleted " +
        "through this server.",
      inputSchema: {
        ids,
        project: z
          .string()
          .nullable()
          .optional()
          .describe("Project to file them under; null takes them out of any project."),
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
        note: z.string().optional().describe("Replaces the note; empty string clears it."),
      },
    },
    async (args) => {
      if (
        args.project === undefined &&
        !args.addTags?.length &&
        !args.removeTags?.length &&
        args.note === undefined
      ) {
        return textResult("没有要改的内容：给 project、addTags、removeTags 或 note 至少一项。", true)
      }
      try {
        const rows = library().update(args.ids, args)
        return textResult(`已更新 ${rows.length} 张：\n\n` + rows.map(describeRow).join("\n"))
      } catch (error) {
        return textResult(errorText(error), true)
      }
    },
  )
}

/**
 * The font the page composer renders with. NOVELAI_PAGE_FONT overrides it;
 * by default it is mcp/fonts/, next to dist/, where fetch-font.sh puts it.
 */
function pageFont(): string {
  return (
    process.env.NOVELAI_PAGE_FONT?.trim() ||
    fileURLToPath(new URL("../fonts/NotoSansSC-DemiLight.otf", import.meta.url))
  )
}

function registerPageTool(server: McpServer) {
  server.registerTool(
    "novelai_compose_page",
    {
      title: "Compose a picture-and-text novel page",
      description:
        "Lay out one novel page: the picture on the left at its own size, the original text " +
        "set on the right in a restrained sans-serif (Noto Sans SC DemiLight, a light 黑体), " +
        "white on black by default. Made for reading on a phone or tablet: the page stays narrow " +
        "and the text fills it. The column is never wider than the picture and holds 14–30 " +
        "characters a line; within that the largest type that fits wins, in the narrowest " +
        "column that holds it, so short text is set large. Line spacing tightens only at the " +
        "smallest size. Text that still does not fit " +
        "is refused with an estimate of how many characters would, so split it across pages; " +
        "nothing is ever cut off. Chinese line-breaking rules apply (no comma or closing quote " +
        "at a line start, no opening bracket at a line end, no single-character last line). " +
        "Each line of the text is a paragraph with a two-character indent. Returns the link " +
        "to the PNG and the layout it chose.",
      inputSchema: {
        imageUrl: z.string().describe("Public http(s) link to the left-hand picture, e.g. a generated image's URL."),
        text: z.string().max(5000).describe("The original text for the right-hand side. One paragraph per line."),
        background: z.string().optional().describe("Page colour, #rgb or #rrggbb. Default #000000."),
        textColor: z.string().optional().describe("Text colour, #rgb or #rrggbb. Default #ffffff."),
        title: z.string().optional().describe("Small header above the text, e.g. the book title."),
        pageNumber: z.string().optional().describe("Shown centred under the text as — 3 —."),
        continued: z
          .boolean()
          .optional()
          .describe("The first paragraph continues from the previous page: no indent on it."),
        indent: z.boolean().optional().describe("Two-character paragraph indent. Default true."),
        imageSize: z.enum(["preview", "full", "none"]).optional().describe(IMAGE_SIZE_HELP),
        previewWidth: z
          .number()
          .int()
          .min(128)
          .max(2048)
          .optional()
          .describe(`Width of the inlined preview in pixels. Default ${defaultPreviewWidth()}.`),
      },
    },
    async (args) => {
      let page
      try {
        checkPageOptions(args, pageFont())
        const image = await fetchImage(args.imageUrl)
        page = await composePage(image, args, pageFont())
      } catch (error) {
        return textResult(errorText(error), true)
      }
      const path = join(outputDir(), `page_${stamp()}_${randomBytes(8).toString("hex")}.png`)
      writeFileSync(path, page.png)
      const config = r2Config()
      // Kept apart from nai/: those are NovelAI renders the library backfills
      // from their embedded metadata, and a composed page has none.
      const remote = config
        ? await uploadToR2(config, path, page.png, config.prefix.replace(/\/?$/, "") + "-pages/")
        : null
      const fit = page.fit
      const notes = [
        fit.columnScale > 1 ? `图太窄，文字栏按每行 14 字放到图宽的 ${fit.columnScale} 倍` : "",
        fit.lineHeight < 1.9 ? `行距收紧到 ${fit.lineHeight}` : "",
      ].filter(Boolean)
      const summary = [
        `左图右文 · ${page.width}×${page.height} · ${page.characters} 字 · ${fit.lines} 行`,
        `字号 ${fit.fontSize}px · 行距 ${fit.lineHeight} · 文字栏 ${fit.columnWidth}px` +
          `（每行约 ${Math.round((fit.columnWidth - 2 * fit.marginX) / fit.fontSize)} 字）` +
          (notes.length ? `（${notes.join("，")}）` : ""),
        "",
        publicUrl(path, remote) ?? path,
      ].join("\n")
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] =
        [{ type: "text", text: summary }]
      if (args.imageSize && args.imageSize !== "none") {
        const inline = inlineImage(args.imageSize, page.png, path, args.previewWidth)
        if (inline) content.push(inline)
      }
      sweepLocal()
      return { content }
    },
  )
}
