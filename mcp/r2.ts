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
): Promise<string | null> {
  const key = config.prefix + basename(localPath)
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
