/**
 * NovelAI image API client.
 *
 * The request shape (quality tags, UC presets, v4_prompt structure, the V5
 * Karras normalization, Variety+ as `skip_cfg_above_sigma`) is ported from the
 * verified payload builder in the Langbai NovelAI Studio desktop client
 * (github.com/2786886095/novelai-image-desktop, MIT), which was diffed against
 * the official web client's own requests.
 */

import { activeAccount } from "./accounts"
import { expandPrompt } from "./prompttokens"

const IMAGE_HOST = "https://image.novelai.net"
const OUTPUT_DIR = "NAI-Studio"

/* ------------------------------------------------------------------ options */

export const MODELS = [
  { id: "nai-diffusion-5-full", label: "V5 Full", note: "最新完整模型" },
  { id: "nai-diffusion-5-curated", label: "V5 Curated", note: "最新精选模型" },
  { id: "nai-diffusion-4-5-full", label: "V4.5 Full", note: "完整模型" },
  { id: "nai-diffusion-4-5-curated", label: "V4.5 Curated", note: "精选模型" },
  { id: "nai-diffusion-4-full", label: "V4 Full", note: "完整模型" },
  { id: "nai-diffusion-4-curated", label: "V4 Curated", note: "精选模型" },
  { id: "nai-diffusion-3", label: "V3", note: "旧版通用" },
  { id: "nai-diffusion-furry-3", label: "Furry V3", note: "兽人模型" },
]

export const SAMPLERS = [
  { id: "k_euler_ancestral", label: "Euler Ancestral", note: "推荐" },
  { id: "k_euler", label: "Euler", note: "" },
  { id: "k_dpmpp_2m", label: "DPM++ 2M", note: "稳定" },
  { id: "k_dpmpp_2m_sde", label: "DPM++ 2M SDE", note: "随机微分" },
  { id: "k_dpmpp_sde", label: "DPM++ SDE", note: "高质量" },
  { id: "k_dpmpp_2s_ancestral", label: "DPM++ 2S Ancestral", note: "" },
  { id: "ddim_v3", label: "DDIM", note: "快速" },
]

export const NOISE_SCHEDULES = [
  { id: "native", label: "Native" },
  { id: "karras", label: "Karras" },
  { id: "exponential", label: "Exponential" },
]

/** NovelAI's four Undesired Content presets. 3 = 不使用预设。 */
export const UC_PRESETS = [
  { id: 0, label: "Heavy", note: "强负面" },
  { id: 1, label: "Light", note: "轻负面" },
  { id: 2, label: "Human Focus", note: "人物优先" },
  { id: 3, label: "None", note: "不使用" },
]

export const QUALITY_PRESETS = [
  { id: "standard", label: "标准" },
  { id: "light", label: "轻量" },
  { id: "none", label: "关闭" },
]

/**
 * Sizes that stay inside the Opus free allowance (≤ 1 MP, with ≤ 28 steps).
 *
 * Each is the largest 64-multiple pair within 1 MP whose aspect ratio lands
 * within 3% of the target — maximising detail matters more here than hitting
 * the ratio exactly, since a pixel-perfect 19.5:9 would come out at a third of
 * the resolution.
 */
export const SIZE_PRESETS_1MP = [
  { label: "方图", width: 1024, height: 1024, note: "1:1" },
  { label: "竖图", width: 832, height: 1216, note: "2:3" },
  { label: "横图", width: 1216, height: 832, note: "3:2" },
  { label: "竖 3:4", width: 832, height: 1088, note: "3:4" },
  { label: "横 4:3", width: 1088, height: 832, note: "4:3" },
  { label: "竖 9:16", width: 768, height: 1344, note: "9:16" },
  { label: "横 16:9", width: 1344, height: 768, note: "16:9" },
  { label: "手机壁纸", width: 640, height: 1408, note: "19.5:9" },
  { label: "壁纸横屏", width: 1408, height: 640, note: "19.5:9" },
]

/** Full-size renders, up to the official 3 MP ceiling. These always cost Anlas. */
export const SIZE_PRESETS_LARGE = [
  { label: "大方图", width: 1728, height: 1728, note: "1:1" },
  { label: "大竖图", width: 1408, height: 2176, note: "2:3" },
  { label: "大横图", width: 2112, height: 1408, note: "3:2" },
  { label: "大竖 3:4", width: 1536, height: 2048, note: "3:4" },
  { label: "大竖 9:16", width: 1280, height: 2304, note: "9:16" },
  { label: "大横 16:9", width: 2304, height: 1280, note: "16:9" },
  { label: "大壁纸", width: 1216, height: 2560, note: "19.5:9" },
]

export const SIZE_PRESETS = SIZE_PRESETS_1MP.concat(SIZE_PRESETS_LARGE)

export type QualityPreset = "standard" | "light" | "none"

/**
 * One V4+/V5 character caption.
 *
 * NovelAI still requires a center for every character even when it is choosing
 * placement itself; (0.5, 0.5) is the protocol's "you decide" sentinel.
 */
export type CharacterPrompt = {
  prompt: string
  negative: string
  useCoords: boolean
  x: number
  y: number
}

export type GenerateParams = {
  model: string
  /** Art style. Kept apart because it changes on a different cadence. */
  stylePrompt: string
  /** Who is in the picture, as opposed to what they are doing. */
  characterPrompt: string
  /** Everything specific to this one image. */
  prompt: string
  negative: string
  characters: CharacterPrompt[]
  width: number
  height: number
  steps: number
  /** NovelAI calls this "Prompt Guidance"; the API field is `scale`. */
  guidance: number
  /** "Prompt Guidance Rescale" — `cfg_rescale`. */
  rescale: number
  sampler: string
  noiseSchedule: string
  /** 0 means "roll a fresh seed for every image". */
  seed: number
  ucPreset: number
  qualityPreset: QualityPreset
  smea: boolean
  smeaDyn: boolean
  variety: boolean
  transparent: boolean
  batch: number
}

export const DEFAULT_PARAMS: GenerateParams = {
  model: "nai-diffusion-5-full",
  stylePrompt: "",
  characterPrompt: "",
  prompt: "1girl, looking at viewer, upper body, soft lighting, detailed eyes",
  negative: "",
  characters: [],
  width: 832,
  height: 1216,
  steps: 28,
  guidance: 6,
  rescale: 0,
  sampler: "k_euler_ancestral",
  noiseSchedule: "karras",
  seed: 0,
  ucPreset: 2,
  qualityPreset: "standard",
  smea: false,
  smeaDyn: false,
  variety: false,
  transparent: false,
  batch: 1,
}

/* ------------------------------------------------- model capability helpers */

function baseModel(model: string): string {
  return model.endsWith("-inpainting")
    ? model.slice(0, -"-inpainting".length)
    : model
}

export function isV5(model: string): boolean {
  return baseModel(model).startsWith("nai-diffusion-5-")
}

export function isV4Plus(model: string): boolean {
  const m = baseModel(model)
  return m.startsWith("nai-diffusion-4-") || m.startsWith("nai-diffusion-5-")
}

/** SMEA / SMEA DYN only exist on the pre-V4 checkpoints. */
export function supportsSmea(model: string): boolean {
  return !isV4Plus(model)
}

/** Variety+ is implemented as a CFG sigma skip; V5 does not expose it. */
export function supportsVariety(model: string): boolean {
  return !isV5(model)
}

/** How many character captions the checkpoint accepts. 0 means no support. */
export function maxCharacterPrompts(model: string): number {
  return isV5(model) ? 32 : isV4Plus(model) ? 6 : 0
}

export function supportsNoiseSchedule(model: string): boolean {
  return !isV5(model)
}

export function supportsTransparent(model: string): boolean {
  return isV5(model)
}

/** The "轻量" quality preset is a V5-only wording in the official client. */
export function supportsLightQuality(model: string): boolean {
  return isV5(model)
}

export function modelLabel(model: string): string {
  const found = MODELS.find((m) => m.id === model)
  return found ? found.label : model
}

/* ------------------------------------------------------------- dimensions */

export const DIM_STEP = 64
export const MIN_DIM = 64
/** Official custom-size ceiling: the pair may not exceed 3 Mi pixels. */
export const MAX_PIXELS = 3145728
export const MAX_DIM = MAX_PIXELS / MIN_DIM

export function snapDimension(value: number, fallback = 1024): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return snapDimension(fallback, 1024)
  const snapped = Math.round(parsed / DIM_STEP) * DIM_STEP
  return Math.min(MAX_DIM, Math.max(MIN_DIM, snapped))
}

/** The Opus free allowance: at or below this, and ≤ 28 steps, costs nothing. */
export const OPUS_FREE_PIXELS = 1024 * 1024

/**
 * Largest 64-multiple value the other side may take without exceeding `cap`.
 *
 * Used to keep a custom size inside the free allowance: fix one side, and this
 * is what the other has to come down to.
 */
export function partnerWithin(fixed: number, cap = OPUS_FREE_PIXELS): number {
  const other = Math.max(MIN_DIM, snapDimension(fixed, MIN_DIM))
  return Math.max(MIN_DIM, Math.floor(cap / other / DIM_STEP) * DIM_STEP)
}

/** Largest legal value for one side given the other. */
export function maxDimensionFor(paired: number): number {
  const other = snapDimension(paired, MIN_DIM)
  return Math.max(MIN_DIM, Math.floor(MAX_PIXELS / other / DIM_STEP) * DIM_STEP)
}

export function fitSize(width: number, height: number) {
  const w = snapDimension(width, 832)
  const h = snapDimension(height, 1216)
  if (w * h <= MAX_PIXELS) return { width: w, height: h }
  const scale = Math.sqrt(MAX_PIXELS / (w * h))
  return {
    width: Math.max(MIN_DIM, Math.floor((w * scale) / DIM_STEP) * DIM_STEP),
    height: Math.max(MIN_DIM, Math.floor((h * scale) / DIM_STEP) * DIM_STEP),
  }
}

/* ------------------------------------------------------------ Anlas quote */

const BASE_PIXEL_COEFFICIENT = 2951823174884865e-21
const STEP_PIXEL_COEFFICIENT = 5753298233447344e-22
const OPUS_FREE_MAX_PIXELS = 1024 * 1024

export type Account = {
  active: boolean
  tier: number
  tierName: string
  anlas?: number
  /** Opus V5 allowance, in percent remaining. */
  opusPercent?: number
  expiresAt?: string
}

export function isOpus(account?: Account | null): boolean {
  return Boolean(account && account.active && account.tier >= 3)
}

export type Quote = { total: number; free: boolean; perImage: number }

/**
 * Mirrors the official frontend's price formula, including the Opus free tier
 * (≤ 1 MP and ≤ 28 steps) and the 140-Anlas per-image cap.
 */
export function estimateAnlas(
  params: GenerateParams,
  account?: Account | null,
): Quote {
  const samples = Math.max(1, Math.floor(params.batch) || 1)
  const pixels = Math.max(params.width * params.height, 65536)
  const steps = Math.max(1, Math.floor(params.steps) || 28)

  if (isOpus(account) && pixels <= OPUS_FREE_MAX_PIXELS && steps <= 28) {
    return { total: 0, free: true, perImage: 0 }
  }

  const v4Plus = isV4Plus(params.model)
  const smeaMultiplier =
    !v4Plus && params.smeaDyn ? 1.4 : !v4Plus && params.smea ? 1.2 : 1
  const official = Math.ceil(
    BASE_PIXEL_COEFFICIENT * pixels + STEP_PIXEL_COEFFICIENT * pixels * steps,
  )
  const perImage = Math.min(140, Math.max(2, Math.ceil(official * smeaMultiplier)))
  return { total: perImage * samples, free: false, perImage }
}

/* ----------------------------------------------------- prompt construction */

function switchQualityTags(model: string): string {
  switch (baseModel(model)) {
    case "nai-diffusion-5-full":
    case "nai-diffusion-5-curated":
    case "nai-diffusion-4-5-full":
      return "very aesthetic, masterpiece, no text"
    case "nai-diffusion-4-5-curated":
      return "very aesthetic, masterpiece, no text, -0.8::feet::, rating:general"
    case "nai-diffusion-4-full":
      return "no text, best quality, very aesthetic, absurdres"
    case "nai-diffusion-4-curated":
      return "rating:general, best quality, very aesthetic, absurdres"
    case "nai-diffusion-3":
      return "best quality, amazing quality, very aesthetic, absurdres"
    default:
      return ""
  }
}

function qualityTags(model: string, preset: QualityPreset, prompt: string): string {
  if (preset === "none") return ""
  let tags = preset === "light" && isV5(model)
    ? "very aesthetic, amazing quality, no text"
    : switchQualityTags(model)

  // The official quality presets contain `no text`. Keeping it next to V5's
  // explicit `Text:` directive makes the request contradict itself and
  // measurably suppresses requested lettering.
  if (/(?:^|[\s,;|])Text\s*:\s*\S/i.test(prompt)) {
    tags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => !/^no text$/i.test(tag))
      .join(", ")
  }
  return tags
}

/** The official Undesired Content preset text, per model and preset index. */
export function ucPresetText(model: string, preset: number): string {
  if (preset === 3) return ""
  const normalized = baseModel(model)
  // The V5 frontend reuses the corresponding V4.5 Full / Curated presets.
  const key =
    normalized === "nai-diffusion-5-full"
      ? "nai-diffusion-4-5-full"
      : normalized === "nai-diffusion-5-curated"
        ? "nai-diffusion-4-5-curated"
        : normalized

  if (preset === 2) {
    if (key === "nai-diffusion-4-5-full") {
      return "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy"
    }
    if (key === "nai-diffusion-4-5-curated") {
      return "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page"
    }
    if (key === "nai-diffusion-3") {
      return "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes"
    }
    return ""
  }
  if (key === "nai-diffusion-4-5-full") {
    return preset === 0
      ? "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"
      : "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page"
  }
  if (key === "nai-diffusion-4-5-curated") {
    return preset === 0
      ? "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page"
      : "blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page"
  }
  if (key === "nai-diffusion-4-full") {
    return preset === 0
      ? "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks"
      : "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing"
  }
  if (key === "nai-diffusion-4-curated") {
    return preset === 0
      ? "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts"
      : "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature"
  }
  if (key === "nai-diffusion-3") {
    return preset === 0
      ? "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]"
      : "lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing"
  }
  return ""
}

/** Join comma-separated tag segments, dropping case-insensitive duplicates. */
export function mergePrompt(...segments: string[]): string {
  const seen: Record<string, boolean> = {}
  const out: string[] = []
  for (const segment of segments) {
    for (const part of segment.split(",").map((x) => x.trim())) {
      if (!part) continue
      const key = part.toLowerCase()
      if (seen[key]) continue
      seen[key] = true
      out.push(part)
    }
  }
  return out.join(", ")
}

/**
 * The exact positive prompt that will be sent.
 *
 * The three authoring blocks are concatenated style-first — the same order the
 * official client uses for its style field — then chunk references are expanded
 * and the quality tags merged in. Expansion has to happen before mergePrompt,
 * which splits on commas and would tear a reference apart.
 */
export function effectivePrompt(params: GenerateParams): string {
  const base = mergePrompt(
    expandPrompt(params.stylePrompt.trim()),
    expandPrompt(params.characterPrompt.trim()),
    expandPrompt(params.prompt.trim()),
  )
  const withQuality = mergePrompt(
    base,
    qualityTags(params.model, params.qualityPreset, base),
  )
  return params.transparent && supportsTransparent(params.model)
    ? mergePrompt(withQuality, "transparent background")
    : withQuality
}

/** The exact negative prompt that will be sent, after the UC preset merges in. */
export function effectiveNegative(params: GenerateParams): string {
  return mergePrompt(
    expandPrompt(params.negative.trim()),
    ucPresetText(params.model, params.ucPreset),
  )
}

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
}

/** Drop empty captions and clamp coordinates before they reach the API. */
export function activeCharacters(params: GenerateParams): CharacterPrompt[] {
  const limit = maxCharacterPrompts(params.model)
  if (limit === 0) return []
  return (params.characters ?? [])
    .map((character) => ({
      prompt: expandPrompt((character.prompt ?? "").trim()),
      negative: expandPrompt((character.negative ?? "").trim()),
      useCoords: character.useCoords === true,
      x: clamp01(Number(character.x), 0.5),
      y: clamp01(Number(character.y), 0.5),
    }))
    .filter((character) => character.prompt.length > 0)
    .slice(0, limit)
}

export const MAX_SEED = 0xffffffff

export function rollSeed(): number {
  return Math.floor(Math.random() * MAX_SEED) + 1
}

export function buildPayload(params: GenerateParams, seed: number) {
  const prompt = effectivePrompt(params)
  const negative = effectiveNegative(params)
  const v5 = isV5(params.model)
  const v4Plus = isV4Plus(params.model)
  const transparent = v5 && params.transparent
  const actualSeed = Math.min(MAX_SEED, Math.max(1, Math.round(seed) || 1))
  const guidance = Math.min(10, Math.max(0, Number(params.guidance) || 0))

  // The official V5 frontend exposes no noise-schedule control and normalizes
  // every V5 request to Karras. Deriving it from the sampler instead made
  // DPM++ requests silently use Exponential and diverge from the website.
  const noiseSchedule = v5 ? "karras" : params.noiseSchedule || "native"

  const parameters: Record<string, unknown> = {
    params_version: 4,
    width: params.width,
    height: params.height,
    scale: guidance,
    sampler: params.sampler,
    steps: params.steps,
    n_samples: 1,
    seed: actualSeed,
    noise_schedule: noiseSchedule,
    uc: negative,
    negative_prompt: negative,
    ucPreset: params.ucPreset,
    uc_preset: params.ucPreset,
    cfg_rescale: params.rescale,
    legacy: false,
    legacy_v3_extend: false,
    dynamic_thresholding: v5 ? false : params.rescale > 0,
    skip_cfg_above_sigma: null,
    qualityPresetId: params.qualityPreset,
    qualityToggle: params.qualityPreset !== "none",
    quality_toggle: params.qualityPreset !== "none",
    tag_hint_qt:
      params.qualityPreset === "standard" ? 1 : params.qualityPreset === "light" ? 3 : 0,
  }

  if (v5) {
    parameters.tag_hint_transparent_background = transparent
    parameters.straight_alpha = transparent
  }

  // "Variety+" is a CFG sigma skip — NovelAI has no boolean `variety` field.
  if (params.variety && supportsVariety(params.model)) {
    parameters.skip_cfg_above_sigma = 58
  }

  if (params.sampler === "k_euler_ancestral" && noiseSchedule !== "native") {
    parameters.deliberate_euler_ancestral_bug = false
    parameters.prefer_brownian = true
  }

  if (v4Plus) {
    const characters = activeCharacters(params)
    const centersOf = (character: CharacterPrompt) => [
      { x: character.useCoords ? character.x : 0.5, y: character.useCoords ? character.y : 0.5 },
    ]
    const charCaptions = characters.map((character) => ({
      char_caption: character.prompt,
      // An empty centers array makes the endpoint return HTTP 500 even when
      // use_coords is false, so every character carries one.
      centers: centersOf(character),
    }))
    const negativeCaptions = characters.some((character) => character.negative)
      ? characters.map((character) => ({
          char_caption: character.negative,
          centers: centersOf(character),
        }))
      : []
    const useCoords = characters.some((character) => character.useCoords)

    parameters.use_coords = useCoords
    parameters.v4_prompt = {
      caption: { base_caption: prompt, char_captions: charCaptions },
      use_coords: useCoords,
      use_order: true,
    }
    parameters.v4_negative_prompt = {
      caption: { base_caption: negative, char_captions: negativeCaptions },
      use_coords: useCoords && negativeCaptions.length > 0,
      use_order: false,
      // Only reachable on V4+, where the modern structured prompt is in use.
      legacy_uc: false,
    }
  } else {
    parameters.sm = params.smea
    parameters.sm_dyn = params.smea && params.smeaDyn
  }

  return {
    action: "generate",
    input: prompt,
    model: params.model,
    parameters,
  }
}

/* ------------------------------------------------------------------ token */

/** The generation token of whichever account is active. */
export function loadToken(): string {
  return (activeAccount()?.token ?? "").trim()
}

export function looksLikeToken(token: string): boolean {
  return token.trim().startsWith("pst-")
}

/* ------------------------------------------------------------------- HTTP */

async function readError(response: Response): Promise<string> {
  const status = response.status
  const hint =
    status === 401
      ? "Token 无效或已过期，请重新签发 pst- token。"
      : status === 402
        ? "Anlas 或订阅额度不足。"
        : status === 429
          ? "请求过于频繁，稍后再试。"
          : ""
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as { message?: string }
      if (json.message) return `${status} ${json.message}${hint ? " · " + hint : ""}`
    } catch {
      /* not json */
    }
    if (text) return `${status} ${text.slice(0, 240)}${hint ? " · " + hint : ""}`
  } catch {
    /* body unreadable */
  }
  return hint ? `HTTP ${status} · ${hint}` : `HTTP ${status}`
}

function tierName(tier: number): string {
  return tier === 3
    ? "Opus"
    : tier === 2
      ? "Scroll"
      : tier === 1
        ? "Tablet"
        : tier === 0
          ? "Paper"
          : "未知"
}

function parseAccount(data: any): Account {
  // The payload has changed wrappers before: read the same subscription object
  // whether it arrives at the top level or nested under information/data.
  const sub =
    data?.subscription ??
    data?.information?.subscription ??
    data?.data?.subscription ??
    data ??
    {}
  const tier = Number(sub?.tier ?? 0)
  const steps = sub?.trainingStepsLeft
  const anlas =
    steps && typeof steps === "object"
      ? Number(steps.fixedTrainingStepsLeft ?? 0) +
        Number(steps.purchasedTrainingSteps ?? 0)
      : typeof steps === "number"
        ? steps
        : undefined
  const percent = Number(sub?.usage?.percent)
  let expiresAt: string | undefined
  const rawExpires = Number(sub?.expiresAt)
  if (Number.isFinite(rawExpires) && rawExpires > 0) {
    const seconds = rawExpires > 10000000000 ? Math.floor(rawExpires / 1000) : rawExpires
    expiresAt = new Date(seconds * 1000).toISOString().slice(0, 10)
  }
  return {
    active: typeof sub?.active === "boolean" ? sub.active : tier > 0,
    tier,
    tierName: tierName(tier),
    anlas: Number.isFinite(anlas as number) ? (anlas as number) : undefined,
    opusPercent: Number.isFinite(percent) ? percent : undefined,
    expiresAt,
  }
}

/**
 * NovelAI rejects /user/data on api.novelai.net for some accounts; the image
 * host serves the identical payload. /user/subscription is the older endpoint
 * and is kept as a fallback.
 */
export async function fetchAccount(token: string): Promise<Account> {
  const paths = ["/user/data", "/user/subscription"]
  let lastError = "账号查询失败"
  for (const path of paths) {
    try {
      const response = await fetch(IMAGE_HOST + path, {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
        timeout: 30,
        debugLabel: "NAI " + path,
      })
      if (!response.ok) {
        lastError = await readError(response)
        continue
      }
      return parseAccount(await response.json())
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
}

/* ------------------------------------------------------------------ files */

export function outputDir(): string {
  return FileManager.documentsDirectory.replace(/\/+$/, "") + "/" + OUTPUT_DIR
}

function ensureDir(path: string) {
  if (!FileManager.existsSync(path)) FileManager.createDirectorySync(path, true)
}

function looksLikeZip(data: Data): boolean {
  if (data.size < 4) return false
  const hex = data.slice(0, 2).toHexString().toLowerCase().replace(/[^0-9a-f]/g, "")
  return hex === "504b"
}

function listPngs(dir: string): string[] {
  const root = dir.replace(/\/+$/, "")
  const names = FileManager.readDirectorySync(root, true)
  const out: string[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".png")) continue
    out.push(name.startsWith("/") ? name : root + "/" + name)
  }
  return out
}

function outputPath(seed: number): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .slice(0, 15)
  return outputDir() + "/nai_" + stamp + "_" + seed + ".png"
}

/** Unzip the API response into the output directory and return the PNG path. */
async function extractPng(zipData: Data, seed: number): Promise<string> {
  const root = outputDir()
  ensureDir(root)
  const zipPath = root + "/.response.zip"
  const stageDir = root + "/.stage"
  if (FileManager.existsSync(stageDir)) FileManager.removeSync(stageDir)
  FileManager.createDirectorySync(stageDir, true)
  FileManager.writeAsDataSync(zipPath, zipData)
  await FileManager.unzip(zipPath, stageDir)

  const pngs = listPngs(stageDir)
  if (pngs.length === 0) throw new Error("响应 ZIP 里没有 PNG，接口可能返回了错误页")

  const target = outputPath(seed)
  FileManager.copyFileSync(pngs[0], target)
  FileManager.removeSync(stageDir)
  if (FileManager.existsSync(zipPath)) FileManager.removeSync(zipPath)
  return target
}

function savePngData(pngData: Data, seed: number): string {
  ensureDir(outputDir())
  const target = outputPath(seed)
  FileManager.writeAsDataSync(target, pngData)
  return target
}

/* --------------------------------------------------------------- generate */

export type GeneratedImage = {
  path: string
  seed: number
  model: string
  width: number
  height: number
  prompt: string
  createdAt: number
  /**
   * The whole request, so a result can be reproduced rather than approximated.
   *
   * The five fields above were what "reuse" restored, which left the style and
   * character blocks at whatever the session happened to hold — reusing an old
   * image mixed its prompt with the current style block and quietly produced a
   * different picture. Optional because rows written by older releases, and
   * rows rebuilt from a filename, do not have it.
   */
  params?: GenerateParams
}

/** Generate exactly one image. Batches are driven by the caller. */
export async function generateOne(
  token: string,
  params: GenerateParams,
  seed: number,
): Promise<GeneratedImage> {
  const payload = buildPayload(params, seed)
  const actualSeed = (payload.parameters as { seed: number }).seed

  const response = await fetch(IMAGE_HOST + "/ai/generate-image", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/zip, application/octet-stream",
    },
    body: JSON.stringify(payload),
    timeout: 300,
    debugLabel: "NAI generate-image",
  })
  if (!response.ok) throw new Error(await readError(response))

  const mime = (
    response.mimeType ??
    response.headers.get("content-type") ??
    ""
  ).toLowerCase()

  let path: string
  if (mime.includes("json")) {
    const json = (await response.json()) as { images?: unknown[] }
    const first = json.images?.[0]
    const b64 =
      typeof first === "string"
        ? first
        : first && typeof first === "object" && "data" in first
          ? String((first as { data: string }).data)
          : ""
    if (!b64) throw new Error("JSON 响应里没有图片数据")
    const pngData = Data.fromBase64String(b64.replace(/^data:image\/\w+;base64,/, ""))
    if (pngData == null) throw new Error("Base64 图片解码失败")
    path = savePngData(pngData, actualSeed)
  } else {
    const body = await response.data()
    if (body.size === 0) throw new Error("响应体为空")
    if (looksLikeZip(body)) {
      path = await extractPng(body, actualSeed)
    } else {
      // Some gateways hand back the raw PNG instead of a one-entry ZIP.
      const text = body.toRawString("utf-8") ?? ""
      if (text && /^\s*[{<]/.test(text)) throw new Error(text.slice(0, 240))
      path = savePngData(body, actualSeed)
    }
  }

  return {
    path,
    seed: actualSeed,
    model: params.model,
    width: params.width,
    height: params.height,
    prompt: params.prompt.trim(),
    createdAt: Date.now(),
    // The seed the server actually used, not the 0 that asked for a random
    // one: a snapshot that cannot reproduce its own image is not a snapshot.
    params: { ...params, seed: actualSeed },
  }
}

/* ------------------------------------------------------- save to Photos */

function pad2(value: number): string {
  return value < 10 ? "0" + value : String(value)
}

/** EXIF wants `YYYY:MM:DD HH:MM:SS` in local time — colons in the date half. */
function exifDateString(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/** The matching `±HH:MM` offset, so Photos does not re-interpret the time as UTC. */
function exifOffsetString(ms: number): string {
  const minutes = -new Date(ms).getTimezoneOffset()
  const sign = minutes >= 0 ? "+" : "-"
  const abs = Math.abs(minutes)
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

function baseName(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] || "nai.png"
}

/**
 * Save one result to the photo library, dated to when it was generated.
 *
 * NovelAI's PNG carries no date field, and Photos falls back to the epoch for a
 * container it cannot date — every saved image lands on 1970-01-01. So stamp
 * EXIF/TIFF dates onto a temporary copy and hand Photos that.
 *
 * The copy is what gets rewritten, never the archived original: re-encoding
 * through ImageIO is not guaranteed to carry PNG tEXt chunks across, and those
 * hold NovelAI's generation parameters. If the rewrite fails for any reason we
 * fall back to saving the original as-is — a wrong date beats no image.
 */
export async function saveToPhotos(image: GeneratedImage): Promise<boolean> {
  const name = baseName(image.path)
  const stamp = exifDateString(image.createdAt)
  const offset = exifOffsetString(image.createdAt)
  const temp = FileManager.temporaryDirectory.replace(/\/+$/, "") + "/" + name

  let source = image.path
  try {
    await ImageIO.writeImage({
      source: image.path,
      to: temp,
      metadata: {
        exif: {
          DateTimeOriginal: stamp,
          DateTimeDigitized: stamp,
          OffsetTime: offset,
          OffsetTimeOriginal: offset,
          OffsetTimeDigitized: offset,
        },
        tiff: { DateTime: stamp },
      },
    })
    if (FileManager.existsSync(temp)) source = temp
  } catch {
    /* keep the original path; the date will be wrong but the save still works */
  }

  try {
    return await Photos.savePhoto(source, { fileName: name })
  } finally {
    if (source === temp && FileManager.existsSync(temp)) {
      try {
        FileManager.removeSync(temp)
      } catch {
        /* temporary directory is cleaned by the system anyway */
      }
    }
  }
}
