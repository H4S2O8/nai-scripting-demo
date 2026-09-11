/**
 * Where draws land, and what they must never touch.
 *
 * Every case here is a way the user's own text could be damaged: a row
 * removed that they wrote, a chunk of theirs swapped out, a draw that
 * stacks instead of replacing.
 *
 *   node dev/test_draws.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naidraws-"))

globalThis.Storage = { get: () => null, set: () => {} }
globalThis.FileManager = { documentsDirectory: "/docs", existsSync: () => false }

function bundle(name) {
  const dest = join(out, name.replace(/[\/.]/g, "_") + ".mjs")
  execFileSync("npx", ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle",
    "--external:scripting", "--outfile=" + dest], { stdio: ["ignore", "ignore", "inherit"] })
  return dest
}
const D = await import(bundle("draws.ts"))
const P = await import(bundle("prompttokens.ts"))
const N = await import(bundle("nai.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else { failures++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")) }
}

// The marker characters, as escapes so they never appear literally here.
const MARKERS = new RegExp("[\u0001\u0002]")

const ch = (prompt, over = {}) => ({ prompt, negative: "", useCoords: false, x: 0.5, y: 0.5, ...over })
const base = () => ({ ...N.DEFAULT_PARAMS, model: "nai-diffusion-5-full", stylePrompt: "watercolor", prompt: "1girl, park",
  characters: [ch("girl, silver hair", { useCoords: true, x: 0.3, y: 0.7 })] })
const chunks = (text) => P.parsePrompt(text).filter((t) => t.kind === "chunk")
const expanded = (text) => P.expandPrompt(text)

console.log("artist")
{
  const p = D.placeArtist(base(), "kanae", "artist:kanae")
  check("lands in the style block", expanded(p.stylePrompt) === "watercolor, artist:kanae", expanded(p.stylePrompt))
  check("is readable back", D.currentArtist(p)?.title === "kanae" && D.currentArtist(p)?.base === "artist:kanae")
  check("the other blocks are untouched", p.prompt === "1girl, park" && p.characters.length === 1)
  const q = D.placeArtist(p, "ruiuncle", "artist:ruiuncle")
  check("re-drawing replaces, not stacks", chunks(q.stylePrompt).length === 1 && expanded(q.stylePrompt).includes("ruiuncle"))
  check("clearing removes it", D.currentArtist(D.clearArtist(q)) === null && D.clearArtist(q).stylePrompt.trim() === "watercolor")
  check("nothing to read from a plain block", D.currentArtist(base()) === null)
}

console.log("scene: base only")
{
  const p = D.placeScene(base(), "遛狗", "outdoor, leash", [], 32)
  check("lands in the specific block", expanded(p.prompt) === "1girl, park, outdoor, leash", expanded(p.prompt))
  check("shows its title in the row", P.summarizePrompt(p.prompt).includes("[🎲 遛狗]"))
  check("characters are untouched", p.characters.length === 1 && p.characters[0].prompt === "girl, silver hair")
  check("is readable back", D.currentScene(p)?.title === "遛狗" && D.currentScene(p)?.base === "outdoor, leash")
}

console.log("scene: characters into slots")
{
  const p = D.placeScene(base(), "被炉", "kotatsu", ["girl, head in kotatsu", "boy, pov"], 32)
  check("slot 1 gets the user's text first, then the draw",
        expanded(p.characters[0].prompt) === "girl, silver hair, girl, head in kotatsu", expanded(p.characters[0].prompt))
  check("slot 1 keeps its position", p.characters[0].useCoords === true && p.characters[0].x === 0.3)
  check("slot 2 is created for the draw", p.characters.length === 2 && expanded(p.characters[1].prompt) === "boy, pov")
  check("a created slot is not pinned", p.characters[1].useCoords === false)
  check("the draw's chunks are visible in the slots", chunks(p.characters[0].prompt).length === 1 && chunks(p.characters[1].prompt).length === 1)
  const cur = D.currentScene(p)
  check("is readable back with both characters", cur?.characters.length === 2 && cur.characters[1] === "boy, pov")

  // 换一个 from a two-person entry to a one-person one.
  const q = D.placeScene(p, "独处", "bedroom", ["girl, lying"], 32)
  check("slot 1's draw is swapped in place", expanded(q.characters[0].prompt) === "girl, silver hair, girl, lying")
  check("the slot the draw created goes away when unneeded", q.characters.length === 1)
  check("the user's slot is never removed", q.characters[0].useCoords === true)

  // Clearing takes the draw's chunks and the rows it made, nothing else.
  const c = D.clearScene(p)
  check("clear leaves the user's slot with only their text", c.characters.length === 1 && c.characters[0].prompt.trim() === "girl, silver hair")
  check("clear leaves the specific block with only their text", c.prompt.trim() === "1girl, park")
  check("nothing left to read", D.currentScene(c) === null)
}

console.log("scene: rows the user owns survive")
{
  // A user row that is empty but pinned: the draw fills it, and clearing
  // must leave the row because the pin is theirs.
  const pinned = { ...base(), characters: [ch("", { useCoords: true, x: 0.8, y: 0.2 })] }
  const p = D.placeScene(pinned, "x", "", ["girl, kneeling"], 32)
  check("an empty pinned row takes the draw", expanded(p.characters[0].prompt) === "girl, kneeling")
  const c = D.clearScene(p)
  check("clearing keeps the pinned row", c.characters.length === 1 && c.characters[0].useCoords === true)

  // A user row with only a negative.
  const neg = { ...base(), characters: [ch("", { negative: "bad hands" })] }
  const q = D.clearScene(D.placeScene(neg, "x", "", ["girl"], 32))
  check("clearing keeps a row with a negative", q.characters.length === 1 && q.characters[0].negative === "bad hands")

  // A user row that is genuinely empty and was never part of a draw.
  const empty = { ...base(), characters: [ch("girl, a"), ch("")] }
  const r = D.placeScene(empty, "x", "", ["girl, one"], 32)
  check("an untouched empty row is not removed by a draw", r.characters.length === 2)
  const s2 = D.clearScene(r)
  check("nor by clearing", s2.characters.length === 2)
}

console.log("scene: empty base with characters")
{
  const p = D.placeScene(base(), "只有角色", "", ["girl, kneeling"], 32)
  check("no chunk goes into the specific block", chunks(p.prompt).length === 0 && p.prompt === "1girl, park")
  check("the character still lands", expanded(p.characters[0].prompt).endsWith("girl, kneeling"))
  check("is readable back from the character alone", D.currentScene(p)?.title === "只有角色")
}

console.log("scene: model limits")
{
  const p = D.placeScene(base(), "x", "scene", ["a", "b", "c"], 0)
  check("with no slots only the base lands", chunks(p.prompt).length === 1 && p.characters.length === 1 && chunks(p.characters[0].prompt).length === 0)
  const q = D.placeScene(base(), "x", "scene", ["a", "b", "c"], 2)
  check("slots past the limit are not created", q.characters.length === 2)
}

console.log("the request carries the draw")
{
  const p = D.placeScene(D.placeArtist(base(), "kanae", "artist:kanae"), "被炉", "kotatsu", ["girl, head in kotatsu", "boy, pov"], 32)
  const prompt = N.effectivePrompt({ ...p, qualityPreset: "none" })
  check("artist first, then style", prompt.startsWith("watercolor, artist:kanae"), prompt)
  check("the scene base is in the prompt", prompt.includes("kotatsu"))
  check("no marker reaches the request", !MARKERS.test(prompt))
  const chars = N.activeCharacters(p)
  check("both characters are sent, expanded", chars.length === 2 && chars[0].prompt.includes("head in kotatsu") && !MARKERS.test(chars[0].prompt))
  check("the user's position is sent", chars[0].useCoords === true && chars[0].x === 0.3)
}

console.log(failures === 0 ? "\n+ all draw checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
