/**
 * V5 generation modes, and the prompt standard behind them.
 *
 * The point is that a model calling this server should not have to guess how
 * NovelAI V5 wants to be prompted. Each mode carries the scaffolding, the
 * defaults and the caveats for one kind of output, so the caller supplies the
 * subject and nothing else.
 *
 * PROVENANCE — every capability tag below is quoted from NovelAI's own
 * material, not inferred. Where nothing official exists (the comic layout
 * example) it is marked as constructed, because a fabricated "standard" baked
 * into a tool description is worse than no standard at all.
 *
 *   journal.novelai.net, V5 release post
 *     "transparent background", "has alpha", "alpha transparency", and
 *     verbatim: "Sometimes, strengthening the 'transparent background' tag can
 *     give better results (e.g. '2.1::transparent background::')."
 *     The five visual novel tags.
 *     Comics: "describe how your comic or manga page should be laid out in
 *     natural language" and/or character positioning; full multi-panel pages,
 *     where earlier models were limited to 2koma.
 *
 *   docs.novelai.net/en/image/models
 *     "fur dataset," and "background dataset," as prompt-leading tags.
 *     Token budgets, 22 characters in official testing, text rendering in
 *     English / Japanese / Chinese.
 *
 *   docs.novelai.net/en/image/basics
 *     Order matters, subject first; {} strengthens and [] weakens.
 *
 *   docs.novelai.net/en/image/multiplecharacters
 *     The base prompt carries the count tags (2girls, 1boy) while each
 *     character prompt uses the singular. source# / target# / mutual# prefix
 *     action tags. 22 characters on V5, 6 on V4/V4.5.
 *
 *   docs.novelai.net/en/image/tutorial-artstyles
 *     Art-style tags belong near the start, and NovelAI recommends turning the
 *     quality tags off when a style has to survive.
 *
 *   ai-nante.com and note.com/ogre, community write-ups on V5 manga
 *     The panel structure the shots below follow: a leading layout sentence,
 *     then one clause per numbered panel giving its position and its shot, with
 *     each character prompt naming the panel it belongs to. Both report that
 *     character coordinates are what actually holds a page together, and that
 *     three or more characters gets unstable.
 *
 *   This repository, verified against the live API in nai.ts
 *     V5 quality tags, V5 reusing the V4.5 UC presets, forced Karras noise
 *     schedule, no Variety+, 32 character slots, and the `Text:` directive
 *     conflicting with the `no text` in every quality preset.
 */
import { DEFAULT_PARAMS } from "../nai"

/** Written into every mode tool's description so the caller sees it up front. */
export const V5_PROMPT_STANDARD = `NovelAI Diffusion V5 prompt rules:

STRUCTURE
- Order matters. Subject first, then style, framing, medium, era.
- Comma-separated Danbooru tags are the native form; plain English or Japanese
  sentences also work and can be mixed in.
- Weighting: {tag} strengthens, [tag] weakens, and 1.4::tag:: sets it
  numerically. NovelAI's own V5 example is 2.1::transparent background::.

TRANSPARENCY — three different tags, not synonyms
- "transparent background" empties the background. This is what a cut-out wants.
- "has alpha" is a vaguer request to use the alpha channel somehow.
- "alpha transparency" makes things IN THE SCENE see-through: magic, fire,
  glass, umbrellas. Do NOT put it on a character cut-out unless you really do
  want a translucent character.

DATASET PREFIXES (put at the very start of the prompt, when they apply)
- "fur dataset," for furry / kemono art.
- "background dataset," for landscapes, animal portraits and still lifes with
  no people in them.

TEXT IN THE IMAGE
- Write the words as  Text: the words here  — V5 renders English, Japanese and
  Chinese. This server strips "no text" from the quality preset automatically
  when it sees a Text: directive, because the two contradict each other.
- Text budget is separate from and smaller than the prompt budget.

CHARACTERS
- Up to 32 slots on this server; NovelAI documents 22 on V5, 6 on V4/V4.5.
- COUNT TAGS GO IN THE BASE PROMPT, not the character captions. Write "2girls,
  1boy" in \`subject\`, and let each caption say "girl" / "boy" in the singular
  with no number. Repeating counts inside a caption duplicates people.
- Pin a character with x/y in 0..1, origin top-left. y=0.75 puts someone in the
  lower quarter. Unpinned characters are placed top-to-bottom, left-to-right in
  the order given.
- Interaction verbs take a prefix: source#hugging on the one doing it,
  target#hugging on the one receiving it, mutual#holding hands for both.

ART STYLE
- Style tags work best near the START of the prompt.
- A strong style fights the quality preset; NovelAI recommends turning the
  quality tags off when the style matters more than the polish.

BUDGET
- V5 Full ~1471 prompt tokens (~750 for text); V5 Curated ~703 (~374).

SETTINGS THIS SERVER ALREADY HANDLES
- V5 is always sent with the Karras noise schedule, and exposes no Variety+.
- The V5 UC presets are the V4.5 ones. Note they contain "negative space" and
  "blank page", so asking for deliberate empty space needs ucPreset 3 (None).`

export type Mode = {
  name: string
  title: string
  /** One line, shown in the tool list. */
  summary: string
  /** Appended to the tool description, after the shared standard. */
  guidance: string
  /** Prepended to the caller's subject. */
  prefix: string
  /** Appended after the caller's subject. */
  suffix: string
  /** Added to the negative prompt on top of the UC preset. */
  negative: string
  width: number
  height: number
  steps: number
  guidanceScale: number
  ucPreset: number
  /** Modes that need an alpha channel; the result is checked for one. */
  wantsAlpha: boolean
  /**
   * A worked call, rendered into the tool description.
   *
   * A bare subject line was not enough: the modes that matter most (manga,
   * multi-character) fail on the arguments AROUND the subject — the count tags,
   * the coordinates — so the shot shows the whole call.
   */
  shot: Shot
}

export type Shot = {
  /** What this demonstrates, one line. */
  note: string
  subject: string
  kind?: string
  characters?: { prompt: string; x?: number; y?: number }[]
  qualityPreset?: "standard" | "light" | "none"
  width?: number
  height?: number
}

/**
 * Transparency is requested through the prompt, so it can silently not happen.
 * The tools check the returned PNG for an actual alpha channel rather than
 * assuming the tag worked.
 *
 * NOT all three transparency tags. NovelAI documents them as doing different
 * things: "transparent background" empties the background, "has alpha" is a
 * vaguer request to use the alpha channel somehow, and "alpha transparency"
 * asks for things IN THE SCENE to be see-through — magical effects, fire,
 * umbrellas. Stacking that third one onto a character cut-out asks for a
 * translucent character, which is the opposite of a usable sprite. It is
 * offered as an opt-in instead, via the `translucent` argument.
 */
const ALPHA_PREFIX = "2.1::transparent background::, has alpha"
export const TRANSLUCENT_TAG = "alpha transparency"

export const MODES: Mode[] = [
  {
    name: "novelai_asset_character",
    title: "Transparent-background character asset",
    summary: "A character cut out on real alpha transparency, for compositing.",
    guidance:
      "Use for sprites, stickers, standees and stream overlays — anything to be " +
      "layered onto another background. Transparency is requested through the " +
      "prompt, so it can fail quietly; this tool inspects the PNG and tells you " +
      "whether an alpha channel actually came back. Describe the character and " +
      "the pose only. Do NOT describe a background, and do not ask for a shadow " +
      "on the ground — both give the model something to draw where the " +
      "transparency should be.",
    prefix: ALPHA_PREFIX,
    suffix: "full body, simple design, clean lineart, isolated, no background",
    // The UC presets fight cut-outs: they contain "negative space" and
    // "blank page", which is exactly what a transparent asset is.
    negative: "background, scenery, backdrop, drop shadow, cast shadow, border, frame",
    width: 832,
    height: 1216,
    steps: 28,
    guidanceScale: 5,
    ucPreset: 3,
    wantsAlpha: true,
    shot: {
      note: "A sprite for compositing. Note what is absent: no background, no shadow, no scene.",
      subject:
        "1girl, silver hair, long braid, navy military coat with gold trim, standing at ease, " +
        "hand resting on sword hilt, calm expression, looking at viewer",
    },
  },
  {
    name: "novelai_asset_item",
    title: "Transparent-background item asset",
    summary: "A single object on real alpha transparency, for icons and inventory art.",
    guidance:
      "Use for inventory icons, item art and UI elements. One object, centred, " +
      "no scene around it. A square canvas suits icons; ask for a different size " +
      "if the object is strongly portrait or landscape. Like the character asset " +
      "tool, this reports whether an alpha channel actually came back.",
    prefix: ALPHA_PREFIX,
    suffix: "single object, centered, item focus, clean lineart, isolated, no background, no humans",
    negative:
      "background, scenery, drop shadow, cast shadow, border, frame, 1girl, 1boy, human, hands",
    width: 1024,
    height: 1024,
    steps: 28,
    guidanceScale: 5,
    ucPreset: 3,
    wantsAlpha: true,
    shot: {
      note: "One object, centred, nothing around it. `no humans` matters — items drift toward hands.",
      subject:
        "an ornate brass pocket watch, cracked glass face, engraved filigree, dangling chain, " +
        "three-quarter view",
    },
  },
  {
    name: "novelai_visual_novel",
    title: "Visual novel asset",
    summary: "Sprite, CG, background, chibi or general VN art, using V5's own VN tags.",
    guidance:
      "V5 ships five visual-novel style tags and this tool selects one for you " +
      "via `kind`:\n" +
      "  sprite — a standing character sprite. Gets alpha transparency, since a " +
      "sprite is composited over a background.\n" +
      "  cg     — a full-screen event illustration, 16:9.\n" +
      "  bg     — a background plate with no characters in it. Also gets the " +
      "official 'background dataset,' prefix.\n" +
      "  chibi  — a small deformed-proportion character, on transparency.\n" +
      "  art    — general visual-novel-styled illustration.\n" +
      "Pick `bg` rather than describing an empty room in another mode: the " +
      "dataset prefix is what actually removes the people.",
    prefix: "visual novel art",
    suffix: "",
    negative: "",
    width: 1216,
    height: 832,
    steps: 28,
    guidanceScale: 5.5,
    ucPreset: 0,
    wantsAlpha: false,
    shot: {
      note:
        "A background plate. `kind: bg` adds the official `background dataset,` prefix, " +
        "which is what actually empties the scene of people — describing an empty room in " +
        "words is far less reliable.",
      kind: "bg",
      subject:
        "a sunlit classroom in late afternoon, empty desks in rows, chalkboard, " +
        "cherry blossoms outside the window, warm orange light, no humans",
    },
  },
  {
    name: "novelai_illustration",
    title: "Single illustration",
    summary: "One finished illustration, with V5's quality scaffolding applied.",
    guidance:
      "The general-purpose mode: one polished picture. Give the subject, the " +
      "composition and the mood; the quality tags and the undesired-content " +
      "preset are applied for you. Use novelai_generate_image instead when you " +
      "need to control the model, sampler or per-character coordinates.",
    prefix: "",
    suffix: "",
    negative: "",
    width: 832,
    height: 1216,
    steps: 28,
    guidanceScale: 5.5,
    ucPreset: 0,
    wantsAlpha: false,
    shot: {
      note:
        "Two characters. The count tag `2girls` goes in `subject`; each caption says `girl`, " +
        "singular, with no number. The interaction verb is split across the pair with " +
        "source#/target#, and x/y pin who stands where.",
      subject:
        "2girls, a rooftop at dusk, city skyline behind, wind, warm rim light, " +
        "wide shot, cinematic",
      characters: [
        {
          prompt: "girl, short black hair, school uniform, laughing, source#hugging",
          x: 0.35,
          y: 0.6,
        },
        {
          prompt: "girl, long blonde hair, cardigan, surprised expression, target#hugging",
          x: 0.65,
          y: 0.6,
        },
      ],
    },
  },
  {
    name: "novelai_manga_page",
    title: "Multi-panel manga page",
    summary: "A whole paneled page in one generation, laid out in natural language.",
    guidance:
      "V5 generates a full multi-panel page in a single image — earlier models " +
      "managed only 2koma strips. NovelAI documents the mechanism as: describe " +
      "the page layout in natural language, and/or position the characters. " +
      "NovelAI publishes no example prompt; the shot below follows the structure " +
      "community write-ups converged on, and is a starting point rather than a " +
      "quoted standard.\n" +
      "\n" +
      "What actually matters:\n" +
      "  - Open with a layout sentence: how many panels, and the reading order. " +
      "Right-to-left has to be said explicitly.\n" +
      "  - Then one clause per panel giving BOTH its position on the page and " +
      "its shot. A page of undescribed panels comes back as decorative frames.\n" +
      "  - PIN THE CHARACTERS. Every write-up agrees this is the step that holds " +
      "a page together; layout from the prompt alone comes out chaotic. Put each " +
      "character's x/y inside the panel it belongs to.\n" +
      "  - Dialogue rides on the character, not the page: put `speech bubble, " +
      "Text: ...` in that character's caption. This tool sets ucPreset to None, " +
      "because the standard presets suppress lettering.\n" +
      "  - Two characters is the safe ceiling. Three or more is reported as " +
      "unstable.\n" +
      "  - Tall canvas. The default is 832x1216 — a 1:1.46 page ratio, and the " +
      "largest portrait canvas that still fits the Opus free tier (1 MP). A " +
      "roomier page reads better with four or more panels: pass width 1024 and " +
      "height 1536, and accept that it now costs Anlas.\n" +
      "  - Fewer, larger panels come out far more legible than many small ones. " +
      "Three or four is a realistic ceiling; six is pushing it.",
    prefix: "manga page, comic, monochrome, screentone, paneled page",
    suffix: "clean lineart, speech bubbles",
    negative: "photo, 3d, watermark, signature",
    // 1 MP is the Opus free-tier ceiling, and 832x1216 is the tallest portrait
    // canvas under it. A bigger page is a deliberate, paid choice.
    width: 832,
    height: 1216,
    steps: 28,
    guidanceScale: 5,
    // The standard presets contain "no text", which suppresses the lettering a
    // manga page is mostly made of.
    ucPreset: 3,
    wantsAlpha: false,
    shot: {
      note:
        "A three-panel page. The layout sentence leads; each panel then gets its position " +
        "AND its shot. Characters carry their own dialogue and are pinned into their panel " +
        "with x/y — community write-ups agree the coordinates are what stops the page " +
        "collapsing into decorative frames. Two characters is the safe ceiling; three or " +
        "more gets unstable.",
      subject:
        "3 panels, read right to left. " +
        "Panel 1, wide panel across the top: aerial view of a sunlit Tokyo street, no people, " +
        "a rectangular caption box reading lunch break. " +
        "Panel 2, large panel at bottom right: two girls walking side by side on the pavement, " +
        "full body. " +
        "Panel 3, small inset panel at bottom left: close-up of one girl's face, thoughtful.",
      characters: [
        {
          prompt:
            "girl, brown bob, cardigan, walking while looking at her phone, " +
            "speech bubble, Text: 新しいラーメン屋できたって",
          x: 0.7,
          y: 0.62,
        },
        {
          prompt:
            "girl, black ponytail, blazer, glancing sideways, " +
            "speech bubble, Text: 行ってみる?",
          x: 0.45,
          y: 0.62,
        },
      ],
    },
  },
]

export function modeByName(name: string): Mode | undefined {
  return MODES.find((mode) => mode.name === name)
}

/** A shot as the arguments the caller would actually pass. */
export function shotArgs(shot: Shot): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  if (shot.kind) args.kind = shot.kind
  args.subject = shot.subject
  if (shot.characters) args.characters = shot.characters
  if (shot.qualityPreset) args.qualityPreset = shot.qualityPreset
  if (shot.width) args.width = shot.width
  if (shot.height) args.height = shot.height
  return args
}

/** The full description string for a mode's tool. */
export function describeMode(mode: Mode): string {
  return [
    mode.summary,
    "",
    mode.guidance,
    "",
    "WORKED EXAMPLE — " + mode.shot.note,
    JSON.stringify(shotArgs(mode.shot), null, 2),
    "",
    V5_PROMPT_STANDARD,
  ].join("\n")
}

/**
 * Assemble the final prompt for a mode.
 *
 * The caller's subject goes between the scaffolding rather than after it,
 * because NovelAI documents that order matters and weights the front of the
 * prompt most heavily — except for the dataset prefixes, which the docs say
 * belong at the very start.
 */
export function composePrompt(mode: Mode, subject: string, datasetPrefix = ""): string {
  const parts = [datasetPrefix, mode.prefix, subject.trim(), mode.suffix]
  return parts
    .map((part) => part.trim().replace(/^,|,$/g, "").trim())
    .filter((part) => part.length > 0)
    .join(", ")
}

/** Defaults for a mode, merged over the server's own. */
export function modeParams(mode: Mode) {
  return {
    ...DEFAULT_PARAMS,
    width: mode.width,
    height: mode.height,
    steps: mode.steps,
    guidance: mode.guidanceScale,
    ucPreset: mode.ucPreset,
  }
}

/**
 * Whether a PNG carries an alpha channel.
 *
 * Transparency is requested in the prompt, so it is a hope, not a setting. The
 * IHDR colour type is at a fixed offset: 8-byte signature, 4-byte length,
 * 4-byte "IHDR", 4 width, 4 height, 1 bit depth, then colour type. 4 is
 * grey+alpha and 6 is RGBA; 0, 2 and 3 have no alpha.
 */
export function pngHasAlpha(png: Buffer): boolean {
  if (png.length < 26) return false
  if (png.subarray(0, 4).toString("hex") !== "89504e47") return false
  if (png.subarray(12, 16).toString("ascii") !== "IHDR") return false
  const colorType = png[25]
  return colorType === 4 || colorType === 6
}
