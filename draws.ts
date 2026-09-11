/**
 * Where a codex draw lands in the request, and how it is found again.
 *
 * A draw is not held in a slot of its own. It is written into the blocks the
 * user already has — the artist string into 艺术风格, a scene's base into
 * 特定, each of its character prompts into the character in the same slot —
 * as chunks whose label starts with a marker. Written that way, a draw is
 * visible where it applies, expands on a double-tap, can be edited or
 * deleted like any chunk, and needs no merge step at build time.
 *
 * The marker on the label is what lets "换一个" find the previous draw
 * among whatever else is in the block, and what tells the user at a glance
 * which chunk came from a draw.
 */
import { CharacterPrompt, GenerateParams } from "./nai"
import { findTaggedChunk, removeTaggedChunk, upsertTaggedChunk } from "./prompttokens"

export const ARTIST_PREFIX = "🎨 "
export const SCENE_PREFIX = "🎲 "

/** What a picker shows as "current": the draw read back out of the blocks. */
export type DrawInPlace = {
  title: string
  base: string
  characters: string[]
}

/* ---------------------------------------------------------------- artist */

export function currentArtist(params: GenerateParams): DrawInPlace | null {
  const found = findTaggedChunk(params.stylePrompt, ARTIST_PREFIX)
  if (!found) return null
  return { title: found.label.slice(ARTIST_PREFIX.length), base: found.expansion, characters: [] }
}

export function placeArtist(params: GenerateParams, title: string, prompt: string): GenerateParams {
  return { ...params, stylePrompt: upsertTaggedChunk(params.stylePrompt, ARTIST_PREFIX, title, prompt) }
}

export function clearArtist(params: GenerateParams): GenerateParams {
  return { ...params, stylePrompt: removeTaggedChunk(params.stylePrompt, ARTIST_PREFIX) }
}

/* ----------------------------------------------------------------- scene */

export function currentScene(params: GenerateParams): DrawInPlace | null {
  const base = findTaggedChunk(params.prompt, SCENE_PREFIX)
  const characters = (params.characters ?? [])
    .map((character) => findTaggedChunk(character.prompt, SCENE_PREFIX))
  const firstChar = characters.find((c) => c != null) ?? null
  if (!base && !firstChar) return null
  const label = (base ?? firstChar)!.label.slice(SCENE_PREFIX.length)
  return {
    title: label,
    base: base?.expansion ?? "",
    characters: characters.map((c) => c?.expansion ?? ""),
  }
}

function hadDraw(character: CharacterPrompt | undefined): boolean {
  return character != null && findTaggedChunk(character.prompt, SCENE_PREFIX) != null
}

/** A character slot with nothing of the user's in it. */
function bare(character: CharacterPrompt): boolean {
  return (
    removeTaggedChunk(character.prompt, SCENE_PREFIX).trim() === "" &&
    character.negative.trim() === "" &&
    character.useCoords !== true
  )
}

/**
 * Write a scene draw into the blocks.
 *
 * The base goes into 特定. Character prompt i goes into character i, after
 * whatever the user wrote there; when there is no character i yet, one is
 * added holding only the draw. Any previous draw is replaced slot by slot,
 * and a slot the previous draw had created — nothing of the user's in it —
 * is removed when the new draw has nothing for it, so re-drawing from a
 * three-person entry to a one-person entry does not leave two empty rows.
 */
export function placeScene(
  params: GenerateParams,
  title: string,
  base: string,
  characterPrompts: string[],
  limit: number,
): GenerateParams {
  const prompt = base.trim()
    ? upsertTaggedChunk(params.prompt, SCENE_PREFIX, title, base)
    : removeTaggedChunk(params.prompt, SCENE_PREFIX)

  const own = (params.characters ?? []).slice()
  const count = Math.max(own.length, Math.min(characterPrompts.length, limit))
  const next: CharacterPrompt[] = []
  for (let i = 0; i < count; i++) {
    const existing = own[i] ?? { prompt: "", negative: "", useCoords: false, x: 0.5, y: 0.5 }
    const incoming = i < limit ? (characterPrompts[i] ?? "").trim() : ""
    const updated: CharacterPrompt = {
      ...existing,
      prompt: incoming
        ? upsertTaggedChunk(existing.prompt, SCENE_PREFIX, title, incoming)
        : removeTaggedChunk(existing.prompt, SCENE_PREFIX),
    }
    // Drop a row only when the draw made it — it held a draw chunk and has
    // nothing of the user's — and the new draw has nothing for it. A row the
    // user never touched is never removed, even if it happens to be empty.
    if (!incoming && i >= own.length) continue
    if (!incoming && hadDraw(own[i]) && bare(updated)) continue
    next.push(updated)
  }
  return { ...params, prompt, characters: next }
}

export function clearScene(params: GenerateParams): GenerateParams {
  const prompt = removeTaggedChunk(params.prompt, SCENE_PREFIX)
  const characters: CharacterPrompt[] = []
  for (const character of params.characters ?? []) {
    const cleared = { ...character, prompt: removeTaggedChunk(character.prompt, SCENE_PREFIX) }
    // A row the draw created goes with it; any row with the user's own
    // text, negative or position stays, and so does a row the draw never
    // touched.
    if (hadDraw(character) && bare(cleared)) continue
    characters.push(cleared)
  }
  return { ...params, prompt, characters }
}
