/**
 * V5 mode scaffolding.
 *
 * Two things here can fail silently and expensively: a prompt assembled in the
 * wrong order (NovelAI weights the front of the prompt most heavily, and the
 * dataset prefixes are documented as having to lead), and a "transparent"
 * asset that quietly comes back opaque. Both are asserted.
 *
 *   node dev/test_modes.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import zlib from "node:zlib"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naimodes-"))

function bundle(name) {
  const dest = join(out, name.replace(/[\/.]/g, "_") + ".mjs")
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle",
     "--platform=node", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const M = await import(bundle("mcp/modes.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}

console.log("the mode set")
const names = M.MODES.map((m) => m.name)
check("five modes are defined", M.MODES.length === 5, names.join(","))
check("names are unique", new Set(names).size === names.length)
check("every name is namespaced", names.every((n) => n.startsWith("novelai_")))
check("every mode has a worked shot", M.MODES.every((m) => m.shot.subject.trim().length > 30))
check("every mode has guidance", M.MODES.every((m) => m.guidance.trim().length > 50))
check("lookup by name works", M.modeByName("novelai_manga_page")?.title.includes("manga"))
check("an unknown name returns nothing", M.modeByName("nope") === undefined)

console.log("the prompt standard reaches the caller")
const std = M.V5_PROMPT_STANDARD
// These are the facts the model cannot get right by guessing.
check("documents the numeric weight syntax", /1\.4::tag::/.test(std))
check("quotes NovelAI's own transparency weight", /2\.1::transparent background::/.test(std))
check("documents the dataset prefixes", /fur dataset,/.test(std) && /background dataset,/.test(std))
check("documents the Text: directive", /Text:/.test(std))
check("documents the character cap", /32/.test(std))
check("documents the token budgets", /1471/.test(std) && /703/.test(std))
check("warns about negative space in the UC presets", /negative space/.test(std))
for (const mode of M.MODES) {
  check(`${mode.name} carries the standard`, M.describeMode(mode).includes("2.1::transparent background::"))
}

console.log("prompt composition")
{
  const mode = M.modeByName("novelai_asset_character")
  const prompt = M.composePrompt(mode, "a knight in red armour")
  // Order matters to the model, so the alpha request has to lead and the
  // subject has to precede the boilerplate.
  check("the transparency tag leads", prompt.startsWith("2.1::transparent background::"))
  check("the subject comes before the suffix", prompt.indexOf("knight") < prompt.indexOf("full body"))
  check("no doubled commas", !/,\s*,/.test(prompt))
  check("no leading or trailing comma", !/^,|,$/.test(prompt.trim()))
}
{
  const mode = M.modeByName("novelai_illustration")
  // A mode with no scaffolding must not decorate the subject with stray commas.
  check("an empty prefix leaves the subject alone", M.composePrompt(mode, "a cat") === "a cat")
  check("whitespace-only subjects collapse", M.composePrompt(mode, "   ") === "")
}
{
  const mode = M.modeByName("novelai_visual_novel")
  const prompt = M.composePrompt({ ...mode, prefix: "visual novel bg", suffix: "no humans, scenery" },
                                 "an empty classroom", "background dataset,")
  // Documented as belonging at the very start of the prompt.
  check("the dataset prefix comes first", prompt.startsWith("background dataset"))
  check("the style tag follows it", prompt.indexOf("visual novel bg") < prompt.indexOf("classroom"))
}

console.log("mode defaults")
{
  const alpha = M.MODES.filter((m) => m.wantsAlpha)
  check("two modes ask for alpha", alpha.length === 2, alpha.map((m) => m.name).join(","))
  // The UC presets contain "negative space" and "blank page" -- precisely what
  // a cut-out asset is -- so they have to be off.
  check("alpha modes disable the UC preset", alpha.every((m) => m.ucPreset === 3))
  check("alpha modes negate the background", alpha.every((m) => /background/.test(m.negative)))
  check("alpha modes negate cast shadows", alpha.every((m) => /shadow/.test(m.negative)))

  const manga = M.modeByName("novelai_manga_page")
  // Every quality preset contains "no text", which suppresses the lettering a
  // manga page is mostly made of.
  check("the manga page disables the UC preset", manga.ucPreset === 3)
  check("the manga page is portrait", manga.height > manga.width)
  check("the manga shot numbers its panels", /Panel 1/.test(manga.shot.subject))
  check("the manga shot states reading order", /right to left/i.test(manga.shot.subject))
  check("the manga shot gives every panel a position",
        ["Panel 1", "Panel 2", "Panel 3"].every((p) => manga.shot.subject.includes(p)))
  // Every community write-up says the coordinates, not the prose, are what
  // hold a page together.
  check("the manga shot pins its characters",
        manga.shot.characters.length === 2 &&
        manga.shot.characters.every((c) => c.x != null && c.y != null))
  check("the manga shot puts dialogue on the character, not the page",
        manga.shot.characters.every((c) => /Text:/.test(c.prompt)) &&
        !/Text:/.test(manga.shot.subject))
  check("captions use the singular, with no count tag",
        manga.shot.characters.every((c) => !/\d(?:girls|boys)/.test(c.prompt)))
  check("the manga guidance admits the shot is not official",
        /publishes no example/i.test(manga.guidance))

  check("every canvas is a multiple of 64",
        M.MODES.every((m) => m.width % 64 === 0 && m.height % 64 === 0))
  // Staying inside the Opus free tier is the difference between free and paid.
  check("every canvas is within 1 MP", M.MODES.every((m) => m.width * m.height <= 1024 * 1024),
        M.MODES.map((m) => `${m.name} ${m.width * m.height}`).join(" "))
  check("every mode is within 28 steps", M.MODES.every((m) => m.steps <= 28))
}

console.log("alpha detection")
function png(colorType) {
  const sig = Buffer.from("89504e470d0a1a0a", "hex")
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write("IHDR", 4)
  ihdr.writeUInt32BE(64, 8)
  ihdr.writeUInt32BE(64, 12)
  ihdr[16] = 8
  ihdr[17] = colorType
  return Buffer.concat([sig, ihdr.subarray(0, 18), Buffer.alloc(8)])
}
check("RGBA is detected", M.pngHasAlpha(png(6)) === true)
check("grey+alpha is detected", M.pngHasAlpha(png(4)) === true)
check("plain RGB is not", M.pngHasAlpha(png(2)) === false)
check("greyscale is not", M.pngHasAlpha(png(0)) === false)
check("a palette image is not", M.pngHasAlpha(png(3)) === false)
check("a JPEG is not a PNG", M.pngHasAlpha(Buffer.from("ffd8ffe000104a464946", "hex")) === false)
check("a truncated file is handled", M.pngHasAlpha(Buffer.from("89504e47", "hex")) === false)
check("an empty buffer is handled", M.pngHasAlpha(Buffer.alloc(0)) === false)
// A real PNG, so the offsets are checked against something zlib actually made.
{
  const raw = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 4)])
  const sig = Buffer.from("89504e470d0a1a0a", "hex")
  const head = Buffer.alloc(25)
  head.writeUInt32BE(13, 0); head.write("IHDR", 4)
  head.writeUInt32BE(64, 8); head.writeUInt32BE(1, 12); head[16] = 8; head[17] = 6
  const real = Buffer.concat([sig, head.subarray(0, 18), zlib.deflateSync(raw)])
  check("a real RGBA header is detected", M.pngHasAlpha(real) === true)
}

console.log("worked shots")
for (const mode of M.MODES) {
  const args = M.shotArgs(mode.shot)
  check(`${mode.name} shot renders as arguments`, typeof args.subject === "string")
  check(`${mode.name} shot explains itself`, mode.shot.note.trim().length > 30)
  check(`${mode.name} description embeds its shot`, M.describeMode(mode).includes(mode.shot.subject.slice(0, 25)))
}
{
  const vn = M.modeByName("novelai_visual_novel")
  check("the VN shot picks a kind", ["sprite", "cg", "bg", "chibi", "art"].includes(vn.shot.kind))
  const illo = M.modeByName("novelai_illustration")
  // The docs are explicit: counts live in the base prompt, singular in captions.
  check("the illustration shot puts the count tag in the subject", /2girls/.test(illo.shot.subject))
  check("its captions stay singular", illo.shot.characters.every((c) => !/2girls/.test(c.prompt)))
  check("it demonstrates the source#/target# split",
        illo.shot.characters.some((c) => /source#/.test(c.prompt)) &&
        illo.shot.characters.some((c) => /target#/.test(c.prompt)))
}

console.log("the transparency correction")
{
  const cutouts = M.MODES.filter((m) => m.wantsAlpha)
  // "alpha transparency" makes things IN THE SCENE see-through, so on a
  // character cut-out it yields a translucent character. It must be opt-in.
  check("cut-out modes do not request scene translucency",
        cutouts.every((m) => !m.prefix.includes("alpha transparency")))
  check("cut-out modes do empty the background",
        cutouts.every((m) => m.prefix.includes("transparent background")))
  check("the translucency tag is exported for opt-in use", M.TRANSLUCENT_TAG === "alpha transparency")
  check("the standard explains the three tags are different",
        /not synonyms/i.test(std) && /see-through/i.test(std))
}

console.log("the standard covers the multi-character rules")
check("count tags belong in the base prompt", /COUNT TAGS GO IN THE BASE PROMPT/.test(std))
check("documents the action prefixes", /source#/.test(std) && /target#/.test(std) && /mutual#/.test(std))
check("documents where style tags go", /near the START/.test(std))

console.log(failures === 0 ? "\n+ all mode checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
