/**
 * The NovelAI tools, shared by both entry points.
 *
 * The valuable part is not this file — it is `../nai.ts`, whose request builder
 * was diffed against the official client and is covered by the repo's tests.
 * This wraps that same builder so a desktop MCP client (stdio.ts) and a phone
 * over the network (http.ts) both send exactly the payload the app sends.
 *
 * Configuration is by environment:
 *   NOVELAI_TOKEN          required, the pst- persistent API token
 *   NOVELAI_OUTPUT_DIR     optional, defaults to ~/Pictures/NovelAI
 *   NOVELAI_INLINE_IMAGES  "0" to make returnImage default to off
 *   NOVELAI_PUBLIC_URL     optional, base URL that serves NOVELAI_OUTPUT_DIR
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  estimateAnlas,
  fetchAccount,
  fitSize,
  maxCharacterPrompts,
  modelLabel,
  rollSeed,
} from "../nai"
import { firstPng } from "./zip"

const IMAGE_HOST = "https://image.novelai.net"

function token(): string {
  const value = (process.env.NOVELAI_TOKEN ?? "").trim()
  if (!value) {
    throw new Error(
      "NOVELAI_TOKEN 没有设置。在 NovelAI 网页的 设置 → Account → Get Persistent API Token 取一个 pst- 开头的令牌。",
    )
  }
  return value
}

function outputDir(): string {
  const dir = process.env.NOVELAI_OUTPUT_DIR?.trim() || join(homedir(), "Pictures", "NovelAI")
  mkdirSync(dir, { recursive: true })
  return dir
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
function preview(pngPath: string, width = 512): Buffer | null {
  const out = pngPath.replace(/\.png$/, ".preview.jpg")
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", pngPath, "-vf", `scale=${width}:-2`, "-q:v", "5", out],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 },
    )
    const data = readFileSync(out)
    rmSync(out, { force: true })
    return data
  } catch {
    return null
  }
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
async function generateOne(params: GenerateParams, seed: number) {
  const payload = buildPayload(params, seed)
  const actualSeed = (payload.parameters as { seed: number }).seed

  const response = await fetch(`${IMAGE_HOST}/ai/generate-image`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token(),
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
  return { path, seed: actualSeed, bytes: png.length, png }
}

/** Inline images by default: getting the picture into the conversation is the point. */
function inlineByDefault(): boolean {
  return (process.env.NOVELAI_INLINE_IMAGES ?? "1").trim() !== "0"
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

/** Public URL for a saved file, when the server also serves the output directory. */
export function publicUrl(path: string): string | null {
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
          .describe(
            "How much image to put in the conversation. preview (default) inlines a small JPEG; " +
              "full inlines the original PNG (~2MB of base64); none inlines nothing and returns " +
              "only the link. An inlined image stays in the history and is resent every turn, so " +
              "prefer none while iterating on prompts or generating drafts the user has not asked " +
              "to look at, and preview when they want to see the result. The full-resolution file " +
              "is linked in every case.",
          ),
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

      const results: { path: string; seed: number }[] = []
      let lastPng: Buffer | null = null
    let lastPath = ""
      try {
        for (let i = 0; i < (args.count ?? 1); i++) {
          const seed = params.seed > 0 ? params.seed : rollSeed()
          const made = await generateOne(params, seed)
          results.push({ path: made.path, seed: made.seed })
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

      const quote = estimateAnlas(params)
      const summary = [
        `${results.length} 张 · ${modelLabel(params.model)} · ${params.width}×${params.height} · ${params.steps} 步`,
        `seed: ${results.map((r) => r.seed).join(", ")}`,
        `预计扣费: ${quote.total} Anlas（Opus 账户在 1 MP / 28 步以内不扣）`,
        `实际发送的提示词: ${effectivePrompt(params)}`,
        `负面: ${effectiveNegative(params) || "（无）"}`,
        "",
        ...results.map((r) => {
          const url = publicUrl(r.path)
          return url ? `${r.path}\n${url}` : r.path
        }),
      ].join("\n")

      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] =
        [{ type: "text", text: summary }]
      const wantsImage =
        args.imageSize === "none" ? false : (args.returnImage ?? inlineByDefault())
      if (wantsImage && lastPath) {
        const small =
          args.imageSize === "full"
            ? null
            : preview(lastPath, args.previewWidth ?? defaultPreviewWidth())
        if (small) {
          content.push({ type: "image", data: small.toString("base64"), mimeType: "image/jpeg" })
        } else if (lastPng) {
          // Either imageSize:"full" was asked for, or ffmpeg is unavailable.
          // Send the original rather than nothing, and accept that a slow link
          // may struggle with ~2MB of base64.
          content.push({ type: "image", data: lastPng.toString("base64"), mimeType: "image/png" })
        }
      }
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
      title: "NovelAI subscription status",
      description: "Tier, Anlas balance, and remaining Opus allowance for the configured token.",
      inputSchema: {},
    },
    async () => {
      try {
        const account = await fetchAccount(token())
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  tier: account.tierName,
                  active: account.active,
                  anlas: account.anlas ?? null,
                  opusPercentRemaining: account.opusPercent ?? null,
                  expiresAt: account.expiresAt ?? null,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : String(error) },
          ],
        }
      }
    },
  )

  return server
}
