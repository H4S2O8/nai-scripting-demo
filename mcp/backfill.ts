/**
 * Fill the library with images generated before it existed.
 *
 * Two steps, because the pixels and the database live on different machines:
 *
 *   node dist/backfill.mjs extract <backup dir>  > records.jsonl     (on the Mac)
 *   node dist/backfill.mjs import  <records.jsonl>                    (on the server)
 *
 * `extract` reads the Mac backup of the bucket (~/Backups/r2/socialsight-previews),
 * where every image ever generated still exists, including the ones deleted from
 * R2. NovelAI wrote the full request into each PNG's `Comment` text chunk, so
 * nothing has to be guessed. It also measures transparency from the pixels.
 *
 * `import` lists the bucket, so each record is filed as `r2` (still online, with
 * its public link) or `archive` (only in the Mac backup). It is idempotent: keys
 * already in the library are left alone, which also covers images the server
 * recorded itself after the library went live. It finally marks any `r2` record
 * whose object is gone as `archive`.
 */
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline"

import { CharacterRecord, Library, NewImage } from "./library"
import { pngText, transparentFraction } from "./png"
import { listKeys, r2Config } from "./r2"

/**
 * Model ids by the hash in NovelAI's `Source` chunk.
 *
 * Only hashes confirmed against a request whose model is known: 0ADF9AB7 is
 * what every image this server generated with nai-diffusion-5-full carries.
 * Anything else keeps its raw Source text and no model id, rather than a guess.
 */
const SOURCE_MODELS: Record<string, string> = {
  "0ADF9AB7": "nai-diffusion-5-full",
}

const PREFIX = "nai/"

/** nai_20261023_050833_<seed>_<hash>.png carries its UTC generation time. */
function createdFromName(name: string): string | null {
  const m = name.match(/^nai_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null
}

function num(value: unknown): number | null {
  const n = Number(value)
  return value == null || !Number.isFinite(n) ? null : n
}

export function recordFromPng(name: string, png: Buffer, mtime: Date): NewImage {
  const text = pngText(png)
  if (!text.Comment) throw new Error("没有 NovelAI 的 Comment 元数据")
  const c = JSON.parse(text.Comment)
  const captions = c.v4_prompt?.caption?.char_captions ?? []
  const negatives = c.v4_negative_prompt?.caption?.char_captions ?? []
  const pinned = c.v4_prompt?.use_coords === true
  const characters: CharacterRecord[] = captions.map((caption: any, i: number) => ({
    prompt: String(caption.char_caption ?? ""),
    negative: String(negatives[i]?.char_caption ?? ""),
    x: pinned ? num(caption.centers?.[0]?.x) : null,
    y: pinned ? num(caption.centers?.[0]?.y) : null,
  }))
  const source = text.Source ?? null
  const hash = source?.trim().split(/\s+/).pop() ?? ""
  return {
    key: PREFIX + name,
    url: null,
    stored: "archive",
    createdAt: createdFromName(name) ?? mtime.toISOString(),
    model: SOURCE_MODELS[hash] ?? null,
    source,
    width: num(c.width),
    height: num(c.height),
    steps: num(c.steps),
    guidance: num(c.scale),
    sampler: c.sampler ?? null,
    seed: num(c.seed),
    prompt: String(c.prompt ?? ""),
    negative: String(c.uc ?? c.negative_prompt ?? ""),
    characters,
    transparent: transparentFraction(png),
    bytes: png.length,
    account: null,
    cost: null,
    origin: "backfill",
  }
}

function extract(dir: string) {
  const folder = join(dir, PREFIX)
  const names = readdirSync(folder).filter((name) => name.endsWith(".png")).sort()
  const failed: string[] = []
  let done = 0
  for (const name of names) {
    const path = join(folder, name)
    try {
      const record = recordFromPng(name, readFileSync(path), statSync(path).mtime)
      process.stdout.write(JSON.stringify(record) + "\n")
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (++done % 500 === 0) console.error(`${done}/${names.length}`)
  }
  console.error(`提取完成：${names.length - failed.length}/${names.length}`)
  for (const line of failed) console.error("失败 " + line)
  if (failed.length) process.exitCode = 1
}

async function importRecords(file: string) {
  const config = r2Config()
  if (!config) throw new Error("R2 没有配置，无法判断哪些图还在线上")
  const live = await listKeys(config, PREFIX)
  const db = new Library(process.env.NOVELAI_LIBRARY_DB?.trim() || join(process.env.NOVELAI_OUTPUT_DIR?.trim() || ".", "library.db"))
  let added = 0
  let known = 0
  let online = 0
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  const batch: NewImage[] = []
  const flush = () => {
    db.handle.transaction(() => {
      for (const record of batch) {
        const result = db.add(record)
        if (result.created) added++
        else known++
      }
    })()
    batch.length = 0
  }
  for await (const line of lines) {
    if (!line.trim()) continue
    const record = JSON.parse(line) as NewImage
    if (live.has(record.key)) {
      record.stored = "r2"
      record.url = `${config.publicUrl}/${record.key}`
      online++
    }
    batch.push(record)
    if (batch.length >= 500) flush()
  }
  flush()
  // Anything the library still thinks is online but the bucket no longer has.
  const gone = (db.handle.prepare("SELECT key FROM images WHERE stored = 'r2'").all() as { key: string }[])
    .map((row) => row.key)
    .filter((key) => !live.has(key))
  const archived = db.archive(gone)
  console.log(
    `导入：新增 ${added}，已存在 ${known}；其中仍在 R2 上 ${online}，` +
      `其余为归档。另把 ${archived} 条已从 R2 删除的记录标为归档。`,
  )
  console.log(JSON.stringify(db.overview(0).totals))
  db.close()
}

// Only as a script: the tests import recordFromPng from a bundle of this file.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
const [command, arg] = isMain ? process.argv.slice(2) : []
if (!isMain) {
  // imported, nothing to run
} else if (command === "extract" && arg) extract(arg)
else if (command === "import" && arg) {
  importRecords(arg).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
} else {
  console.error("用法: backfill.mjs extract <备份目录> > records.jsonl | backfill.mjs import <records.jsonl>")
  process.exit(2)
}
