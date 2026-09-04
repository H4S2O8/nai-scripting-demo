/**
 * Prompt text with embedded chunk references.
 *
 * A chunk dropped into a prompt stays one token instead of spilling its tags:
 * you see the chunk's name, not the nine tags behind it. The prompt therefore
 * has to carry the reference, but it also has to stay a plain string — storage,
 * the payload builder and the dedupe in mergePrompt all already treat it as
 * one, and a parallel structure would drift out of sync.
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

  const pushText = (raw: string) => {
    for (const part of raw.split(",")) {
      const trimmed = part.trim()
      if (trimmed) tokens.push({ kind: "text", text: trimmed })
    }
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
      token.kind === "chunk" ? makeMarker(token.label, token.expansion) : token.text,
    )
    .filter((part) => part.length > 0)
    .join(", ")
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

/** Replace one chunk token with its tags, in place. */
export function expandToken(tokens: PromptToken[], index: number): PromptToken[] {
  const token = tokens[index]
  if (!token || token.kind !== "chunk") return tokens
  const replacement: PromptToken[] = token.expansion
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((text) => ({ kind: "text", text }) as PromptToken)
  return tokens.slice(0, index).concat(replacement, tokens.slice(index + 1))
}

export function removeToken(tokens: PromptToken[], index: number): PromptToken[] {
  return tokens.slice(0, index).concat(tokens.slice(index + 1))
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
  const label = chunkLabel(chunk)
  const expansion = chunkExpansion(chunk)
  if (!expansion) return "off"
  const tokens = parsePrompt(text)
  if (tokens.some((t) => t.kind === "chunk" && t.label === label)) return "on"

  const present: Record<string, boolean> = {}
  for (const token of tokens) {
    if (token.kind === "text") present[token.text.toLowerCase()] = true
  }
  const wanted = expansion
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  return wanted.length > 0 && wanted.every((tag) => present[tag.toLowerCase()])
    ? "on"
    : "off"
}

/** Insert the chunk as one token, or take it back out if it is already there. */
export function toggleChunk(text: string, chunk: Chunk): string {
  const label = chunkLabel(chunk)
  const expansion = chunkExpansion(chunk)
  if (!expansion) return text

  if (chunkState(text, chunk) === "off") {
    const tokens = parsePrompt(text)
    tokens.push({ kind: "chunk", label, expansion })
    return serializePrompt(tokens)
  }

  const wanted: Record<string, boolean> = {}
  for (const tag of expansion.split(",")) {
    const trimmed = tag.trim()
    if (trimmed) wanted[trimmed.toLowerCase()] = true
  }
  const kept = parsePrompt(text).filter((token) =>
    token.kind === "chunk" ? token.label !== label : !wanted[token.text.toLowerCase()],
  )
  return serializePrompt(kept)
}

/** Append free-form tags, skipping ones already present. */
export function addTags(text: string, input: string): string {
  const tokens = parsePrompt(text)
  const present: Record<string, boolean> = {}
  for (const token of tokens) {
    if (token.kind === "text") present[token.text.toLowerCase()] = true
  }
  for (const part of input.split(",")) {
    const trimmed = part.trim()
    if (!trimmed || present[trimmed.toLowerCase()]) continue
    present[trimmed.toLowerCase()] = true
    tokens.push({ kind: "text", text: trimmed })
  }
  return serializePrompt(tokens)
}
