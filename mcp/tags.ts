/**
 * Tag lookup against NovelAI's own suggestion endpoint.
 *
 * This is the only way to know whether the model actually knows a character,
 * rather than guessing from the fact that the character is famous. The UI shows
 * it as the opacity of a circle; the endpoint returns it as a count.
 *
 *   GET /ai/generate-image/suggest-tags?model=<id>&prompt=<partial>
 *   -> { tags: [ { tag, count, confidence } ] }
 *
 * THE TRAP, and the reason the matching lives here rather than in each caller:
 * the endpoint is a FUZZY autocomplete. Querying "zzzznotarealcharacter"
 * happily returns "zzz" with a count of 10000. A non-empty response means
 * nothing at all. Only an exact match on the returned tag — or on its
 * "name (series)" form — is evidence the model knows the character.
 */
const HOST = "https://image.novelai.net"

export type Suggestion = { tag: string; count: number; confidence: number }

export type Lookup = {
  query: string
  /** The canonical tag to actually use, or "" when there was no exact match. */
  match: string
  /** Training-set size behind the matched tag. Saturates at 10000. */
  count: number
  /** Exact, series-qualified, or none. */
  kind: "exact" | "qualified" | "none"
  /** What came back, for a caller that wants to choose differently. */
  candidates: Suggestion[]
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ")
}

/** Strip a trailing "(series)" so "ganyu (genshin impact)" can match "ganyu". */
function bare(tag: string): string {
  return normalize(tag).replace(/\s*\([^()]*\)\s*$/, "")
}

/**
 * Decide what, if anything, the suggestions confirm.
 *
 * An exact hit on the query wins. Otherwise a tag whose bare name equals the
 * query counts as a qualified match, and the most-trained one is chosen —
 * "ganyu" is not itself a tag, but "ganyu (genshin impact)" is the thing the
 * caller meant. Anything looser is rejected: that is the fuzzy autocomplete
 * talking, not knowledge of the character.
 */
export function resolve(query: string, candidates: Suggestion[]): Lookup {
  const wanted = normalize(query)
  const exact = candidates.find((item) => normalize(item.tag) === wanted)
  if (exact) {
    return { query, match: exact.tag, count: exact.count, kind: "exact", candidates }
  }
  const qualified = candidates
    .filter((item) => bare(item.tag) === wanted)
    .sort((a, b) => b.count - a.count)[0]
  if (qualified) {
    return { query, match: qualified.tag, count: qualified.count, kind: "qualified", candidates }
  }
  return { query, match: "", count: 0, kind: "none", candidates }
}

export async function suggestTags(
  token: string,
  query: string,
  model: string,
): Promise<Suggestion[]> {
  const url =
    `${HOST}/ai/generate-image/suggest-tags` +
    `?model=${encodeURIComponent(model)}&prompt=${encodeURIComponent(query)}`
  const response = await fetch(url, { headers: { Authorization: "Bearer " + token } })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} · ${(await response.text()).slice(0, 160)}`)
  }
  const body = (await response.json()) as { tags?: unknown }
  if (!Array.isArray(body.tags)) return []
  return body.tags
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      tag: String(item.tag ?? ""),
      count: Number(item.count ?? 0),
      confidence: Number(item.confidence ?? 0),
    }))
    .filter((item) => item.tag.length > 0)
}

export async function lookup(
  token: string,
  query: string,
  model: string,
): Promise<Lookup> {
  return resolve(query, await suggestTags(token, query, model))
}
