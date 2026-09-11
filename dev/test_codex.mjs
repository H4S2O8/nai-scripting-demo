/**
 * The codex module, against a real snapshot of the site's data when one is
 * available and against fixtures otherwise.
 *
 *   node dev/test_codex.mjs
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naicodex-"))

const STORE = {}
globalThis.Storage = {
  get: (k) => (STORE[k] === undefined ? null : JSON.parse(JSON.stringify(STORE[k]))),
  set: (k, v) => { STORE[k] = JSON.parse(JSON.stringify(v)) },
}
const FILES = {}
globalThis.FileManager = {
  documentsDirectory: "/docs",
  existsSync: (p) => p in FILES || p.endsWith("/.codex"),
  readAsStringSync: (p) => FILES[p],
  writeAsStringSync: (p, s) => { FILES[p] = s },
  createDirectorySync: () => {},
  removeSync: (p) => { delete FILES[p] },
}

function bundle(name) {
  const dest = join(out, name.replace(/[\/.]/g, "_") + ".mjs")
  execFileSync("npx", ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle",
    "--external:scripting", "--outfile=" + dest], { stdio: ["ignore", "ignore", "inherit"] })
  return dest
}
const C = await import(bundle("codex.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else { failures++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")) }
}

const tree = [
  { name: "基础涩涩", count: 3, children: [
    { name: "各种体位", count: 2, children: [] },
    { name: "其他", count: 1, children: [] },
  ]},
  { name: "杂项", count: 1, children: [] },
]

console.log("tree")
check("children of the root", C.childrenAt(tree, []).length === 2)
check("children of a category", C.childrenAt(tree, ["基础涩涩"]).length === 2)
check("children of a leaf", C.childrenAt(tree, ["杂项"]).length === 0)
check("children of nowhere", C.childrenAt(tree, ["不存在"]).length === 0)

console.log("drawing entries")
const entries = [
  { id: "e-a", title: "a", path: ["基础涩涩", "各种体位"], tags: "1girl, x", characters: [], batches: ["2026.8.31"], identity: false },
  { id: "e-b", title: "b", path: ["基础涩涩", "各种体位"], tags: "1girl, y", characters: [], batches: [], identity: false },
  { id: "e-c", title: "c", path: ["基础涩涩", "其他"], tags: "1girl, z", characters: [], batches: ["2026.7.15", "2026.8.31"], identity: false },
  { id: "e-d", title: "d", path: ["杂项"], tags: "1girl, w", characters: [], batches: ["2026.7.15"], identity: false },
  { id: "e-empty", title: "empty", path: ["基础涩涩", "其他"], tags: "   ", characters: [], batches: [], identity: false },
  { id: "e-chars", title: "chars only", path: ["基础涩涩", "其他"], tags: "", characters: ["girl, kneeling"], batches: [], identity: false },
]
check("a parent category includes every subcategory", C.entriesUnder(entries, ["基础涩涩"]).length === 4)
check("a leaf is exact", C.entriesUnder(entries, ["基础涩涩", "各种体位"]).length === 2)
check("the root is everything", C.entriesUnder(entries, []).length === 5)
// A quarter of the codex has an empty base and everything in the characters.
check("an entry with only characters is still drawable", C.entriesUnder(entries, ["基础涩涩", "其他"]).some((e) => e.id === "e-chars"))
// The site has hundreds of entries with a title but no prompt; drawing one
// would insert an empty chunk.
check("entries with no prompt are never drawn", !C.entriesUnder(entries, ["基础涩涩", "其他"]).some((e) => e.title === "empty"))
check("a sibling is not a prefix match", C.entriesUnder(entries, ["基础"]).length === 0)
check("random picks from the list", ["a", "b"].includes(C.randomEntry(C.entriesUnder(entries, ["基础涩涩", "各种体位"])).title))
check("random from nothing is null", C.randomEntry([]) === null)

// Against the real thing, when the snapshot from research is still around.
const snapshot = "/private/tmp/claude-501/-Users-huzhecheng-Projects/463d3901-aad2-4b9f-9538-3854110fc223/scratchpad/suozhang_r18.json"
if (existsSync(snapshot)) {
  console.log("real snapshot")
  const raw = JSON.parse(readFileSync(snapshot, "utf8"))
  const slimmed = C.slim(raw, "suozhang_r18", "r-test")
  const slimEntries = slimmed.entries
  check("slim keeps every entry", slimEntries.length === raw.entries.length)
  const kotatsu = slimEntries.find((e) => e.title === "头埋在被炉下正身位")
  check("character prompts are kept, separately", kotatsu != null && kotatsu.characters.length === 2 && /head in kotatsu/.test(kotatsu.characters[0]))
  check("the base is not polluted by them", kotatsu != null && !/head in kotatsu/.test(kotatsu.tags))
  const withChars = slimEntries.filter((e) => e.characters.length).length
  check("that is a large share of the codex (" + withChars + ")", withChars > 2000)
  // The identity flag: rare, and it must be the hair/eyes kind, not body shape.
  const flagged = slimEntries.filter((e) => e.identity)
  check("identity is flagged on a small minority (" + flagged.length + ")", flagged.length > 50 && flagged.length < 600)
  const batched = slimEntries.filter((e) => e.batches.length).length
  check("update batches are kept (" + batched + " entries)", batched > 1000)
  check("the latest batch is drawable", C.inBatch(slimEntries, "2026.8.31").length > 100)
  check("most of the body predates batches", slimEntries.filter((e) => e.batches.length === 0).length > 9000)
  const listed = JSON.parse(readFileSync(join(snapshot, "..", "codexes.json"), "utf8")).find((c) => c.id === "suozhang_r18")
  if (listed) {
    check("the codex list carries the batch labels", Array.isArray(listed.updateFilters) && listed.updateFilters.length === 3)
  }
  check("a flagged entry really names hair or eyes",
        flagged.slice(0, 20).every((e) => e.characters.some((c) => /hair|eyes|ears|horn|halo|wings|twintail|ponytail|braid|bangs|elf/i.test(c))))
  check("curvy alone does not flag", !slimEntries.some((e) => e.identity && e.characters.join(" ").match(/^[^]*$/) && !e.characters.some((c) => /hair|eyes|ears|horn|halo|wings|twintail|ponytail|braid|bangs|elf|blonde/i.test(c))))
  check("every real entry has an id", slimEntries.every((e) => e.id.length > 0))
  check("real ids are unique", new Set(slimEntries.map((e) => e.id)).size === slimEntries.length)
  const drawable = C.entriesUnder(slimEntries, ["基础涩涩"])
  check("基础涩涩 has drawable entries", drawable.length > 1000, String(drawable.length))
  check("all of them have a base or characters", drawable.every((e) => e.tags.trim().length > 0 || e.characters.length > 0))
  check("all of them have a title", drawable.every((e) => e.title.trim().length > 0))
}

console.log("update batches")
{
  const all = C.entriesUnder(entries, [])
  check("no batch means no filter", C.inBatch(all, "").length === all.length)
  check("a batch narrows to its members", C.inBatch(all, "2026.8.31").map((e) => e.id).sort().join() === "e-a,e-c")
  check("an entry can be in two batches", C.inBatch(all, "2026.7.15").some((e) => e.id === "e-c"))
  check("the original body has no batch", !C.inBatch(all, "2026.7.15").some((e) => e.id === "e-b"))
  check("an unknown batch is empty", C.inBatch(all, "1999.1.1").length === 0)
  // Category first, then batch: the composition must commute with scope.
  const scoped = C.entriesUnder(entries, ["基础涩涩", "各种体位"])
  check("batch within a category", C.inBatch(scoped, "2026.8.31").map((e) => e.id).join() === "e-a")
}

console.log("artist codex snapshot")
{
  const art = "/private/tmp/claude-501/-Users-huzhecheng-Projects/463d3901-aad2-4b9f-9538-3854110fc223/scratchpad/artist_nai5.json"
  if (existsSync(art)) {
    const raw = JSON.parse(readFileSync(art, "utf8"))
    const slimmed = C.slim(raw, "artist_nai5_personal", "r-test")
    const latest = C.inBatch(slimmed.entries, "2026.9.10")
    check("the 9.10 batch is what the user pointed at (" + latest.length + ")", latest.length > 300)
    check("every artist entry is drawable", C.entriesUnder(slimmed.entries, []).length === slimmed.entries.length)
    // Contributors differ: most write "artist:name", some a bare name. Both
    // are valid NovelAI syntax, so the string is inserted as the site has it.
    const prefixed = latest.filter((e) => /^artist:/.test(e.tags)).length
    check("most artist strings carry the artist: prefix (" + prefixed + "/" + latest.length + ")", prefixed > latest.length / 2)
    check("every artist string is non-empty", latest.every((e) => e.tags.trim().length > 0))
    check("artist entries carry no characters", latest.every((e) => e.characters.length === 0))
    // Every entry in this codex is batched, unlike 所长色色.
    check("every artist entry is batched", slimmed.entries.every((e) => e.batches.length > 0))
  } else {
    console.log("  (no artist snapshot; skipped)")
  }
}

console.log("memory cache")
{
  // The disk cache path, as codex.ts builds it from the shimmed FileManager.
  const path = "/docs/NAI-Studio/.codex/memtest.json"
  const stored = (title) => JSON.stringify({ id: "memtest", title, version: "", release: "r1", schema: 4, tree: [], entries: [{ id: "1", title: "x", path: [], tags: "a", characters: [], batches: [], identity: false }] })
  FILES[path] = stored("first")
  check("a disk cache is read", C.cachedCodex("memtest")?.title === "first")
  // The point of the memory copy: reopening the picker must not re-read and
  // re-parse the file. Changing the file underneath proves the read is skipped.
  FILES[path] = stored("second")
  check("the second read comes from memory, not disk", C.cachedCodex("memtest")?.title === "first")
  C.clearCodexCache("memtest")
  check("clearing drops the memory copy too", C.cachedCodex("memtest") === null)
  check("clearing drops the disk copy", !(path in FILES))
  // A cache from an older slim shape must be treated as absent, not trusted.
  FILES[path] = JSON.stringify({ id: "memtest", release: "r1", schema: 1, tree: [], entries: [] })
  check("an old-schema cache is ignored", C.cachedCodex("memtest") === null)
  delete FILES[path]
  check("nothing cached reads as null", C.cachedCodex("nope") === null)
}

console.log("cached codex list")
{
  delete STORE["nai.codex.list.v1"]
  check("no list cached to start", C.cachedCodexList() === null)
  STORE["nai.codex.list.v1"] = [{ id: "a", name: "A", entryCount: 1, nsfw: false, updateFilters: [{ id: "2026.9.10", label: "9.10更新", latest: true }] }]
  const list = C.cachedCodexList()
  check("a stored list is served", list != null && list[0].id === "a")
  check("its batch labels survive", list[0].updateFilters.length === 1 && list[0].updateFilters[0].latest === true)
  // Once read, the list is held in memory; Storage is not consulted again.
  STORE["nai.codex.list.v1"] = [{ id: "b", name: "B", entryCount: 1, nsfw: false }]
  check("a second read comes from memory", C.cachedCodexList()[0].id === "a")
}

console.log("drawn record")
{
  delete STORE["nai.codex.drawn.cx"]
  check("nothing drawn to start", Object.keys(C.loadDrawn("cx")).length === 0)
  const pool = C.entriesUnder(entries, ["基础涩涩", "各种体位"])
  check("the whole pool is fresh", C.undrawn(pool, C.loadDrawn("cx")).length === 2)

  let drawn = C.markDrawn("cx", "e-a")
  check("a draw is remembered", drawn["e-a"] === true)
  check("it survives a reload", C.loadDrawn("cx")["e-a"] === true)
  check("it is no longer offered", C.undrawn(pool, drawn).map((e) => e.id).join() === "e-b")
  drawn = C.markDrawn("cx", "e-b")
  check("a category can run dry", C.undrawn(pool, drawn).length === 0)
  check("random from a dry pool is null", C.randomEntry(C.undrawn(pool, drawn)) === null)

  // The record is per codex.
  check("another codex is unaffected", Object.keys(C.loadDrawn("other")).length === 0)

  // Resetting one category must not forget the others.
  C.markDrawn("cx", "e-d")
  drawn = C.resetDrawn("cx", pool.map((e) => e.id))
  check("a scoped reset frees that category", C.undrawn(pool, drawn).length === 2)
  check("a scoped reset keeps other draws", drawn["e-d"] === true)
  drawn = C.resetDrawn("cx")
  check("a full reset forgets everything", Object.keys(drawn).length === 0)

  // A junk record must not throw.
  STORE["nai.codex.drawn.cx"] = { not: "an array" }
  check("a corrupt record reads as empty", Object.keys(C.loadDrawn("cx")).length === 0)
}

console.log(failures === 0 ? "\n+ all codex checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
