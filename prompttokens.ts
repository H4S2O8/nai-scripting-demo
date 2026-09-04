/**
 * Prompt text with embedded chunk references.
 *
 * A prompt is free text with chunk references embedded in it. A chunk stays one
 * indivisible token — you see the name you picked it by, not the nine tags
 * behind it — while everything around it is an ordinary run of text you can
 * edit however you like, commas and all.
 *
 * Text is deliberately NOT split into one token per tag. Doing that made
 * expanding a chunk explode into a row of separate chips with no way to type
 * between them, and it cannot represent prompt text that is not tag-shaped.
 *
 * The prompt still has to stay a plain string — storage, the payload builder
 * and the dedupe in mergePrompt all already treat it as one, and a parallel
 * structure would drift out of sync.
 *
 * So a reference is encoded inline, delimited by two control characters that
 * cannot be typed on a keyboard and so cannot collide with real prompt text:
 *
 *     U+0001 label U+0002 expansion U+0001
 *
 * The expansion travels inside the marker rather than being looked up by id, so
 * a prompt still expands correctly after the chunk is renamed or deleted.
 * expandPrompt() is what the payload builder sends; nothing outside the editor
 * needs to know the markers were ever there.
 */
import { Chunk } from "./chunks"

const OPEN = "\u0001"
const SEP = "\u0002"

export type PromptToken =
  | { kind: "text"; text: string }
  | { kind: "chunk"; label: string; expansion: string }

function sanitize(value: string): string {
  // The delimiters are the one thing a stored value must never contain.
  return value.split(OPEN).join("").split(SEP).join("")
}

export function makeMarker(label: string, expansion: string): string {
  return OPEN + sanitize(label) + SEP + sanitize(expansion) + OPEN
}

/** Split a prompt into chunk references and comma-separated plain tags. */
export function parsePrompt(text: string): PromptToken[] {
  const tokens: PromptToken[] = []

  // One token per run, not per tag: the run is what the user edits.
  const pushText = (raw: string) => {
    const trimmed = raw.replace(/^[\s,]+/, "").replace(/[\s,]+$/, "")
    if (trimmed) tokens.push({ kind: "text", text: trimmed })
  }

  let index = 0
  while (index < text.length) {
    const start = text.indexOf(OPEN, index)
    if (start === -1) {
      pushText(text.slice(index))
      break
    }
    const end = text.indexOf(OPEN, start + 1)
    if (end === -1) {
      // Unterminated marker: keep the remainder as plain text rather than
      // dropping whatever the user had.
      pushText(text.slice(index))
      break
    }
    pushText(text.slice(index, start))
    const body = text.slice(start + 1, end)
    const sep = body.indexOf(SEP)
    if (sep === -1) {
      pushText(body)
    } else {
      tokens.push({
        kind: "chunk",
        label: body.slice(0, sep),
        expansion: body.slice(sep + 1),
      })
    }
    index = end + 1
  }

  return tokens
}

export function serializePrompt(tokens: PromptToken[]): string {
  return tokens
    .map((token) =>
      token.kind === "chunk"
        ? makeMarker(token.label, token.expansion)
        : token.text.trim(),
    )
    .filter((part) => part.length > 0)
    .join(", ")
}

/** Every comma-separated tag in the free-text runs. */
export function textTags(tokens: PromptToken[]): string[] {
  const tags: string[] = []
  for (const token of tokens) {
    if (token.kind !== "text") continue
    for (const part of token.text.split(",")) {
      const trimmed = part.trim()
      if (trimmed) tags.push(trimmed)
    }
  }
  return tags
}

/**
 * Fuse neighbouring text runs into one.
 *
 * Called after expanding or removing a chunk, so the text closes back up into a
 * single editable run instead of leaving the seam where the chunk used to be.
 * Never called while typing — that would move the cursor.
 */
export function mergeAdjacentText(tokens: PromptToken[]): PromptToken[] {
  const out: PromptToken[] = []
  for (const token of tokens) {
    const last = out[out.length - 1]
    if (token.kind === "text" && last && last.kind === "text") {
      const left = last.text.trim()
      const right = token.text.trim()
      last.text = left && right ? left + ", " + right : left || right
      continue
    }
    out.push(token.kind === "text" ? { kind: "text", text: token.text } : token)
  }
  return out.filter((token) => token.kind !== "text" || token.text.trim().length > 0)
}

/** Replace one run's text. Does not merge, so the cursor stays put. */
export function setText(
  tokens: PromptToken[],
  index: number,
  text: string,
): PromptToken[] {
  const token = tokens[index]
  if (!token || token.kind !== "text") return tokens
  const out = tokens.slice()
  out[index] = { kind: "text", text }
  return out
}

/** Guarantee somewhere to type: a trailing run, created if the list ends in a chunk. */
export function withTrailingText(tokens: PromptToken[]): PromptToken[] {
  const last = tokens[tokens.length - 1]
  if (last && last.kind === "text") return tokens
  return tokens.concat([{ kind: "text", text: "" }])
}

/** What actually gets sent: every reference replaced by its tags. */
export function expandPrompt(text: string): string {
  return parsePrompt(text)
    .map((token) => (token.kind === "chunk" ? token.expansion : token.text))
    .filter((part) => part.trim().length > 0)
    .join(", ")
}

/** Readable form for previews: references shown by name in brackets. */
export function summarizePrompt(text: string): string {
  return parsePrompt(text)
    .map((token) => (token.kind === "chunk" ? "[" + token.label + "]" : token.text))
    .join(", ")
}

/**
 * Turn one chunk back into editable text.
 *
 * The result merges with whatever text sits either side, so expanding gives one
 * continuous run rather than a scattering of fragments.
 */
export function expandToken(tokens: PromptToken[], index: number): PromptToken[] {
  const token = tokens[index]
  if (!token || token.kind !== "chunk") return tokens
  const replacement: PromptToken = { kind: "text", text: token.expansion.trim() }
  return mergeAdjacentText(
    tokens.slice(0, index).concat([replacement], tokens.slice(index + 1)),
  )
}

export function removeToken(tokens: PromptToken[], index: number): PromptToken[] {
  return mergeAdjacentText(tokens.slice(0, index).concat(tokens.slice(index + 1)))
}

function chunkLabel(chunk: Chunk): string {
  return (chunk.label || chunk.id).trim()
}

/**
 * A chunk with no expansion inserts nothing.
 *
 * There is no falling back to the label: the label is a display name, so using
 * it as a tag would quietly push something like a Chinese category name into
 * the prompt. The picker shows such chunks as unavailable instead.
 */
function chunkExpansion(chunk: Chunk): string {
  return (chunk.expansion ?? "").trim()
}

export type ChunkState = "on" | "off"

/**
 * A chunk counts as on when its reference is present, or — for prompts written
 * before references existed, or after one was expanded — when every tag it
 * would add is already there as plain text.
 */
export function chunkState(text: string, chunk: Chunk): ChunkState {
  return chunkStateIn(parsePrompt(text), chunk)
}

export function chunkStateIn(tokens: PromptToken[], chunk: Chunk): ChunkState {
  const label = chunkLabel(chunk)
  const expansion = chunkExpansion(chunk)
  if (!expansion) return "off"
  if (tokens.some((t) => t.kind === "chunk" && t.label === label)) return "on"

  const present: Record<string, boolean> = {}
  for (const tag of textTags(tokens)) present[tag.toLowerCase()] = true
  const wanted = expansion
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  return wanted.length > 0 && wanted.every((tag) => present[tag.toLowerCase()])
    ? "on"
    : "off"
}

/** Insert the chunk as one token, or take it back out if it is already there. */
export function toggleChunkIn(tokens: PromptToken[], chunk: Chunk): PromptToken[] {
  const label = chunkLabel(chunk)
  const expansion = chunkExpansion(chunk)
  if (!expansion) return tokens

  if (chunkStateIn(tokens, chunk) === "off") {
    return tokens.concat([{ kind: "chunk", label, expansion }])
  }

  const wanted: Record<string, boolean> = {}
  for (const tag of expansion.split(",")) {
    const trimmed = tag.trim()
    if (trimmed) wanted[trimmed.toLowerCase()] = true
  }
  // Strip the chunk's tags out of the free text too, so turning a chunk off
  // also undoes one that had previously been expanded.
  const kept = tokens
    .filter((token) => token.kind !== "chunk" || token.label !== label)
    .map((token) =>
      token.kind === "text"
        ? {
            kind: "text" as const,
            text: token.text
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part && !wanted[part.toLowerCase()])
              .join(", "),
          }
        : token,
    )
  return mergeAdjacentText(kept)
}

export function toggleChunk(text: string, chunk: Chunk): string {
  return serializePrompt(toggleChunkIn(parsePrompt(text), chunk))
}

/** Append free-form tags, skipping ones already present. */
export function addTags(text: string, input: string): string {
  const tokens = parsePrompt(text)
  const present: Record<string, boolean> = {}
  for (const tag of textTags(tokens)) present[tag.toLowerCase()] = true
  const additions: string[] = []
  for (const part of input.split(",")) {
    const trimmed = part.trim()
    if (!trimmed || present[trimmed.toLowerCase()]) continue
    present[trimmed.toLowerCase()] = true
    additions.push(trimmed)
  }
  if (additions.length === 0) return serializePrompt(tokens)
  return serializePrompt(tokens.concat([{ kind: "text", text: additions.join(", ") }]))
}
