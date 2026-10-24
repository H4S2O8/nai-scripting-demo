/**
 * The MCP's verbatim payload and its prompt manual.
 *
 * The server used to wrap the caller's prompt in quality tags, a UC preset and
 * per-mode scaffolding. Everything after V5's `Text:` directive is lettered
 * into the image, so `... Text: OPEN` came back as a sign reading "OPEN, very
 * aesthetic, masterpiece". The first half here asserts nothing is added any
 * more; the second that the knowledge the scaffolding carried survived as
 * advice in the manual.
 *
 *   node dev/test_guide.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import zlib from "node:zlib"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naiguide-"))

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

const N = await import(bundle("nai.ts"))
const G = await import(bundle("mcp/guide.ts"))
const P = await import(bundle("mcp/png.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}

function params(overrides) {
  return { ...N.DEFAULT_PARAMS, stylePrompt: "", characterPrompt: "", ...overrides }
}

console.log("verbatim payload")
{
  // The exact prompt that used to come back lettered with the quality tags.
  const prompt = "a wooden signboard on a plain wall, close-up, Text: OPEN"
  const p = params({ prompt, negative: "", verbatim: true })
  const payload = N.buildPayload(p, 1)
  check("the prompt is sent untouched", payload.input === prompt, payload.input)
  check("the V4 base caption is untouched",
        payload.parameters.v4_prompt.caption.base_caption === prompt)
  check("nothing follows the Text: directive", payload.input.endsWith("Text: OPEN"))
  check("no UC preset is merged into an empty negative",
        payload.parameters.negative_prompt === "" &&
        payload.parameters.v4_negative_prompt.caption.base_caption === "",
        payload.parameters.negative_prompt)
  check("the metadata says no UC preset", payload.parameters.ucPreset === 3)
  check("the metadata says no quality tags",
        payload.parameters.qualityToggle === false && payload.parameters.tag_hint_qt === 0)
}
{
  // mergePrompt split on commas and dropped case-insensitive repeats, which
  // ate repeated dialogue and reflowed natural-language spacing.
  const prompt = "manga page,   Panel 1: she says no.  Text: no, no, NO"
  const payload = N.buildPayload(params({ prompt, negative: "worst quality,worst quality", verbatim: true }), 1)
  check("repeated segments are kept", payload.input === prompt, payload.input)
  check("the negative is kept as written",
        payload.parameters.negative_prompt === "worst quality,worst quality")
}
{
  const caption = "girl, speech bubble, Text: hi, hi"
  const payload = N.buildPayload(params({
    prompt: "2girls",
    verbatim: true,
    characters: [
      { prompt: caption, negative: "", useCoords: true, x: 0.3, y: 0.6 },
      { prompt: "   ", negative: "", useCoords: false, x: 0.5, y: 0.5 },
    ],
  }), 1)
  const captions = payload.parameters.v4_prompt.caption.char_captions
  check("a character caption is sent untouched", captions[0]?.char_caption === caption, captions[0]?.char_caption)
  check("a blank caption is still dropped", captions.length === 1)
}
{
  // The app keeps the official client's behaviour: verbatim is MCP-only.
  const payload = N.buildPayload(params({ prompt: "1girl", negative: "" }), 1)
  check("without verbatim the quality tags still apply", /masterpiece/.test(payload.input), payload.input)
  check("without verbatim the UC preset still merges", payload.parameters.negative_prompt.length > 0)
}

console.log("the manual")
{
  const names = G.TOPIC_NAMES
  for (const topic of ["basics", "quality", "text", "characters", "transparent", "visual-novel", "manga"]) {
    check(`has topic ${topic}`, names.includes(topic))
  }
  check("every topic has a summary", names.every((n) => G.TOPICS[n].summary.trim().length > 20))
  check("the index lists every topic", names.every((n) => G.guideIndex().includes(n)))
  check("an unknown topic fails loudly", (() => {
    try { G.guideText("nope"); return false } catch { return true }
  })())

  const all = names.map((n) => G.guideText(n)).join("\n")
  check("says the prompt is sent verbatim", /VERBATIM/.test(G.guideText("basics")))
  check("documents the numeric weight syntax", /1\.4::tag::/.test(all))
  check("quotes NovelAI's own transparency weight", /2\.1::transparent background::/.test(all))
  check("documents the dataset prefixes", /fur dataset,/.test(all) && /background dataset,/.test(all))
  check("warns that the background dataset looks photographic", /toward\s+photography/i.test(all))
  check("documents the token budgets", /1471/.test(all) && /703/.test(all))
  check("warns about negative space in the UC presets", /negative space/.test(G.guideText("quality")))
  check("count tags belong in the base prompt", /COUNT TAGS GO IN THE BASE PROMPT/.test(all))
  check("documents the action prefixes", /source#/.test(all) && /target#/.test(all) && /mutual#/.test(all))
  check("says alpha presence alone means nothing", /mere presence/.test(G.guideText("transparent")))
  check("explains the three transparency tags differ",
        /not synonyms/i.test(all) && /see-through/i.test(all))
  check("names all five visual novel tags",
        ["sprite", "cg", "bg", "chibi", "art"].every((k) => all.includes("visual novel " + k)))
  check("the manga topic admits its example is not official", /publishes no\s+example/i.test(all))
  check("the manga topic gives both palettes",
        /colored, vibrant colors/.test(all) && /monochrome, greyscale, screentone/.test(all))
}

console.log("the quality topic is generated from nai.ts")
{
  const q = G.guideText("quality")
  const v5 = N.qualityPresetText("nai-diffusion-5-full", "standard")
  check("quotes the V5 quality tags", q.includes(v5), v5)
  check("quotes the V5 light quality tags", q.includes(N.qualityPresetText("nai-diffusion-5-full", "light")))
  check("quotes the V5 Heavy UC preset", q.includes(N.ucPresetText("nai-diffusion-5-full", 0)))
  check("quotes the V3 quality tags", q.includes(N.qualityPresetText("nai-diffusion-3", "standard")))
  check("says quality tags go before Text:", /BEFORE a Text: directive/.test(q))
}

console.log("worked examples")
{
  const examples = G.TOPIC_NAMES.flatMap((n) => G.TOPICS[n].examples.map((e) => ({ topic: n, ...e })))
  check("there are examples", examples.length >= 6, String(examples.length))
  for (const e of examples) {
    const where = `${e.topic}: ${e.note.slice(0, 40)}`
    check(`${where} explains itself`, e.note.trim().length > 30)
    check(`${where} is rendered in its topic`, G.guideText(e.topic).includes(JSON.stringify(e.args.prompt)))
    // The bug this refactor exists for: nothing may follow a Text: directive.
    const captions = [e.args.prompt, ...(e.args.characters ?? []).map((c) => c.prompt)]
    for (const caption of captions) {
      const at = caption.indexOf("Text:")
      if (at < 0) continue
      // The examples' own lettering has no commas, so a comma after Text:
      // can only be a tag that would get painted in.
      check(`${where} keeps Text: last`, /^Text: [^,]*$/.test(caption.slice(at)), caption.slice(at))
    }
    check(`${where} never asks for "no text" alongside Text:`,
          !(captions.some((c) => /Text:/.test(c)) && /no text/.test(e.args.prompt)))
    if (e.args.width && e.args.height) {
      check(`${where} canvas is a multiple of 64`, e.args.width % 64 === 0 && e.args.height % 64 === 0)
      check(`${where} canvas fits the Opus free tier`, e.args.width * e.args.height <= 1024 * 1024)
    }
    // Each one has to actually be sendable as written.
    const payload = N.buildPayload(params({
      prompt: e.args.prompt,
      negative: e.args.negative ?? "",
      verbatim: true,
      characters: (e.args.characters ?? []).map((c) => ({
        prompt: c.prompt, negative: "", useCoords: c.x != null, x: c.x ?? 0.5, y: c.y ?? 0.5,
      })),
    }), 1)
    check(`${where} builds a verbatim payload`, payload.input === e.args.prompt)
  }
  const cutouts = examples.filter((e) => e.args.prompt.includes("transparent background"))
  check("cut-out examples lead with the transparency tags",
        cutouts.length >= 3 && cutouts.every((e) => e.args.prompt.startsWith(G.ALPHA_TAGS)))
  check("cut-out examples do not request scene translucency",
        cutouts.every((e) => !e.args.prompt.includes("alpha transparency")))
  check("cut-out examples carry no UC preset",
        cutouts.every((e) => !/blank page/.test(e.args.negative ?? "")))
  const multi = G.TOPICS.characters.examples[0].args
  check("the two-character example puts the count in the base prompt", /2girls/.test(multi.prompt))
  check("its captions stay singular", multi.characters.every((c) => !/\d(?:girls|boys)/.test(c.prompt)))
  const manga = G.TOPICS.manga.examples[0].args
  check("the manga example pins its characters",
        manga.characters.every((c) => c.x != null && c.y != null))
  check("the manga example puts dialogue on the characters",
        manga.characters.every((c) => /Text:/.test(c.prompt)) && !/Text:/.test(manga.prompt))
  check("the manga example states reading order", /right to left/i.test(manga.prompt))
}

console.log("transparency is measured from the pixels")
// Encodes an 8-bit, non-interlaced PNG with the given filter on every row, so
// the decoder's unfiltering is checked against all five filter types.
function encodePng(width, height, colorType, pixel, filter) {
  const bpp = colorType === 6 ? 4 : colorType === 4 ? 2 : 3
  const stride = width * bpp
  const rows = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(stride)
    for (let x = 0; x < width; x++) pixel(x, y).forEach((v, i) => { line[x * bpp + i] = v })
    const out = Buffer.alloc(stride + 1)
    out[0] = filter
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? line[i - bpp] : 0
      const up = prev[i]
      const upLeft = i >= bpp ? prev[i - bpp] : 0
      let pred = 0
      if (filter === 1) pred = left
      else if (filter === 2) pred = up
      else if (filter === 3) pred = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft)
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      out[i + 1] = (line[i] - pred) & 0xff
    }
    rows.push(out)
    prev = line
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
// Left half clear, right half opaque, with colour noise so the filters matter.
const halfClear = (x, y) => [(x * 37 + y * 11) & 0xff, (x * 5) & 0xff, (y * 13) & 0xff, x < 8 ? 0 : 255]
for (const filter of [0, 1, 2, 3, 4]) {
  const share = P.transparentFraction(encodePng(16, 9, 6, halfClear, filter))
  check(`a half-transparent RGBA image measures 50% (filter ${filter})`, share === 0.5, String(share))
}
// What V5 actually sends for an ordinary picture: RGBA, alpha 254-255.
const nearlyOpaque = (x, y) => [x * 9, y * 9, 128, (x + y) % 2 ? 254 : 255]
check("an RGBA image with alpha 254-255 measures 0%",
      P.transparentFraction(encodePng(16, 16, 6, nearlyOpaque, 4)) === 0)
check("grey+alpha is measured",
      P.transparentFraction(encodePng(10, 10, 4, (x) => [200, x < 3 ? 10 : 250], 1)) === 0.3)
check("plain RGB is 0%", P.transparentFraction(encodePng(8, 8, 2, () => [1, 2, 3], 0)) === 0)
check("a JPEG is not parsed", P.transparentFraction(Buffer.from("ffd8ffe000104a464946", "hex")) === null)
check("a truncated file is not parsed", P.transparentFraction(Buffer.from("89504e47", "hex")) === null)
check("an empty buffer is not parsed", P.transparentFraction(Buffer.alloc(0)) === null)
{
  const broken = encodePng(8, 8, 6, halfClear, 0)
  // Corrupt the compressed stream: the result must be "unknown", not 0%.
  broken.fill(0xff, 41, 60)
  check("a corrupt image is reported as unknown", P.transparentFraction(broken) === null)
}

console.log(failures === 0 ? "\n+ all guide checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
