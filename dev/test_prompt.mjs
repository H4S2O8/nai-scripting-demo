/**
 * Tests the prompt token model.
 *
 * The whole point is that a chunk survives inside a plain string without its
 * commas being mistaken for tag separators, so that is most of what this
 * checks. Run: node dev/test_prompt.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "nai-prompt-"))
const dest = join(out, "prompttokens.mjs")
execFileSync(
  "npx",
  ["--yes", "esbuild@0.24.0", join(root, "prompttokens.ts"), "--format=esm", "--bundle", "--outfile=" + dest],
  { stdio: ["ignore", "ignore", "inherit"] },
)
const P = await import(dest)

// Built rather than written literally: these are invisible control characters.
const OPEN = String.fromCharCode(1)
const SEP = String.fromCharCode(2)

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " - " + detail : ""))
  }
}

const chunk = (label, expansion) => ({
  id: label,
  label,
  expansion,
  color: "#7C5CFA",
  version: 1,
  containerId: "c",
  isCategory: false,
})

console.log("parse / serialize")
{
  const dark = chunk("dark-tone", "dark, low key lighting, {{shadows}}")
  const text = P.toggleChunk("1girl, solo", dark)
  const tokens = P.parsePrompt(text)
  // Free text stays one editable run; only the chunk is indivisible.
  check("free text stays one run", tokens.length === 2 && tokens[0].text === "1girl, solo")
  check("the chunk stays one token", tokens[1].kind === "chunk")
  check("its label survives", tokens[1].label === "dark-tone")
  // This is the property the whole encoding exists for: the expansion has
  // commas in it, and they must not read as tag separators.
  check(
    "commas inside the expansion do not split it",
    tokens[1].expansion === "dark, low key lighting, {{shadows}}",
  )
  check("round-trips through serialize", P.serializePrompt(tokens) === text)
  check(
    "expands to what the API gets",
    P.expandPrompt(text) === "1girl, solo, dark, low key lighting, {{shadows}}",
    P.expandPrompt(text),
  )
  check(
    "summary shows the name",
    P.summarizePrompt(text) === "1girl, solo, [dark-tone]",
    P.summarizePrompt(text),
  )
}

console.log("toggle")
{
  const style = chunk("watercolour", "watercolor, soft edges")
  let text = "1girl"
  check("starts off", P.chunkState(text, style) === "off")
  text = P.toggleChunk(text, style)
  check("turns on", P.chunkState(text, style) === "on")
  text = P.toggleChunk(text, style)
  check("turns back off", P.chunkState(text, style) === "off")
  check("and leaves the rest alone", text === "1girl", text)
}
{
  // A prompt written before references existed, or one whose token was
  // expanded, still has to read as "on" or the toggle lies.
  const style = chunk("watercolour", "watercolor, soft edges")
  const plain = "1girl, watercolor, soft edges"
  check("plain tags count as on", P.chunkState(plain, style) === "on")
  check("toggling off removes just those tags", P.toggleChunk(plain, style) === "1girl")
  check(
    "toggling off also undoes a previously expanded chunk",
    P.toggleChunk("1girl, watercolor, soft edges, solo", style) === "1girl, solo",
    P.toggleChunk("1girl, watercolor, soft edges, solo", style),
  )
  check("a partial match is off", P.chunkState("1girl, watercolor", style) === "off")
}

console.log("expand one token")
{
  // The old model split text per tag, so expanding scattered a chunk into a row
  // of separate chips with nowhere to type between them. It must close back up
  // into one run instead.
  const dark = chunk("dark-tone", "dark, low key")
  const tokens = P.parsePrompt(P.toggleChunk("1girl", dark))
  const expanded = P.expandToken(tokens, 1)
  check("expansion merges into one editable run", expanded.length === 1, JSON.stringify(expanded))
  check("with the text either side", expanded[0].text === "1girl, dark, low key", expanded[0].text)
  check("serializes to plain text", P.serializePrompt(expanded) === "1girl, dark, low key")
  check("expanding a text token is a no-op", P.expandToken(expanded, 0) === expanded)

  const middle = P.parsePrompt(P.serializePrompt([
    { kind: "text", text: "a" },
    { kind: "chunk", label: "c", expansion: "x, y" },
    { kind: "text", text: "b" },
  ]))
  check("a chunk between two runs merges both sides", P.serializePrompt(P.expandToken(middle, 1)) === "a, x, y, b", P.serializePrompt(P.expandToken(middle, 1)))
  check("removing it closes the seam", P.serializePrompt(P.removeToken(middle, 1)) === "a, b")
}

console.log("free-text editing")
{
  const tokens = P.parsePrompt(P.serializePrompt([
    { kind: "text", text: "1girl, solo" },
    { kind: "chunk", label: "c", expansion: "x, y" },
  ]))
  // Typing must not reflow the list, or the cursor jumps mid-word.
  const typed = P.setText(tokens, 0, "1girl, solo, standing on a ")
  check("setText edits in place", typed.length === 2 && typed[0].text === "1girl, solo, standing on a ")
  check("setText leaves the chunk alone", typed[1].kind === "chunk")
  check("setText on a chunk is refused", P.setText(tokens, 1, "nope") === tokens)
  check(
    "commas inside a run are just text",
    P.parsePrompt(P.serializePrompt(typed))[0].text === "1girl, solo, standing on a",
  )
  check("a trailing run is added when the list ends in a chunk", P.withTrailingText(tokens).length === 3)
  const endsInText = P.parsePrompt(P.serializePrompt([
    { kind: "chunk", label: "c", expansion: "x" },
    { kind: "text", text: "tail" },
  ]))
  check("and not when it already ends in text", P.withTrailingText(endsInText).length === 2)
  // Serializing on every keystroke trimmed the run and ate the comma you had
  // just typed, so the editor holds tokens and serializes once, on commit.
  const midType = P.setText(tokens, 0, "1girl, solo, ")
  check("typing keeps a trailing comma and space", midType[0].text === "1girl, solo, ")
  check("and only trims when serialized", P.serializePrompt(midType).startsWith("1girl, solo"))
  check("token-level toggle adds", P.toggleChunkIn(midType, chunk("z", "zz")).length === 3)
  check("token-level toggle is reversible", P.chunkStateIn(P.toggleChunkIn(midType, chunk("z", "zz")), chunk("z", "zz")) === "on")
  // Clearing leaves one empty run; appending after it used to render a
  // placeholder field above the chunk as well as the intended one below.
  const cleared = [{ kind: "text", text: "" }]
  const afterToggle = P.withTrailingText(P.tidy(P.toggleChunkIn(cleared, chunk("z", "zz"))))
  check(
    "clear then insert leaves exactly one empty run",
    afterToggle.filter((t) => t.kind === "text" && t.text.trim() === "").length === 1,
    JSON.stringify(afterToggle),
  )
  check("and it is the trailing one", afterToggle[afterToggle.length - 1].kind === "text")
  check("with the chunk before it", afterToggle[0].kind === "chunk")
  check("tidy keeps runs that have content", P.tidy([{ kind: "text", text: "a" }, { kind: "text", text: " " }]).length === 1)
  check("textTags splits runs for matching", JSON.stringify(P.textTags(typed)) === JSON.stringify(["1girl", "solo", "standing on a"]))
}

console.log("free text")
{
  let text = P.addTags("1girl", "solo, smile")
  check("appends tags", text === "1girl, solo, smile", text)
  text = P.addTags(text, "SOLO, blush")
  check("skips duplicates case-insensitively", text === "1girl, solo, smile, blush", text)
  check("free text with commas survives a round trip", P.addTags("a long phrase, with commas", "") === "a long phrase, with commas")
  const withChunk = P.toggleChunk(text, chunk("rim", "rim lighting"))
  check(
    "adding text after a chunk keeps the chunk",
    P.parsePrompt(P.addTags(withChunk, "cowboy shot")).filter((t) => t.kind === "chunk").length === 1,
  )
}

console.log("hostile input")
{
  // A label or expansion containing the delimiters would corrupt every later
  // parse, so they are stripped on the way in.
  const nasty = chunk("a" + OPEN + "b", "x" + SEP + "y, z")
  const tokens = P.parsePrompt(P.toggleChunk("", nasty))
  check(
    "delimiters are stripped from the label",
    tokens.length === 1 && tokens[0].label === "ab",
    JSON.stringify(tokens),
  )
  check("and from the expansion", tokens[0].expansion === "xy, z")

  const truncated = "1girl, " + OPEN + "dangling"
  check("an unterminated marker keeps the text", P.parsePrompt(truncated).length >= 1)
  check("and does not throw on expand", typeof P.expandPrompt(truncated) === "string")

  check("empty prompt parses to nothing", P.parsePrompt("").length === 0)
  check("empty expansion cannot be toggled on", P.toggleChunk("1girl", chunk("blank", "")) === "1girl")
}


console.log("prompt composition (nai.ts)")
{
  const dest2 = join(out, "nai.mjs")
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, "nai.ts"), "--format=esm", "--bundle", "--outfile=" + dest2],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  const N = await import(dest2)

  const base = {
    ...N.DEFAULT_PARAMS,
    model: "nai-diffusion-5-full",
    qualityPreset: "none",
    ucPreset: 3,
    stylePrompt: P.toggleChunk("", chunk("wc", "watercolor, soft edges")),
    characterPrompt: "1girl, blue eyes",
    prompt: "cowboy shot, smiling",
    negative: P.toggleChunk("", chunk("bad", "bad hands, blurry")),
    characters: [],
  }

  const positive = N.effectivePrompt(base)
  check(
    "three blocks concatenate style-first",
    positive === "watercolor, soft edges, 1girl, blue eyes, cowboy shot, smiling",
    positive,
  )
  // If a marker ever reached the API the prompt would be silently wrong, so
  // this is the assertion that matters most in the whole file.
  check("no marker survives into the request", !positive.includes(OPEN) && !positive.includes(SEP))
  const negative = N.effectiveNegative(base)
  check("negative expands too", negative === "bad hands, blurry", negative)
  check("no marker in the negative", !negative.includes(OPEN) && !negative.includes(SEP))

  check("blocks dedupe against each other", N.effectivePrompt({ ...base, characterPrompt: "1girl, watercolor" }) === "watercolor, soft edges, 1girl, cowboy shot, smiling")

  console.log("size presets")
  // A preset that quietly exceeds 1MP costs Anlas on what the UI labels free,
  // and one that is not a multiple of 64 is rejected by the API.
  const over1mp = N.SIZE_PRESETS_1MP.filter((p) => p.width * p.height > 1024 * 1024)
  check("every 1MP preset is within the free allowance", over1mp.length === 0, JSON.stringify(over1mp))
  check(
    "every 1MP preset is a multiple of 64",
    N.SIZE_PRESETS_1MP.every((p) => p.width % 64 === 0 && p.height % 64 === 0),
  )
  const overCap = N.SIZE_PRESETS_LARGE.filter((p) => p.width * p.height > 3145728)
  check("every large preset is within the 3MP ceiling", overCap.length === 0, JSON.stringify(overCap))
  check(
    "every large preset is a multiple of 64",
    N.SIZE_PRESETS_LARGE.every((p) => p.width % 64 === 0 && p.height % 64 === 0),
  )
  check(
    "large presets actually exceed the free allowance",
    N.SIZE_PRESETS_LARGE.every((p) => p.width * p.height > 1024 * 1024),
  )
  check("both sets are exposed together", N.SIZE_PRESETS.length === N.SIZE_PRESETS_1MP.length + N.SIZE_PRESETS_LARGE.length)

  console.log("1MP lock")
  check("a square at the limit keeps its partner", N.partnerWithin(1024) === 1024)
  check("a tall preset pulls the partner down", N.partnerWithin(1408) === 704)
  check("the partner is always a multiple of 64", [320, 512, 832, 1216, 2048].every((w) => N.partnerWithin(w) % 64 === 0))
  check(
    "the resulting pair never exceeds 1MP",
    [320, 512, 832, 1024, 1216, 1408, 2048].every((w) => w * N.partnerWithin(w) <= 1024 * 1024),
  )
  check("it never returns below the minimum dimension", N.partnerWithin(99999) >= 64)

  console.log("character captions")
  const withChars = {
    ...base,
    characters: [
      { prompt: P.toggleChunk("", chunk("hair", "long hair, silver hair")), negative: "", useCoords: false, x: 0.5, y: 0.5 },
      { prompt: "", negative: "ignored", useCoords: true, x: 0.2, y: 0.3 },
      { prompt: "red dress", negative: "bad hands", useCoords: true, x: 0.8, y: 0.4 },
    ],
  }
  const active = N.activeCharacters(withChars)
  check("empty captions are dropped", active.length === 2)
  check("character chunks expand", active[0].prompt === "long hair, silver hair", active[0].prompt)

  const payload = N.buildPayload(withChars, 12345)
  const v4 = payload.parameters.v4_prompt
  check("char_captions reach the payload", v4.caption.char_captions.length === 2)
  check(
    "every caption carries a center",
    v4.caption.char_captions.every((c) => c.centers.length === 1),
  )
  check(
    "AI placement uses the 0.5/0.5 sentinel",
    v4.caption.char_captions[0].centers[0].x === 0.5 && v4.caption.char_captions[0].centers[0].y === 0.5,
  )
  check("an explicit position is kept", v4.caption.char_captions[1].centers[0].x === 0.8)
  check("use_coords follows the characters", payload.parameters.use_coords === true && v4.use_coords === true)
  check(
    "negative captions appear when any character has one",
    payload.parameters.v4_negative_prompt.caption.char_captions.length === 2,
  )

  const noCoords = N.buildPayload(
    { ...withChars, characters: [{ prompt: "solo", negative: "", useCoords: false, x: 0.1, y: 0.1 }] },
    1,
  )
  check("use_coords is false when nobody pins a position", noCoords.parameters.use_coords === false)
  check(
    "negative captions are omitted when none is set",
    noCoords.parameters.v4_negative_prompt.caption.char_captions.length === 0,
  )

  const v3 = N.buildPayload({ ...withChars, model: "nai-diffusion-3" }, 1)
  check("V3 gets no structured captions at all", v3.parameters.v4_prompt === undefined)
  check("V3 still gets SMEA fields", "sm" in v3.parameters)
  check("V3 reports no character slots", N.maxCharacterPrompts("nai-diffusion-3") === 0)
  check("V5 reports 32 slots", N.maxCharacterPrompts("nai-diffusion-5-full") === 32)
  check("V4.5 reports 6 slots", N.maxCharacterPrompts("nai-diffusion-4-5-full") === 6)
  check(
    "characters beyond the model limit are dropped",
    N.activeCharacters({
      ...base,
      model: "nai-diffusion-4-5-full",
      characters: new Array(9).fill(0).map(() => ({ prompt: "a", negative: "", useCoords: false, x: 0.5, y: 0.5 })),
    }).length === 6,
  )
}

console.log(failures === 0 ? "\n[ok] prompt token model holds" : "\n[fail] " + failures + " check(s) failed")
process.exit(failures === 0 ? 0 : 1)
