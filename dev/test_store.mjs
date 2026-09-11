/**
 * History storage: parameter snapshots and their interning.
 *
 * Two things here are easy to get wrong and expensive when they are. The pool
 * must not grow without bound as 500 rows roll over, and a row written by an
 * older release must still load — a store that throws on old data bricks the
 * gallery rather than degrading.
 *
 *   node dev/test_store.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naistore-"))

/* ------------------------------------------------- Scripting global shims */
const STORE = {}
globalThis.Storage = {
  get(key) {
    // Deep-copied on the way out, so a caller mutating what it reads cannot
    // reach back into the store — which is how the real Storage behaves.
    return STORE[key] === undefined ? null : JSON.parse(JSON.stringify(STORE[key]))
  },
  set(key, value) {
    STORE[key] = JSON.parse(JSON.stringify(value))
  },
}
// Every path exists: the store drops rows whose file is gone, which would
// otherwise hide everything these checks are about.
globalThis.UUID = { string: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0
  return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
}) }
const FILES = new Set()
globalThis.FileManager = {
  existsSync: (path) => FILES.has(path) || path.endsWith("/out"),
  readDirectorySync: () => [],
  documentsDirectory: "/docs",
}

function bundle(name) {
  const dest = join(out, name.replace(/[\/.]/g, "_") + ".mjs")
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle",
     "--external:scripting", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const S = await import(bundle("store.ts"))
const N = await import(bundle("nai.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}

function params(over = {}) {
  return { ...N.DEFAULT_PARAMS, ...over }
}
let n = 0
function image(over = {}) {
  const path = "/docs/out/nai_20260905_120000_" + ++n + ".png"
  FILES.add(path)
  return {
    path,
    seed: n,
    model: N.DEFAULT_PARAMS.model,
    width: 832,
    height: 1216,
    prompt: "1girl",
    createdAt: 1000 + n,
    ...over,
  }
}

console.log("round trip")
{
  const snapshot = params({ prompt: "a knight", steps: 23, guidance: 4.5, ucPreset: 3, seed: 777 })
  let history = S.pushHistory([], image({ params: snapshot }))
  const loaded = S.loadHistory()
  check("the row comes back", loaded.length === 1)
  check("the snapshot comes back", loaded[0].params != null)
  // Reuse is only worth having if it restores the fields the old one dropped.
  check("it carries the steps", loaded[0].params.steps === 23)
  check("it carries the guidance", loaded[0].params.guidance === 4.5)
  check("it carries the UC preset", loaded[0].params.ucPreset === 3)
  check("it carries the seed", loaded[0].params.seed === 777)
  check("every field survives",
        Object.keys(snapshot).every((k) => JSON.stringify(loaded[0].params[k]) === JSON.stringify(snapshot[k])),
        Object.keys(snapshot).filter((k) => JSON.stringify(loaded[0].params[k]) !== JSON.stringify(snapshot[k])).join(","))
}

console.log("the style and character blocks")
{
  // The bug this whole change exists for: reuse used to restore `prompt` only,
  // leaving these two at whatever the session held.
  const snapshot = params({ prompt: "特定", stylePrompt: "艺术风格", characterPrompt: "人物" })
  S.pushHistory([], image({ params: snapshot }))
  const back = S.loadHistory()[0].params
  check("the style block is restored", back.stylePrompt === "艺术风格")
  check("the character block is restored", back.characterPrompt === "人物")
}

console.log("character captions")
{
  const snapshot = params({
    characters: [
      { prompt: "girl", negative: "", useCoords: true, x: 0.3, y: 0.75 },
      { prompt: "boy", negative: "bad", useCoords: false, x: 0.5, y: 0.5 },
    ],
  })
  S.pushHistory([], image({ params: snapshot }))
  const back = S.loadHistory()[0].params
  check("both captions survive", back.characters.length === 2)
  check("coordinates survive", back.characters[0].x === 0.3 && back.characters[0].y === 0.75)
  check("the coordinate flag survives", back.characters[0].useCoords === true)
}

console.log("interning")
{
  const shared = params({ prompt: "batch of eight" })
  let history = []
  // A batch shares one set of parameters; storing eight copies of it is the
  // thing interning exists to avoid.
  for (let i = 0; i < 8; i++) history = S.pushHistory(history, image({ params: shared }))
  const pool = Storage.get("nai.paramspool.v1")
  check("eight images share one snapshot", Object.keys(pool).length === 1, JSON.stringify(Object.keys(pool)))
  check("all eight still load their snapshot",
        S.loadHistory().filter((i) => i.params?.prompt === "batch of eight").length === 8)

  history = S.pushHistory(history, image({ params: params({ prompt: "different" }) }))
  check("a different snapshot gets its own entry",
        Object.keys(Storage.get("nai.paramspool.v1")).length === 2)
}

console.log("pruning")
{
  delete STORE["nai.history.v2"]
  delete STORE["nai.paramspool.v1"]
  let history = []
  for (let i = 0; i < 5; i++) {
    history = S.pushHistory(history, image({ params: params({ prompt: "p" + i }) }))
  }
  check("five distinct snapshots", Object.keys(Storage.get("nai.paramspool.v1")).length === 5)

  // Removing rows has to take their snapshots with them, or the pool grows
  // forever as the history rolls over.
  history = S.removeHistory(history, history[0].path)
  history = S.removeHistory(history, history[0].path)
  check("removing rows prunes their snapshots",
        Object.keys(Storage.get("nai.paramspool.v1")).length === 3,
        JSON.stringify(Storage.get("nai.paramspool.v1")))

  S.clearHistory(history)
  check("clearing empties the pool", Object.keys(Storage.get("nai.paramspool.v1")).length === 0)
}

console.log("the pool stays bounded as history rolls over")
{
  delete STORE["nai.history.v2"]
  delete STORE["nai.paramspool.v1"]
  let history = []
  // 600 rows past a 500 limit, each with its own settings: the pool must
  // follow the rows down, not keep every snapshot ever written.
  for (let i = 0; i < 600; i++) {
    history = S.pushHistory(history, image({ params: params({ prompt: "unique " + i }) }))
  }
  check("history is capped at 500", history.length === 500)
  check("the pool is capped with it",
        Object.keys(Storage.get("nai.paramspool.v1")).length === 500,
        String(Object.keys(Storage.get("nai.paramspool.v1")).length))
  check("the newest row kept its snapshot", history[0].params.prompt === "unique 599")
}

console.log("older releases")
{
  delete STORE["nai.paramspool.v1"]
  // Exactly what a pre-change release wrote: no paramsId, no pool.
  const legacy = image()
  delete legacy.params
  STORE["nai.history.v2"] = [legacy]
  const loaded = S.loadHistory()
  check("a row with no snapshot still loads", loaded.length === 1)
  check("it reports no snapshot", loaded[0].params === undefined)
  check("its own fields are intact", loaded[0].prompt === "1girl" && loaded[0].width === 832)
}
{
  // A dangling reference: the pool was cleared but the rows were not.
  const orphan = { ...image(), paramsId: "42" }
  STORE["nai.history.v2"] = [orphan]
  STORE["nai.paramspool.v1"] = {}
  const loaded = S.loadHistory()
  check("a dangling reference does not throw", loaded.length === 1)
  check("it degrades to no snapshot", loaded[0].params === undefined)
}
{
  // A snapshot from a release with fewer fields must be repaired, not trusted:
  // the generator reads every field.
  STORE["nai.history.v2"] = [{ ...image(), paramsId: "0" }]
  STORE["nai.paramspool.v1"] = { 0: { prompt: "half a snapshot" } }
  const back = S.loadHistory()[0].params
  check("a partial snapshot is normalized", back != null && back.prompt === "half a snapshot")
  check("missing fields are filled in", back.steps === N.DEFAULT_PARAMS.steps)
  check("missing character list becomes empty", Array.isArray(back.characters))
  check("the size is still valid", back.width % 64 === 0 && back.height % 64 === 0)
}

console.log("duplicate paths")
{
  delete STORE["nai.history.v2"]
  delete STORE["nai.paramspool.v1"]
  // What a fixed-seed batch used to write: one filename, several rows. Two
  // rows with one path are two grid cells with one key, and that is what made
  // a tap open the neighbouring image.
  const shared = "/docs/out/nai_20260905_120000_777.png"
  FILES.add(shared)
  STORE["nai.history.v2"] = [
    { path: shared, seed: 777, model: "m", width: 832, height: 1216, prompt: "second", createdAt: 2000 },
    { path: shared, seed: 777, model: "m", width: 832, height: 1216, prompt: "first", createdAt: 1000 },
    { ...image({ prompt: "other" }) },
  ]
  const loaded = S.loadHistory()
  check("duplicate paths collapse to one row", loaded.filter((i) => i.path === shared).length === 1)
  check("the newest of the duplicates wins", loaded.find((i) => i.path === shared).prompt === "second")
  check("other rows are untouched", loaded.some((i) => i.prompt === "other"))
  check("every path is unique", new Set(loaded.map((i) => i.path)).size === loaded.length)
}

console.log("generated filenames")
{
  // The whole point of the suffix: a fixed seed inside one second used to
  // produce one filename for the whole batch, so images overwrote each other.
  const names = new Set()
  for (let i = 0; i < 200; i++) names.add(N.outputPathForTest(777))
  check("a fixed seed still yields unique names", names.size === 200, String(names.size))
  const one = [...names][0].split("/").pop()
  check("the name still starts with nai_", one.startsWith("nai_"))
  // store.ts rebuilds history from filenames when the metadata is gone; the
  // suffix must not break that.
  check("the seed is still recoverable from the name",
        /^nai_\d{8}_\d{6}_777_[0-9a-f]{8}\.png$/.test(one), one)
}

console.log(failures === 0 ? "\n+ all store checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
