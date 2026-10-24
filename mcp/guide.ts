/**
 * The NovelAI prompt manual, served by the `novelai_guide` tool.
 *
 * The generation tool sends the caller's prompt verbatim. It used to wrap it
 * instead — quality tags appended, a UC preset merged in, mode prefixes and
 * suffixes around the subject — and that breaks on the edges: everything after
 * V5's `Text:` directive is lettered into the image, so a prompt ending in
 * `Text: OPEN` came back with "OPEN, very aesthetic, masterpiece" painted on
 * the sign. The knowledge that used to live in that scaffolding is here now,
 * as advice the calling agent applies itself.
 *
 * PROVENANCE — every capability tag below is quoted from NovelAI's own
 * material, not inferred. Where nothing official exists (the comic layout
 * example) it is marked as constructed, because a fabricated "standard" handed
 * to a model as fact is worse than no standard at all.
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
 *     "fur dataset," and "background dataset," as prompt-leading tags. The
 *     latter is documented but steered away from: see the visual novel topic.
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
 *     The panel structure the manga example follows: a leading layout
 *     sentence, then one clause per numbered panel giving its position and its
 *     shot, with each character prompt naming the panel it belongs to. Both
 *     report that character coordinates are what actually holds a page
 *     together, and that three or more characters gets unstable.
 *
 *   This repository, verified against the live API in nai.ts
 *     The official quality tags and UC presets per model (V5 reuses the V4.5
 *     presets), forced Karras noise schedule, no Variety+, 32 character slots,
 *     and the `no text` in every quality preset contradicting `Text:`.
 */
import { MODELS, qualityPresetText, ucPresetText, UC_PRESETS } from "../nai"

/** A worked call, as the arguments the caller would pass to novelai_generate_image. */
export type Example = {
  /** What this demonstrates, one line. */
  note: string
  args: {
    prompt: string
    negative?: string
    characters?: { prompt: string; x?: number; y?: number }[]
    width?: number
    height?: number
  }
}

export type Topic = {
  /** One line, shown in the index. */
  summary: string
  body: () => string
  examples: Example[]
}

const V5 = "nai-diffusion-5-full"

/** The V5 Full UC presets, quoted where an example wants one. */
const UC_HEAVY = ucPresetText(V5, 0)
const UC_LIGHT = ucPresetText(V5, 1)
const QUALITY = qualityPresetText(V5, "standard")
/** The standard V5 quality tags minus `no text`, for anything with lettering. */
const QUALITY_WITH_TEXT = QUALITY.split(",")
  .map((tag) => tag.trim())
  .filter((tag) => tag !== "no text")
  .join(", ")

/** The transparency request NovelAI's own V5 post demonstrates. */
export const ALPHA_TAGS = "2.1::transparent background::, has alpha"

const CUTOUT_NEGATIVE = "background, scenery, backdrop, drop shadow, cast shadow, border, frame"

function renderExample(example: Example): string {
  return "EXAMPLE — " + example.note + "\n" + JSON.stringify(example.args, null, 2)
}

export const TOPICS: Record<string, Topic> = {
  basics: {
    summary: "How the server treats your prompt, V5 prompt structure, weighting, budgets, sizes.",
    body: () => `NovelAI prompt basics (V5 first; V4/V4.5 noted where they differ)

THIS SERVER SENDS YOUR PROMPT VERBATIM
- prompt, negative and every character caption reach NovelAI exactly as
  written. Nothing is prepended or appended: no quality tags, no
  undesired-content preset, no transparency tag, no de-duplication.
- The official web client does append quality tags and merge a UC preset. If
  you want that polish, write the tags in yourself — topic "quality" lists the
  exact official text per model.

STRUCTURE
- Order matters. Subject first, then style, framing, medium, era.
- Comma-separated Danbooru tags are the native form; plain English or Japanese
  sentences also work and can be mixed in.
- Weighting: {tag} strengthens, [tag] weakens, and 1.4::tag:: sets it
  numerically. NovelAI's own V5 example is 2.1::transparent background::.

DATASET PREFIXES (at the very start of the prompt, when they apply)
- "fur dataset," for furry / kemono art.
- "background dataset," for landscapes, animal portraits and still lifes with
  no people in them. CAUTION: in use it also drags the result toward
  photography. To empty an illustrated scene of people, "no humans, scenery"
  does it without touching the look. Use the prefix only when a photographic
  result is what you want.

ART STYLE
- Style tags work best near the START of the prompt.
- A strong style fights the quality tags; NovelAI recommends leaving them out
  when the style matters more than the polish.

BUDGET
- V5 Full ~1471 prompt tokens (~750 for text); V5 Curated ~703 (~374).

CANVAS AND COST
- The Opus free tier covers images up to 1 MP (1024x1024) at 28 steps or
  fewer. 832x1216 portrait, 1216x832 landscape and 1024x1024 square are the
  usual free sizes; anything larger costs Anlas.

SETTINGS THE SERVER HANDLES
- V5 is always sent with the Karras noise schedule, and exposes no Variety+.

OTHER TOPICS
- quality, text, characters, transparent, visual-novel, manga.`,
    examples: [
      {
        note:
          "A single illustration with the official V5 quality tags and the Heavy UC preset " +
          "written in by hand — the same request the web client would send with both toggles on.",
        args: {
          prompt:
            "1girl, silver hair, long braid, navy military coat with gold trim, standing on a " +
            "rooftop at dusk, city skyline behind, wind, warm rim light, cowboy shot, " + QUALITY,
          negative: UC_HEAVY,
          width: 832,
          height: 1216,
        },
      },
    ],
  },

  quality: {
    summary: "The official quality tags and undesired-content presets per model, to copy in.",
    body: () => {
      const lines = [
        "QUALITY TAGS AND UNDESIRED-CONTENT (UC) PRESETS",
        "",
        "The official web client appends quality tags to the end of the prompt and merges a",
        "UC preset into the negative. This server does neither: copy them in when you want",
        "them, and leave them out when they get in the way.",
        "",
        "WHERE THEY GO, AND WHEN TO LEAVE THEM OUT",
        "- Anywhere BEFORE a Text: directive, never after it. Everything after Text: is",
        '  lettered into the image: "Text: OPEN, very aesthetic, masterpiece" paints all',
        "  three phrases on the sign. See topic \"text\".",
        '- Drop "no text" whenever the image should contain lettering; it contradicts Text:.',
        "- A strong art style fights the quality tags; leave them out when the style matters",
        "  more than the polish.",
        '- Every UC preset contains "negative space" and "blank page". Leave the preset out',
        "  for cut-outs, deliberate empty space and minimal backgrounds.",
        "",
        "PER MODEL (exact official text)",
      ]
      for (const model of MODELS) {
        const standard = qualityPresetText(model.id, "standard")
        const light = qualityPresetText(model.id, "light")
        const ucs = UC_PRESETS.filter((p) => p.id !== 3)
          .map((p) => ({ label: p.label, text: ucPresetText(model.id, p.id) }))
          .filter((p) => p.text)
        if (!standard && ucs.length === 0) continue
        lines.push("", `${model.label} (${model.id})`)
        if (standard) lines.push(`  quality, standard: ${standard}`)
        if (light && light !== standard) lines.push(`  quality, light:    ${light}`)
        for (const uc of ucs) lines.push(`  UC ${uc.label}: ${uc.text}`)
      }
      return lines.join("\n")
    },
    examples: [],
  },

  text: {
    summary: "Lettering, signs and speech bubbles with V5's Text: directive.",
    body: () => `TEXT IN THE IMAGE (V5)

- Write the words as  Text: the words here  — V5 letters English, Japanese and
  Chinese.
- Text: runs to the end of the caption it sits in. Make it the LAST thing in
  that caption: any tag after it gets lettered too, quality tags included.
- Put style, framing and quality tags before it. Leave "no text" out entirely.
- Dialogue rides on the speaker: put "speech bubble, Text: ..." at the end of
  that character's caption rather than in the base prompt. That is also how to
  letter more than one separate thing in an image.
- Text budget is separate from and smaller than the prompt budget: ~750 tokens
  on V5 Full, ~374 on Curated.
- If lettering comes out weak, try without a UC preset in the negative.`,
    examples: [
      {
        note:
          "A sign. Quality tags (minus `no text`) come BEFORE the Text: directive, which ends the prompt.",
        args: {
          prompt:
            "a wooden signboard hanging on a plain wall, close-up, warm light, " +
            QUALITY_WITH_TEXT + ", Text: OPEN",
          negative: UC_LIGHT,
          width: 1024,
          height: 1024,
        },
      },
    ],
  },

  characters: {
    summary: "Multi-character captions: count tags, positions, interaction prefixes.",
    body: () => `CHARACTERS (V4+ and V5)

- Up to 32 caption slots on this server; NovelAI documents 22 on V5 and 6 on
  V4/V4.5. V3 has none.
- COUNT TAGS GO IN THE BASE PROMPT, not the captions. Write "2girls, 1boy" in
  prompt, and let each caption say "girl" / "boy" in the singular with no
  number. Repeating counts inside a caption duplicates people.
- Pin a character with x/y in 0..1, origin top-left. y=0.75 puts someone in the
  lower quarter. Unpinned characters are placed top-to-bottom, left-to-right
  in the order given.
- Interaction verbs take a prefix: source#hugging on the one doing it,
  target#hugging on the one receiving it, mutual#holding hands for both.
- Each caption may carry its own negative.`,
    examples: [
      {
        note:
          "Two characters. `2girls` is in the base prompt; each caption says `girl`, singular. The " +
          "hug is split across the pair with source#/target#, and x/y pin who stands where.",
        args: {
          prompt:
            "2girls, a rooftop at dusk, city skyline behind, wind, warm rim light, wide shot, " +
            "cinematic, " + QUALITY,
          negative: UC_HEAVY,
          characters: [
            { prompt: "girl, short black hair, school uniform, laughing, source#hugging", x: 0.35, y: 0.6 },
            { prompt: "girl, long blonde hair, cardigan, surprised expression, target#hugging", x: 0.65, y: 0.6 },
          ],
          width: 1216,
          height: 832,
        },
      },
    ],
  },

  transparent: {
    summary: "Character and item cut-outs on a real alpha channel (V5).",
    body: () => `TRANSPARENT ASSETS (V5)

THREE DIFFERENT TAGS, NOT SYNONYMS
- "transparent background" empties the background. This is what a cut-out
  wants. NovelAI's own advice is to weight it: ${ALPHA_TAGS}.
- "has alpha" is a vaguer request to use the alpha channel somehow.
- "alpha transparency" makes things IN THE SCENE see-through: magic, fire,
  glass, umbrellas. On a character cut-out it gives a translucent character —
  add it only when that is the point.

WRITING A CUT-OUT
- Lead with the transparency tags, then the subject, then "isolated, no
  background".
- Describe the subject and the pose only. No background, and no shadow on the
  ground: both give the model something to draw where the transparency should
  be.
- Leave the UC preset out — its "negative space, blank page" is exactly what a
  cut-out is — and negate the background instead:
  ${CUTOUT_NEGATIVE}
- Items: say "single object, centered, item focus, no humans" and add
  "1girl, 1boy, human, hands" to the negative; items drift toward hands.
- Transparency is a request, not a setting, so it can quietly fail. The
  generation result reports, per image, the share of pixels that came back
  actually transparent (V5 always sends an alpha channel, so its mere presence
  means nothing). A cut-out at 0% failed: raise the weight (2.4::transparent
  background::) or remove whatever in the prompt reads as a background.`,
    examples: [
      {
        note: "A character sprite for compositing. Note what is absent: no background, no shadow, no scene.",
        args: {
          prompt:
            ALPHA_TAGS + ", 1girl, silver hair, long braid, navy military coat with gold trim, " +
            "standing at ease, hand resting on sword hilt, calm expression, looking at viewer, " +
            "full body, isolated, no background",
          negative: CUTOUT_NEGATIVE,
          width: 832,
          height: 1216,
        },
      },
      {
        note: "An item icon. One object, centred, nothing around it.",
        args: {
          prompt:
            ALPHA_TAGS + ", an ornate brass pocket watch, cracked glass face, engraved filigree, " +
            "dangling chain, three-quarter view, single object, centered, item focus, clean " +
            "lineart, isolated, no background, no humans",
          negative: CUTOUT_NEGATIVE + ", 1girl, 1boy, human, hands",
          width: 1024,
          height: 1024,
        },
      },
    ],
  },

  "visual-novel": {
    summary: "V5's five visual-novel tags: sprite, cg, bg, chibi, art.",
    body: () => `VISUAL NOVEL ASSETS (V5)

V5 ships five visual-novel style tags. Lead the prompt with one:
  visual novel sprite — a standing character sprite. Usually wanted on
                        transparency: add the cut-out tags from topic
                        "transparent" and "full body, standing, isolated, no
                        background". 832x1216.
  visual novel cg     — a full-screen event illustration. 1216x832 (16:9-ish).
  visual novel bg     — a background plate with no characters. Add "no humans,
                        scenery". 1216x832.
  visual novel chibi  — small deformed proportions. Add "chibi"; usually on
                        transparency like a sprite. 1024x1024.
  visual novel art    — general visual-novel-styled illustration.

BACKGROUNDS
- Do NOT use the official "background dataset," prefix for VN backgrounds: it
  empties the scene but pulls the style toward photography. "no humans,
  scenery" clears the frame without touching the look.`,
    examples: [
      {
        note: "A background plate: the bg tag leads, and `no humans, scenery` clears the frame.",
        args: {
          prompt:
            "visual novel bg, a sunlit classroom in late afternoon, empty desks in rows, " +
            "chalkboard, cherry blossoms outside the window, warm orange light, no humans, " +
            "scenery, " + QUALITY,
          negative: UC_HEAVY,
          width: 1216,
          height: 832,
        },
      },
      {
        note: "A sprite on transparency: transparency tags first, then the VN tag, then the character.",
        args: {
          prompt:
            ALPHA_TAGS + ", visual novel sprite, 1girl, brown bob, school blazer, hands behind " +
            "back, gentle smile, looking at viewer, full body, standing, isolated, no background",
          negative: CUTOUT_NEGATIVE,
          width: 832,
          height: 1216,
        },
      },
    ],
  },

  manga: {
    summary: "A whole multi-panel manga page in one generation (V5).",
    body: () => `MANGA PAGES (V5)

V5 generates a full multi-panel page in one image — earlier models managed
only 2koma strips. NovelAI documents the mechanism as: describe the page layout
in natural language, and/or position the characters. NovelAI publishes no
example prompt; the example below follows the structure community write-ups
converged on, and is a starting point rather than a quoted standard.

- Open with "manga page, comic, paneled page" and a layout sentence: how many
  panels, and the reading order. Right-to-left has to be said explicitly.
- Then one clause per panel giving BOTH its position on the page and its shot.
  A page of undescribed panels comes back as decorative frames.
- PIN THE CHARACTERS. Every write-up agrees this is what holds a page
  together; layout from the prompt alone comes out chaotic. Put each
  character's x/y inside the panel it belongs to.
- Dialogue rides on the character: end that character's caption with
  "speech bubble, Text: ..." (topic "text"). Leave "no text" and the UC
  presets out.
- Two characters is the safe ceiling; three or more is reported as unstable.
- Colour vs black and white. Comic training data skews black-and-white, so a
  page with no palette instruction still tends to come back grey:
    colour:     prompt "colored, vibrant colors";
                negative "monochrome, greyscale, screentone, sketch"
    monochrome: prompt "monochrome, greyscale, screentone"
- Canvas: 832x1216 is the tallest portrait page inside the Opus free tier.
  Four or more panels read better at 1024x1536, which costs Anlas.
- Fewer, larger panels come out far more legible. Three or four is a
  realistic ceiling; six is pushing it.`,
    examples: [
      {
        note:
          "A three-panel colour page. The layout sentence leads; each panel gets its position AND its " +
          "shot. Characters carry their own dialogue, with Text: last in each caption, and are pinned " +
          "into their panel with x/y.",
        args: {
          prompt:
            "manga page, comic, paneled page, colored, vibrant colors, 3 panels, read right to left. " +
            "Panel 1, wide panel across the top: aerial view of a sunlit Tokyo street, no people. " +
            "Panel 2, large panel at bottom right: two girls walking side by side on the pavement, " +
            "full body. " +
            "Panel 3, small inset panel at bottom left: close-up of one girl's face, thoughtful. " +
            "clean lineart, speech bubbles, very aesthetic, masterpiece",
          negative: "monochrome, greyscale, screentone, sketch, photo, 3d, watermark, signature",
          characters: [
            {
              prompt:
                "girl, brown bob, cardigan, walking while looking at her phone, " +
                "speech bubble, Text: 新しいラーメン屋できたって",
              x: 0.7,
              y: 0.62,
            },
            {
              prompt: "girl, black ponytail, blazer, glancing sideways, speech bubble, Text: 行ってみる?",
              x: 0.45,
              y: 0.62,
            },
          ],
          width: 832,
          height: 1216,
        },
      },
    ],
  },
}

export const TOPIC_NAMES = Object.keys(TOPICS) as [string, ...string[]]

/** The index: every topic with its one-line summary. */
export function guideIndex(): string {
  return [
    "NovelAI prompt manual. Call novelai_guide with one of these topics:",
    "",
    ...TOPIC_NAMES.map((name) => `  ${name.padEnd(13)} ${TOPICS[name].summary}`),
    "",
    "The generation tool sends your prompt verbatim; nothing is added for you.",
  ].join("\n")
}

/** One topic's full text, examples included. */
export function guideText(name: string): string {
  const topic = TOPICS[name]
  if (!topic) throw new Error(`unknown guide topic: ${name}`)
  return [topic.body(), ...topic.examples.map(renderExample)].join("\n\n")
}
