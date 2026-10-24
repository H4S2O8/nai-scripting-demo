/**
 * Nightly copy of the image library to a private R2 bucket.
 *
 *   set -a; . /etc/novelai-mcp.env; node dist/backup.mjs
 *
 * The database is the one thing here that cannot be rebuilt: the pixels are in
 * R2 and the Mac backup, but projects, tags and notes exist only in it.
 *
 * NOT the image bucket. That one is served publicly through a custom domain,
 * and the library holds every prompt ever written. Backups need their own
 * bucket and a token scoped to it:
 *
 *   R2_BACKUP_BUCKET             e.g. novelai-library-backups (no public access)
 *   R2_BACKUP_ACCESS_KEY_ID      R2 token with Object Read & Write on that bucket
 *   R2_BACKUP_SECRET_ACCESS_KEY
 *
 * Missing any of them is a hard error, never a fallback to the public bucket.
 *
 * Retention without deleting anything: one object per weekday, overwritten a
 * week later, and one per month, overwritten daily until the month ends — so
 * the last seven days plus a snapshot of every past month.
 */
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

import { Library } from "./library"
import { putObject, r2Config } from "./r2"

async function main() {
  const images = r2Config()
  const bucket = process.env.R2_BACKUP_BUCKET?.trim()
  const accessKeyId = process.env.R2_BACKUP_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_BACKUP_SECRET_ACCESS_KEY?.trim()
  if (!images || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "备份没配置：需要 R2_ACCOUNT_ID 以及 R2_BACKUP_BUCKET、R2_BACKUP_ACCESS_KEY_ID、" +
        "R2_BACKUP_SECRET_ACCESS_KEY（私有 bucket 的专用 token）",
    )
  }
  const config = { ...images, accessKeyId, secretAccessKey }

  const path =
    process.env.NOVELAI_LIBRARY_DB?.trim() ||
    join(process.env.NOVELAI_OUTPUT_DIR?.trim() || ".", "library.db")
  const library = new Library(path)
  const copy = join(tmpdir(), `library-backup-${process.pid}.db`)
  try {
    // An online backup: consistent even while the service is writing.
    await library.handle.backup(copy)
    const body = gzipSync(readFileSync(copy))
    const now = new Date()
    const weekday = now.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })
    const month = now.toISOString().slice(0, 7)
    const keys = [`library-${weekday}.db.gz`, `library-${month}.db.gz`]
    for (const key of keys) await putObject(config, bucket, key, body, "application/gzip")
    const { totals } = library.overview(0)
    console.log(
      `${now.toISOString()} 备份 ${totals.images} 条记录，${(body.length / 1024).toFixed(0)}KB → ` +
        keys.map((key) => `${bucket}/${key}`).join(", "),
    )
  } finally {
    library.close()
    rmSync(copy, { force: true })
  }
}

main().catch((error) => {
  console.error(new Date().toISOString() + " 备份失败：" + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
