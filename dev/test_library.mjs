/**
 * The image library and the backfill's PNG reader.
 *
 * The library is the one store here that cannot be rebuilt — projects, tags
 * and notes exist nowhere else — so the checks lean on what must never happen
 * quietly: a half-applied update, a duplicate record, a tag or project that
 * silently splits on case, a search that ignores a filter it was given.
 *
 *   node dev/test_library.mjs      (needs mcp/node_modules for better-sqlite3)
 */
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import zlib from "node:zlib"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
// Inside mcp/node_modules so the external better-sqlite3 resolves.
const out = join(root, "mcp", "node_modules", ".cache", "nai-tests")
mkdirSync(out, { recursive: true })

function bundle(name) {
  const dest = join(out, name.replace(/[\/.]/g, "_") + ".mjs")
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle",
     "--platform=node", "--packages=external", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const L = await import(bundle("mcp/library.ts"))
const B = await import(bundle("mcp/backfill.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}
function throws(fn, pattern) {
  try {
    fn()
    return false
  } catch (error) {
    return pattern ? pattern.test(error.message) : true
  }
}

let n = 0
function image(overrides = {}) {
  n++
  return {
    key: `nai/nai_test_${n}.png`,
    url: `https://example.test/nai/nai_test_${n}.png`,
    stored: "r2",
    createdAt: `2026-10-${String(10 + (n % 20)).padStart(2, "0")}T12:00:00.000Z`,
    model: "nai-diffusion-5-full",
    source: null,
    width: 832, height: 1216, steps: 28, guidance: 6, sampler: "k_euler_ancestral",
    seed: 1000 + n,
    prompt: `1girl, test ${n}`,
    negative: "",
    characters: [],
    transparent: 0,
    bytes: 1, account: "alt1", cost: 0,
    origin: "generate",
    ...overrides,
  }
}

console.log("recording")
const lib = new L.Library(":memory:")
const a = lib.add(image({ project: "Seven Sins", tags: ["sprite", "Lust", "sprite"] }))
check("a new image gets an id", a.created && a.id > 0)
const again = lib.add({ ...image(), key: lib.get([a.id])[0].key })
check("the same key is not recorded twice", again.created === false && again.id === a.id)
const rowA = lib.get([a.id])[0]
check("its project is filed", rowA.project === "Seven Sins")
check("repeated tags collapse", JSON.stringify(rowA.tags) === '["Lust","sprite"]', JSON.stringify(rowA.tags))
const b = lib.add(image({ project: "seven sins", tags: ["SPRITE"], prompt: "2girls, 100% cotton, Text: hi" }))
check("project names match regardless of case", lib.get([b.id])[0].project === "Seven Sins")
check("tags match regardless of case", lib.get([b.id])[0].tags[0] === "sprite")
check("an empty project name is refused", throws(() => lib.add(image({ project: "   " })), /项目名/))
check("an empty tag is refused", throws(() => lib.add(image({ tags: ["ok", " "] })), /标签/))
const c = lib.add(image({
  characters: [{ prompt: "girl, red hair, source#hugging", negative: "", x: 0.3, y: 0.6 }],
  stored: "archive", url: null, createdAt: "2026-09-01T00:00:00.000Z",
}))
check("character captions round-trip",
      lib.get([c.id])[0].characters[0].x === 0.3 && lib.get([c.id])[0].characters[0].prompt.includes("red hair"))

console.log("searching")
check("by project", lib.search({ project: "SEVEN SINS" }).total === 2)
check("an unknown project is an error, not an empty list", throws(() => lib.search({ project: "nope" }), /没有叫/))
check("unfiled", lib.search({ unfiled: true }).rows.every((r) => r.project === null))
check("project and unfiled together are refused", throws(() => lib.search({ project: "Seven Sins", unfiled: true })))
check("tags combine with AND", lib.search({ tags: ["sprite", "lust"] }).total === 1)
check("text searches the prompt", lib.search({ text: "Text: hi" }).total === 1)
check("text searches character captions", lib.search({ text: "red hair" }).rows[0]?.id === c.id)
check("% in the text is literal", lib.search({ text: "100%" }).total === 1 && lib.search({ text: "%" }).total === 1)
check("stored filter", lib.search({ stored: "archive" }).total === 1)
check("since is inclusive", lib.search({ since: "2026-09-01T00:00:00.000Z" }).rows.some((r) => r.id === c.id))
check("until is exclusive", !lib.search({ until: "2026-09-01T00:00:00.000Z" }).rows.some((r) => r.id === c.id))
{
  for (let i = 0; i < 30; i++) lib.add(image())
  const page = lib.search({ limit: 5, offset: 5 })
  check("pagination keeps the full total", page.total >= 33 && page.rows.length === 5)
  const all = lib.search({ limit: 100 }).rows
  check("newest first by default", all.every((r, i) => i === 0 || all[i - 1].createdAt >= r.createdAt))
  const oldest = lib.search({ oldestFirst: true, limit: 1 }).rows[0]
  check("oldest first on request", oldest.id === c.id)
  check("limit is capped at 100", lib.search({ limit: 1000 }).rows.length <= 100)
}

console.log("updating")
{
  const before = lib.get([a.id, b.id])
  check("an unknown id fails the whole update",
        throws(() => lib.update([a.id, 99999], { project: "Elsewhere", addTags: ["x"] }), /99999/))
  const after = lib.get([a.id, b.id])
  check("and changes nothing", JSON.stringify(before) === JSON.stringify(after))
  check("the half-made project was rolled back", !lib.overview().projects.some((p) => p.name === "Elsewhere"))
  check("adding and removing the same tag is refused",
        throws(() => lib.update([a.id], { addTags: ["x"], removeTags: ["X"] }), /既加又删/))
  const moved = lib.update([a.id, b.id], { project: "Archive Run", addTags: ["keep"], removeTags: ["sprite"], note: "picked" })
  check("files under a new project", moved.every((r) => r.project === "Archive Run"))
  check("adds and removes tags", moved.every((r) => r.tags.includes("keep") && !r.tags.includes("sprite")))
  check("sets the note", moved.every((r) => r.note === "picked"))
  check("an unused tag disappears from the overview", !lib.overview().tags.some((t) => t.name === "sprite"))
  check("null unfiles", lib.update([a.id], { project: null })[0].project === null)
}

console.log("projects")
{
  const p = lib.project("Word Combat", { description: "cyberpunk arena, 3v3" })
  check("creates with a description", p.name === "Word Combat" && p.description.includes("cyberpunk") && p.images === 0)
  check("renames", lib.project("word combat", { renameTo: "Word Combat 2" }).name === "Word Combat 2")
  check("a rename onto an existing name is refused",
        throws(() => lib.project("Word Combat 2", { renameTo: "archive run" }), /已经有/))
  const ov = lib.overview()
  check("the overview counts every image", ov.totals.images === lib.search({}).total)
  check("the overview counts archive and unfiled",
        ov.totals.archive === 1 && ov.totals.unfiled === lib.search({ unfiled: true }).total)
  check("projects carry their image counts",
        ov.projects.find((x) => x.name === "Archive Run")?.images === 1)
}

console.log("archiving")
{
  const d = lib.add(image())
  check("archive marks a key", lib.archive([lib.get([d.id])[0].key, "nai/never-existed.png"]) === 1)
  const row = lib.get([d.id])[0]
  check("an archived image loses its link", row.stored === "archive" && row.url === null)
  check("archiving twice changes nothing", lib.archive([row.key]) === 0)
}

console.log("reading NovelAI's PNG metadata")
function pngWithText(chunks) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 255, 0])
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    ...Object.entries(chunks).map(([k, v]) => chunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "utf8")]))),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
{
  const comment = {
    prompt: "2girls, rooftop, Text: 你好", uc: "lowres", seed: 42, steps: 28, scale: 5.5,
    sampler: "k_euler_ancestral", width: 1216, height: 832,
    v4_prompt: { caption: { base_caption: "2girls", char_captions: [
      { char_caption: "girl, short hair", centers: [{ x: 0.3, y: 0.6 }] },
      { char_caption: "girl, long hair", centers: [{ x: 0.7, y: 0.6 }] },
    ] }, use_coords: true },
    v4_negative_prompt: { caption: { char_captions: [{ char_caption: "hat" }, { char_caption: "" }] } },
  }
  const png = pngWithText({ Title: "AI generated image", Source: "NovelAI Diffusion V5 0ADF9AB7", Comment: JSON.stringify(comment) })
  const r = B.recordFromPng("nai_20260905_034249_42_abcd.png", png, new Date(0))
  check("the key is the R2 key", r.key === "nai/nai_20260905_034249_42_abcd.png")
  check("the time comes from the file name", r.createdAt === "2026-09-05T03:42:49.000Z", r.createdAt)
  check("prompt and negative are read", r.prompt === comment.prompt && r.negative === "lowres")
  check("UTF-8 survives", r.prompt.endsWith("你好"))
  check("parameters are read", r.seed === 42 && r.guidance === 5.5 && r.width === 1216 && r.steps === 28)
  check("captions keep their positions",
        r.characters.length === 2 && r.characters[1].x === 0.7 && r.characters[0].negative === "hat")
  check("the confirmed V5 Full hash maps to its model id", r.model === "nai-diffusion-5-full")
  check("transparency is measured", r.transparent === 0.5, String(r.transparent))
  check("a backfilled image starts as archive until the bucket says otherwise",
        r.stored === "archive" && r.url === null && r.origin === "backfill")

  const other = B.recordFromPng("x.png",
    pngWithText({ Source: "NovelAI Diffusion V4.5 4BDE2A90", Comment: JSON.stringify({ prompt: "a", seed: 1, v4_prompt: { caption: { char_captions: [{ char_caption: "boy", centers: [{ x: 0.2, y: 0.2 }] }] }, use_coords: false } }) }),
    new Date("2026-08-01T00:00:00Z"))
  check("an unconfirmed hash keeps its Source but gets no guessed model", other.model === null && other.source.includes("4BDE2A90"))
  check("unpinned captions have no position", other.characters[0].x === null)
  check("without a stamp in the name, the file time is used", other.createdAt === "2026-08-01T00:00:00.000Z")
  check("a PNG without NovelAI metadata is refused",
        throws(() => B.recordFromPng("y.png", pngWithText({ Title: "x" }), new Date()), /Comment/))
}

lib.close()
console.log(failures === 0 ? "\n+ all library checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
