/**
 * Optional Cloudflare R2 storage for generated images.
 *
 * Without it, images live on the server's disk and are served by /images/.
 * That works, but the disk only ever grows and the tunnel carries every view.
 * With R2 configured, the PNG is uploaded and the returned link points at the
 * bucket instead.
 *
 * Configure all five, or none — a half-configured bucket is treated as
 * unconfigured rather than failing every generation:
 *
 *   R2_ACCOUNT_ID          Cloudflare account id
 *   R2_BUCKET              bucket name
 *   R2_ACCESS_KEY_ID       R2 API token, S3-compatible credentials
 *   R2_SECRET_ACCESS_KEY
 *   R2_PUBLIC_URL          https://pub-xxx.r2.dev or your custom domain
 *
 * Optional:
 *   R2_KEY_PREFIX          folder inside the bucket, default "nai/"
 *
 * Local copies are not deleted here. The inlined preview is rendered from the
 * local file after the upload has already happened, so deleting on upload would
 * silently cost every generation its thumbnail; tools.ts sweeps old files
 * instead.
 */
import { AwsClient } from "aws4fetch"
import { basename } from "node:path"

export type R2Config = {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  publicUrl: string
  prefix: string
}

export function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim() ?? ""
  const bucket = process.env.R2_BUCKET?.trim() ?? ""
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() ?? ""
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? ""
  const publicUrl = process.env.R2_PUBLIC_URL?.trim() ?? ""
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicUrl) {
    return null
  }
  const prefix = (process.env.R2_KEY_PREFIX ?? "nai/").replace(/^\/+/, "")
  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicUrl: publicUrl.replace(/\/+$/, ""),
    prefix: prefix && !prefix.endsWith("/") ? prefix + "/" : prefix,
  }
}

/**
 * Upload one PNG and return its public URL, or null if anything went wrong.
 *
 * Never throws: a storage problem should cost you the nicer link, not the
 * image you already paid Anlas to generate. The caller falls back to serving
 * the local copy.
 */
export async function uploadToR2(
  config: R2Config,
  localPath: string,
  bytes: Buffer,
  prefix = config.prefix,
): Promise<string | null> {
  const key = prefix + basename(localPath)
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`
  try {
    const client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    })
    const response = await client.fetch(endpoint, {
      method: "PUT",
      body: bytes,
      headers: {
        "content-type": "image/png",
        // Immutable: the random suffix in the name means a key is never reused.
        "cache-control": "public, max-age=31536000, immutable",
      },
    })
    if (!response.ok) {
      console.error(`[r2] upload failed ${response.status} ${await response.text()}`)
      return null
    }
    return `${config.publicUrl}/${key}`
  } catch (error) {
    console.error("[r2] " + (error instanceof Error ? error.message : String(error)))
    return null
  }
}

function client(config: R2Config) {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  })
}

/**
 * Upload arbitrary bytes. Unlike uploadToR2 this throws: its callers are the
 * backup script and the backfill, where a failed write has to stop the run.
 */
export async function putObject(
  config: R2Config,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${bucket}/${encodeURI(key)}`
  const response = await client(config).fetch(endpoint, {
    method: "PUT",
    body,
    headers: { "content-type": contentType, ...(cacheControl ? { "cache-control": cacheControl } : {}) },
  })
  if (!response.ok) throw new Error(`R2 写入 ${bucket}/${key} 失败：${response.status} ${await response.text()}`)
}

/** Every key under a prefix in the configured bucket. Throws on any listing error. */
export async function listKeys(config: R2Config, prefix: string): Promise<Set<string>> {
  const keys = new Set<string>()
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`
  let token = ""
  do {
    const url =
      `${base}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}` +
      (token ? "&continuation-token=" + encodeURIComponent(token) : "")
    const response = await client(config).fetch(url)
    const xml = await response.text()
    if (!response.ok) throw new Error(`R2 列表失败：${response.status} ${xml.slice(0, 200)}`)
    for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      keys.add(match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
    }
    token = (xml.match(/<NextContinuationToken>([^<]*)</) || [])[1] ?? ""
  } while (token)
  return keys
}
