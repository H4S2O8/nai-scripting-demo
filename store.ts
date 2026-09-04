/**
 * Persistence: generation parameters and the local result history.
 *
 * Everything lives in the script's private Storage domain; the API token is the
 * one exception and stays in the Keychain (see nai.ts).
 */
import {
  CharacterPrompt,
  DEFAULT_PARAMS,
  GenerateParams,
  GeneratedImage,
  fitSize,
} from "./nai"

const PARAMS_KEY = "nai.params.v2"
const HISTORY_KEY = "nai.history.v2"
const HISTORY_LIMIT = 40

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function toText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function normalizeCharacters(value: unknown): CharacterPrompt[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      prompt: toText(item.prompt, ""),
      negative: toText(item.negative, ""),
      useCoords: toBool(item.useCoords, false),
      x: Math.min(1, Math.max(0, toNumber(item.x, 0.5))),
      y: Math.min(1, Math.max(0, toNumber(item.y, 0.5))),
    }))
    .slice(0, 32)
}

/** Repair state restored from an older release rather than trusting it blindly. */
export function normalizeParams(raw: Partial<GenerateParams> | null): GenerateParams {
  const value = raw ?? {}
  const size = fitSize(
    toNumber(value.width, DEFAULT_PARAMS.width),
    toNumber(value.height, DEFAULT_PARAMS.height),
  )
  const quality = value.qualityPreset
  return {
    model: toText(value.model, DEFAULT_PARAMS.model),
    stylePrompt: toText(value.stylePrompt, DEFAULT_PARAMS.stylePrompt),
    characterPrompt: toText(value.characterPrompt, DEFAULT_PARAMS.characterPrompt),
    prompt: toText(value.prompt, DEFAULT_PARAMS.prompt),
    negative: toText(value.negative, DEFAULT_PARAMS.negative),
    characters: normalizeCharacters(value.characters),
    width: size.width,
    height: size.height,
    steps: Math.min(50, Math.max(1, Math.round(toNumber(value.steps, DEFAULT_PARAMS.steps)))),
    guidance: Math.min(10, Math.max(0, toNumber(value.guidance, DEFAULT_PARAMS.guidance))),
    rescale: Math.min(1, Math.max(0, toNumber(value.rescale, DEFAULT_PARAMS.rescale))),
    sampler: toText(value.sampler, DEFAULT_PARAMS.sampler),
    noiseSchedule: toText(value.noiseSchedule, DEFAULT_PARAMS.noiseSchedule),
    seed: Math.max(0, Math.round(toNumber(value.seed, DEFAULT_PARAMS.seed))),
    ucPreset: Math.min(3, Math.max(0, Math.round(toNumber(value.ucPreset, DEFAULT_PARAMS.ucPreset)))),
    qualityPreset:
      quality === "standard" || quality === "light" || quality === "none"
        ? quality
        : DEFAULT_PARAMS.qualityPreset,
    smea: toBool(value.smea, DEFAULT_PARAMS.smea),
    smeaDyn: toBool(value.smeaDyn, DEFAULT_PARAMS.smeaDyn),
    variety: toBool(value.variety, DEFAULT_PARAMS.variety),
    transparent: toBool(value.transparent, DEFAULT_PARAMS.transparent),
    batch: Math.min(8, Math.max(1, Math.round(toNumber(value.batch, DEFAULT_PARAMS.batch)))),
  }
}

export function loadParams(): GenerateParams {
  return normalizeParams(Storage.get<Partial<GenerateParams>>(PARAMS_KEY))
}

export function saveParams(params: GenerateParams): void {
  Storage.set(PARAMS_KEY, params)
}

/** History rows whose PNG has been deleted from disk are dropped on read. */
export function loadHistory(): GeneratedImage[] {
  const raw = Storage.get<GeneratedImage[]>(HISTORY_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item) => item && typeof item.path === "string" && FileManager.existsSync(item.path),
  )
}

function writeHistory(items: GeneratedImage[]): GeneratedImage[] {
  const trimmed = items.slice(0, HISTORY_LIMIT)
  Storage.set(HISTORY_KEY, trimmed)
  return trimmed
}

export function pushHistory(
  items: GeneratedImage[],
  entry: GeneratedImage,
): GeneratedImage[] {
  return writeHistory([entry, ...items])
}

export function removeHistory(
  items: GeneratedImage[],
  path: string,
): GeneratedImage[] {
  if (FileManager.existsSync(path)) {
    try {
      FileManager.removeSync(path)
    } catch {
      /* the row goes away either way */
    }
  }
  return writeHistory(items.filter((item) => item.path !== path))
}

export function clearHistory(items: GeneratedImage[]): GeneratedImage[] {
  for (const item of items) {
    if (!FileManager.existsSync(item.path)) continue
    try {
      FileManager.removeSync(item.path)
    } catch {
      /* ignore */
    }
  }
  return writeHistory([])
}
