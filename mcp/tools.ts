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
import { join } from "node:path"

import {
  DEFAULT_PARAMS,
  GenerateParams,
  MODELS,
  QUALITY_PRESETS,
  SAMPLERS,
  SIZE_PRESETS,
  UC_PRESETS,
  buildPayload,
  effectiveNegative,
  effectivePrompt,
  fetchAccount,
  fitSize,
  maxCharacterPrompts,
  modelLabel,
  rollSeed,
} from "../nai"
import { firstPng } from "./zip"
import { r2Config, uploadToR2 } from "./r2"
import { Lease, acquire, fail, poolSize, refreshAll, status, succeed } from "./pool"
import {
  MODES,
  Mode,
  TRANSLUCENT_TAG,
  MANGA_PALETTE,
  MangaPalette,
  VN_KINDS,
  composePrompt,
  describeMode,
  modeParams,
  pngHasAlpha,
} from "./modes"

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
  // the transparency as solid black. Those modes ask for a PNG instead and
  // pay the extra bytes.
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

  const body = Buffer.from(await response.arrayBuffer())
  if (body.length === 0) throw new Error("响应体为空")

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

  return { path, seed: actualSeed, bytes: png.length, png, remote }
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
    try {
      lease = await acquire(params)
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

export function buildServer(): McpServer {
  const server = new McpServer({ name: "novelai-image", version: "1.0.0" })

  server.registerTool(
    "novelai_generate_image",
    {
      title: "Generate a NovelAI image",
      description:
        "Generate one or more images with NovelAI and save them as PNG files. " +
        "Returns the file paths plus the seed and the Anlas cost. " +
        "Call novelai_list_options first if you need the valid model, sampler or size values.",
      inputSchema: {
        prompt: z.string().describe("Positive prompt, comma-separated Danbooru-style tags."),
        negative: z.string().optional().describe("Extra negative prompt, on top of the UC preset."),
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
        ucPreset: z.number().int().min(0).max(3).optional().describe("0 Heavy, 1 Light, 2 Human Focus, 3 None."),
        qualityPreset: z.enum(["standard", "light", "none"]).optional(),
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
            "V4+/V5 per-character captions. Give x and y to pin a character; omit both to let the model place them.",
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
      },
    },
    async (args) => {
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
        ucPreset: args.ucPreset ?? DEFAULT_PARAMS.ucPreset,
        qualityPreset: args.qualityPreset ?? DEFAULT_PARAMS.qualityPreset,
        batch: args.count ?? 1,
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

      const results: {
        path: string
        seed: number
        remote: string | null
        account: string
        free: boolean
        cost: number
      }[] = []
      let lastPng: Buffer | null = null
      let lastPath = ""
      try {
        for (let i = 0; i < (args.count ?? 1); i++) {
          const seed = params.seed > 0 ? params.seed : rollSeed()
          const made = await generateWithFailover(params, seed)
          results.push({
            path: made.path,
            seed: made.seed,
            remote: made.remote,
            account: made.account,
            free: made.free,
            cost: made.cost,
          })
          lastPng = made.png
          lastPath = made.path
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                results.length > 0
                  ? `完成 ${results.length} 张后失败：${message}\n已保存：\n` +
                    results.map((r) => r.path).join("\n")
                  : `生成失败：${message}`,
            },
          ],
        }
      }

      // Reported from the leases rather than from estimateAnlas(params) alone:
      // without an account that helper cannot know about the Opus free tier, so
      // it used to quote a price for images that in fact cost nothing.
      const spent = results.reduce((sum, r) => sum + r.cost, 0)
      const servedBy = Array.from(new Set(results.map((r) => r.account)))
      const summary = [
        `${results.length} 张 · ${modelLabel(params.model)} · ${params.width}×${params.height} · ${params.steps} 步`,
        `seed: ${results.map((r) => r.seed).join(", ")}`,
        spent === 0
          ? `扣费: 0（走 Opus 免费额度）· 账户: ${servedBy.join("、")}`
          : `扣费: ${spent} Anlas · 账户: ${servedBy.join("、")}`,
        `实际发送的提示词: ${effectivePrompt(params)}`,
        `负面: ${effectiveNegative(params) || "（无）"}`,
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
        const inline = inlineImage(args.imageSize, lastPng, lastPath, args.previewWidth)
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
        "Valid values for the generation tool: models, samplers, size presets, undesired-content presets, quality presets.",
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
              ucPresets: UC_PRESETS,
              qualityPresets: QUALITY_PRESETS,
              defaults: {
                model: DEFAULT_PARAMS.model,
                width: DEFAULT_PARAMS.width,
                height: DEFAULT_PARAMS.height,
                steps: DEFAULT_PARAMS.steps,
                guidance: DEFAULT_PARAMS.guidance,
                sampler: DEFAULT_PARAMS.sampler,
                ucPreset: DEFAULT_PARAMS.ucPreset,
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

  // One registration per mode, all sharing the implementation below. Separate
  // tools rather than a `mode` argument on the generic one: the description is
  // where the V5 standard actually reaches the caller, and a tool the model can
  // see is worth more than a parameter it has to know to set.
  for (const mode of MODES) registerMode(server, mode)

  return server
}


function registerMode(server: McpServer, mode: Mode) {
  const isVisualNovel = mode.name === "novelai_visual_novel"
  const isManga = mode.name === "novelai_manga_page"
  server.registerTool(
    mode.name,
    {
      title: mode.title,
      description: describeMode(mode),
      inputSchema: {
        subject: z
          .string()
          .describe(
            "What to draw. The mode supplies the style, the framing and the " +
              "undesired content; give the subject and the composition only.",
          ),
        ...(isVisualNovel
          ? {
              kind: z
                .enum(["sprite", "cg", "bg", "chibi", "art"])
                .describe("Which visual-novel asset. See the tool description."),
            }
          : {}),
        ...(isManga
          ? {
              palette: z
                .enum(["color", "monochrome"])
                .optional()
                .describe(
                  "Colour (default) or traditional black-and-white with screentone. " +
                    "Comic training data skews black-and-white, so colour is held by an " +
                    "explicit negative rather than by omitting 'monochrome'.",
                ),
            }
          : {}),
        translucent: z
          .boolean()
          .optional()
          .describe(
            "Add NovelAI's `alpha transparency` tag, which makes things in the scene " +
              "see-through — magic, fire, glass, umbrellas. Off by default: on a character " +
              "or item cut-out it produces a translucent subject, not a clean background.",
          ),
        negative: z.string().optional().describe("Extra negative prompt, on top of the mode's own."),
        model: z
          .string()
          .optional()
          .describe("Defaults to V5 Full. These modes assume a V5 model."),
        width: z.number().int().optional().describe("Overrides the mode's canvas."),
        height: z.number().int().optional(),
        steps: z.number().int().min(1).max(50).optional(),
        guidance: z.number().min(0).max(10).optional(),
        seed: z.number().int().optional(),
        count: z.number().int().min(1).max(8).optional(),
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
            "Per-character captions. For a manga page these are how you pin who " +
              "appears in which panel: x/y are 0..1 from the top-left.",
          ),
        imageSize: z.enum(["preview", "full", "none"]).optional().describe(IMAGE_SIZE_HELP),
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
      },
    },
    async (args: Record<string, any>) => {
      const vn = isVisualNovel ? VN_KINDS[args.kind ?? "art"] : null
      const palette = isManga
        ? MANGA_PALETTE[(args.palette ?? "color") as MangaPalette]
        : null
      const wantsAlpha = vn ? vn.alpha : mode.wantsAlpha

      const base = modeParams(mode)
      const prefixParts = [
        wantsAlpha && vn ? "2.1::transparent background::, has alpha" : "",
        vn ? vn.tag : mode.prefix,
      ]
        .filter(Boolean)
        .join(", ")
      const withTranslucent = args.translucent ? prefixParts + ", " + TRANSLUCENT_TAG : prefixParts
      const effective: Mode = vn
        ? { ...mode, prefix: withTranslucent, suffix: vn.extra, width: vn.width, height: vn.height }
        : palette
          ? { ...mode, prefix: [mode.prefix, palette.prompt].filter(Boolean).join(", ") }
          : args.translucent
            ? { ...mode, prefix: [mode.prefix, TRANSLUCENT_TAG].filter(Boolean).join(", ") }
            : mode

      const fitted = fitSize(
        args.width ?? effective.width ?? base.width,
        args.height ?? effective.height ?? base.height,
      )
      const params: GenerateParams = {
        ...base,
        model: args.model ?? DEFAULT_PARAMS.model,
        stylePrompt: "",
        characterPrompt: "",
        prompt: composePrompt(effective, args.subject ?? "", vn?.datasetPrefix ?? ""),
        negative: [mode.negative, palette?.negative ?? "", args.negative ?? ""]
          .filter(Boolean)
          .join(", "),
        width: fitted.width,
        height: fitted.height,
        steps: args.steps ?? effective.steps,
        guidance: args.guidance ?? effective.guidanceScale,
        seed: args.seed ?? 0,
        batch: args.count ?? 1,
        characters: (args.characters ?? []).map((character: any) => ({
          prompt: character.prompt,
          negative: character.negative ?? "",
          useCoords: character.x != null || character.y != null,
          x: character.x ?? 0.5,
          y: character.y ?? 0.5,
        })),
      }

      if (!(args.subject ?? "").trim()) {
        return { isError: true, content: [{ type: "text", text: "subject 不能为空。" }] }
      }

      const results: { path: string; seed: number; remote: string | null; alpha: boolean }[] = []
      let lastPng: Buffer | null = null
      let lastPath = ""
      try {
        for (let i = 0; i < (args.count ?? 1); i++) {
          const seed = params.seed > 0 ? params.seed : rollSeed()
          const made = await generateWithFailover(params, seed)
          results.push({
            path: made.path,
            seed: made.seed,
            remote: made.remote,
            alpha: pngHasAlpha(made.png),
          })
          lastPng = made.png
          lastPath = made.path
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          isError: true,
          content: [{ type: "text", text: `生成失败：${message}` }],
        }
      }

      const lines = [
        `${mode.title}${vn ? ` · ${args.kind}` : ""}${isManga ? ` · ${args.palette ?? "color"}` : ""}` +
          ` · ${results.length} 张 · ${params.width}×${params.height}`,
        `seed: ${results.map((r) => r.seed).join(", ")}`,
        `实际发送的提示词: ${effectivePrompt(params)}`,
      ]
      if (wantsAlpha) {
        // Transparency is asked for in the prompt, so it can quietly not
        // happen. Saying so beats letting the caller assume it worked.
        const withAlpha = results.filter((r) => r.alpha).length
        lines.push(
          withAlpha === results.length
            ? `透明通道: ${withAlpha}/${results.length} 张带 alpha ✔`
            : `透明通道: 只有 ${withAlpha}/${results.length} 张带 alpha —— ` +
                "提示词里的透明标签没生效。可以调高权重（如 2.4::transparent background::），" +
                "或确认提示词里没有描述背景。",
        )
      }
      lines.push("", ...results.map((r) => publicUrl(r.path, r.remote) ?? r.path))

      const content: any[] = [{ type: "text", text: lines.join("\n") }]
      const inline = inlineImage(
        args.imageSize,
        lastPng,
        lastPath,
        args.previewWidth,
        wantsAlpha && results.some((r) => r.alpha),
      )
      if (inline) content.push(inline)
      sweepLocal()
      return { content }
    },
  )
}
