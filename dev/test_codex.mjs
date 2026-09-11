/**
 * The codex module, against a real snapshot of the site's data when one is
 * available and against fixtures otherwise.
 *
 * The one thing that must not drift is the ?p= short code: it is a port of the
 * site's own hash, and a link copied from the site has to resolve here.
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

console.log("short code")
// Known pairs, taken from links the site itself produced.
check("a top-level category encodes to the site's code", C.encodePathCode(["基础涩涩"]) === "1vpbhbm", C.encodePathCode(["基础涩涩"]))
check("the root encodes to nothing", C.encodePathCode([]) === "")
check("blank segments are ignored", C.encodePathCode(["", " 基础涩涩 ", ""]) === "1vpbhbm")
check("a deeper path encodes differently", C.encodePathCode(["基础涩涩", "各种体位"]) !== "1vpbhbm")
check("the code is base36", /^[0-9a-z]+$/.test(C.encodePathCode(["基础涩涩", "各种体位"])))

const tree = [
  { name: "基础涩涩", count: 3, children: [
    { name: "各种体位", count: 2, children: [] },
    { name: "其他", count: 1, children: [] },
  ]},
  { name: "杂项", count: 1, children: [] },
]
check("a code resolves back to its path", JSON.stringify(C.pathFromCode(tree, "1vpbhbm")) === '["基础涩涩"]')
check("a deep code resolves", JSON.stringify(C.pathFromCode(tree, C.encodePathCode(["基础涩涩", "其他"]))) === '["基础涩涩","其他"]')
check("an unknown code resolves to the root", C.pathFromCode(tree, "zzzzzzz").length === 0)
check("an empty code resolves to the root", C.pathFromCode(tree, "").length === 0)

console.log("site links")
check("a full URL parses", JSON.stringify(C.parseSiteLink("https://novelai.quicktagcloud.com/?c=suozhang_r18&p=1vpbhbm")) === '{"codex":"suozhang_r18","code":"1vpbhbm"}')
check("just the query parses", JSON.stringify(C.parseSiteLink("?c=suozhang_r18&p=1vpbhbm")) === '{"codex":"suozhang_r18","code":"1vpbhbm"}')
check("a codex without a page parses", JSON.stringify(C.parseSiteLink("?c=suozhang_r18")) === '{"codex":"suozhang_r18","code":""}')
check("a bare code parses", JSON.stringify(C.parseSiteLink("1vpbhbm")) === '{"codex":"","code":"1vpbhbm"}')
check("garbage is rejected", C.parseSiteLink("hello world") === null)
check("empty is rejected", C.parseSiteLink("   ") === null)

console.log("tree")
check("children of the root", C.childrenAt(tree, []).length === 2)
check("children of a category", C.childrenAt(tree, ["基础涩涩"]).length === 2)
check("children of a leaf", C.childrenAt(tree, ["杂项"]).length === 0)
check("children of nowhere", C.childrenAt(tree, ["不存在"]).length === 0)
check("nodeAt finds a nested node", C.nodeAt(tree, ["基础涩涩", "其他"])?.count === 1)

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
  check("the site's code resolves in the real tree", JSON.stringify(C.pathFromCode(raw.tree, "1vpbhbm")) === '["基础涩涩"]')
  let leaves = 0
  const walk = (nodes, prefix) => {
    for (const n of nodes) {
      const p = prefix.concat(n.name)
      // Every path must round-trip through its own code.
      if (C.pathFromCode(raw.tree, C.encodePathCode(p)).join("/") !== p.join("/")) {
        failures++; console.log("  FAIL round trip " + p.join("/"))
      }
      if (n.children?.length) walk(n.children, p); else leaves++
    }
  }
  walk(raw.tree, [])
  check("every category round-trips through its code (" + leaves + " leaves)", true)
  const slimEntries = raw.entries.map((e) => ({ title: e.title ?? "", path: e.path ?? [], tags: e.tags ?? "" }))
  const drawable = C.entriesUnder(slimEntries, ["基础涩涩"])
  check("基础涩涩 has drawable entries", drawable.length > 1000, String(drawable.length))
  check("all of them have a prompt", drawable.every((e) => e.tags.trim().length > 0))
  check("all of them have a title", drawable.every((e) => e.title.trim().length > 0))
}

console.log(failures === 0 ? "\n+ all codex checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
