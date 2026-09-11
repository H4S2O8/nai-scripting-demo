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
  { title: "a", path: ["基础涩涩", "各种体位"], tags: "1girl, x" },
  { title: "b", path: ["基础涩涩", "各种体位"], tags: "1girl, y" },
  { title: "c", path: ["基础涩涩", "其他"], tags: "1girl, z" },
  { title: "d", path: ["杂项"], tags: "1girl, w" },
  { title: "empty", path: ["基础涩涩", "其他"], tags: "   " },
]
check("a parent category includes every subcategory", C.entriesUnder(entries, ["基础涩涩"]).length === 3)
check("a leaf is exact", C.entriesUnder(entries, ["基础涩涩", "各种体位"]).length === 2)
check("the root is everything", C.entriesUnder(entries, []).length === 4)
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
  const slimEntries = raw.entries.map((e) => ({ title: e.title ?? "", path: e.path ?? [], tags: e.tags ?? "" }))
  const drawable = C.entriesUnder(slimEntries, ["基础涩涩"])
  check("基础涩涩 has drawable entries", drawable.length > 1000, String(drawable.length))
  check("all of them have a prompt", drawable.every((e) => e.tags.trim().length > 0))
  check("all of them have a title", drawable.every((e) => e.title.trim().length > 0))
}

console.log(failures === 0 ? "\n+ all codex checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
