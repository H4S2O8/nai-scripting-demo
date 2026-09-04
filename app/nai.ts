const IMAGE_HOST = "https://image.novelai.net"
const TOKEN_KEY = "nai_pst_token"

export const MODELS = [
  { id: "nai-diffusion-5-full", label: "V5 Full" },
  { id: "nai-diffusion-5-curated", label: "V5 Curated" },
  { id: "nai-diffusion-4-5-full", label: "V4.5 Full" },
] as const

export type ModelId = (typeof MODELS)[number]["id"]

export type GenerateResult = {
  pngPath: string
  seed?: number
}

export type SubscriptionInfo = {
  active: boolean
  tier: number
  anlas?: number
  usagePercent?: number
}

function isV5(model: string) {
  return model.includes("nai-diffusion-5")
}

export function loadToken(): string {
  return (Keychain.get(TOKEN_KEY) ?? "").trim()
}

export function saveToken(token: string): boolean {
  const value = token.trim()
  if (!value) {
    Keychain.remove(TOKEN_KEY)
    return true
  }
  return Keychain.set(TOKEN_KEY, value)
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  }
}

function buildBody(model: string, prompt: string, negative: string) {
  const v5 = isV5(model)
  const parameters: Record<string, unknown> = {
    params_version: v5 ? 4 : 3,
    width: 832,
    height: 1216,
    scale: v5 ? 7 : 5,
    sampler: "k_euler_ancestral",
    steps: 23,
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: true,
    negative_prompt: negative,
    noise_schedule: "karras",
    cfg_rescale: 0,
    dynamic_thresholding: false,
    v4_prompt: {
      caption: { base_caption: prompt, char_captions: [] },
      use_coords: false,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: { base_caption: negative, char_captions: [] },
      use_coords: false,
      use_order: false,
    },
  }
  if (v5) {
    parameters.deliberate_euler_ancestral_bug = false
    parameters.prefer_brownian = true
  }
  return {
    action: "generate",
    input: prompt,
    model,
    parameters,
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as { message?: string; statusCode?: number }
      if (json.message) return `${response.status} ${json.message}`
    } catch {
      /* not json */
    }
    return text ? `${response.status} ${text.slice(0, 300)}` : `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

export async function fetchSubscription(token: string): Promise<SubscriptionInfo> {
  const response = await fetch(`${IMAGE_HOST}/user/subscription`, {
    method: "GET",
    headers: { Authorization: "Bearer " + token },
    timeout: 30,
    debugLabel: "NAI subscription",
  })
  if (!response.ok) throw new Error(await readError(response))
  const json = (await response.json()) as {
    active?: boolean
    tier?: number
    trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number }
    perks?: unknown
    usage?: { percent?: number }
  }
  const fixed = json.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0
  const purchased = json.trainingStepsLeft?.purchasedTrainingSteps ?? 0
  return {
    active: Boolean(json.active),
    tier: Number(json.tier ?? 0),
    anlas: fixed + purchased,
    usagePercent: json.usage?.percent,
  }
}

function workDir(): string {
  return FileManager.documentsDirectory.replace(/\/+$/, "") + "/NAI-Demo"
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

async function saveZipAndExtract(zipData: Data): Promise<string> {
  const root = workDir()
  const zipPath = root + "/result.zip"
  const outDir = root + "/out"
  FileManager.createDirectorySync(root, true)
  if (FileManager.existsSync(outDir)) FileManager.removeSync(outDir)
  FileManager.createDirectorySync(outDir, true)
  FileManager.writeAsDataSync(zipPath, zipData)
  await FileManager.unzip(zipPath, outDir)
  const pngs = listPngs(outDir)
  if (pngs.length === 0) throw new Error("ZIP 里没有 PNG，接口可能返回了错误页")
  return pngs[0]
}

function savePngData(pngData: Data): string {
  const root = workDir()
  FileManager.createDirectorySync(root, true)
  const path = root + "/result.png"
  FileManager.writeAsDataSync(path, pngData)
  return path
}

function looksLikeZip(data: Data): boolean {
  if (data.size < 4) return false
  const hex = data.slice(0, 2).toHexString().toLowerCase().replace(/[^0-9a-f]/g, "")
  return hex === "504b"
}

export async function generateImage(
  token: string,
  model: string,
  prompt: string,
  negative: string,
): Promise<GenerateResult> {
  const body = buildBody(model, prompt.trim(), negative.trim())
  const response = await fetch(`${IMAGE_HOST}/ai/generate-image`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
    timeout: 180,
    debugLabel: "NAI generate-image",
  })
  if (!response.ok) throw new Error(await readError(response))

  const mime = (response.mimeType ?? response.headers.get("content-type") ?? "").toLowerCase()
  if (mime.includes("json")) {
    const json = (await response.json()) as { images?: unknown[] }
    const first = json.images?.[0]
    const b64 =
      typeof first === "string"
        ? first
        : first && typeof first === "object" && "data" in first
          ? String((first as { data: string }).data)
          : ""
    if (!b64) throw new Error("JSON 响应里没有图片")
    const pngData = Data.fromBase64String(b64.replace(/^data:image\/\w+;base64,/, ""))
    if (pngData == null) throw new Error("Base64 图片解码失败")
    return { pngPath: savePngData(pngData) }
  }

  const zipData = await response.data()
  if (zipData.size === 0) throw new Error("响应体为空")
  if (!looksLikeZip(zipData)) {
    const text = zipData.toRawString("utf-8") ?? ""
    throw new Error(text ? text.slice(0, 300) : "响应不是 ZIP")
  }
  const pngPath = await saveZipAndExtract(zipData)
  return { pngPath }
}
