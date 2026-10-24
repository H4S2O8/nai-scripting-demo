/**
 * Cutting a chapter into pages, ported from the novel-illustration skill's
 * book.py, where it was tuned on real books.
 *
 * Sentences end at 。！？!?… outside quotes, so a quoted line is never split;
 * a sentence longer than the hard maximum is cut again at commas. Pages are
 * then chosen by dynamic programming: each as close to the target length as
 * possible, short pages penalised, and a cut inside a paragraph costing about
 * as much as missing the target by thirty characters.
 *
 * Re-splitting keeps every page whose text and continuation flag are
 * unchanged, so its shot and images stay attached; see reconcile().
 */

const OPEN_Q = new Set(Array.from("“「『（(《"))
const CLOSE_Q = new Set(Array.from("”」』）)》"))
const SENT_END = new Set(Array.from("。！？!?…"))

export type SplitSettings = { target: number; min: number; max: number }
export const DEFAULT_SPLIT: SplitSettings = { target: 200, min: 140, max: 260 }

/** A page as the splitter produces it: its text, and whether it continues the previous page's paragraph. */
export type PageText = { text: string; cont: boolean }

/** Characters that count toward a page's length: everything but whitespace. */
export function countChars(text: string): number {
  return Array.from(text.replace(/\s/g, "")).length
}

export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[\s　]+|[\s　]+$/g, ""))
    .filter((line) => line.length > 0)
}

export function sentences(paragraph: string, hardMax: number): string[] {
  const chars = Array.from(paragraph)
  const found: string[] = []
  let buffer = ""
  let depth = 0
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    buffer += c
    if (OPEN_Q.has(c)) depth++
    else if (CLOSE_Q.has(c)) depth = Math.max(0, depth - 1)
    if (SENT_END.has(c)) {
      // Swallow repeated end marks and the closing quotes right after them.
      while (i + 1 < chars.length && (SENT_END.has(chars[i + 1]) || CLOSE_Q.has(chars[i + 1]))) {
        i++
        buffer += chars[i]
        if (CLOSE_Q.has(chars[i])) depth = Math.max(0, depth - 1)
      }
      if (depth === 0) {
        found.push(buffer)
        buffer = ""
      }
    }
  }
  if (buffer) found.push(buffer)

  const out: string[] = []
  for (const sentence of found) {
    if (countChars(sentence) <= hardMax) {
      out.push(sentence)
      continue
    }
    let piece = ""
    for (const part of sentence.split(/(?<=[，；、,;])/)) {
      if (piece && countChars(piece + part) > hardMax) {
        out.push(piece)
        piece = ""
      }
      piece += part
    }
    if (piece) out.push(piece)
  }
  return out
}

export function checkSplit(settings: SplitSettings) {
  const { target, min, max } = settings
  if (![target, min, max].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error("切页字数要是正整数")
  }
  if (!(min <= target && target <= max)) {
    throw new Error(`切页需要 min ≤ target ≤ max，现在是 ${min} / ${target} / ${max}`)
  }
}

/** Only a target given: the bounds follow at book.py's default ratios. */
export function splitFromTarget(target: number): SplitSettings {
  return { target, min: Math.round(target * 0.7), max: Math.round(target * 1.3) }
}

export function splitPages(text: string, settings: SplitSettings = DEFAULT_SPLIT): PageText[] {
  checkSplit(settings)
  const { target, min: lo, max: hi } = settings
  const units: { text: string; paragraph: number; paragraphEnd: boolean }[] = []
  splitParagraphs(text).forEach((paragraph, pi) => {
    const parts = sentences(paragraph, hi)
    parts.forEach((s, si) => units.push({ text: s, paragraph: pi, paragraphEnd: si === parts.length - 1 }))
  })
  const n = units.length
  if (n === 0) return []
  const lengths = units.map((u) => countChars(u.text))
  const best = new Array<number>(n + 1).fill(Infinity)
  const prev = new Array<number>(n + 1).fill(0)
  best[0] = 0
  for (let j = 1; j <= n; j++) {
    let total = 0
    for (let i = j - 1; i >= 0; i--) {
      total += lengths[i]
      if (total > hi && i < j - 1) break
      let cost = (total - target) ** 2
      if (total < lo && j < n) cost += (lo - total) ** 2 * 4
      if (!units[j - 1].paragraphEnd) cost += 900
      if (best[i] + cost < best[j]) {
        best[j] = best[i] + cost
        prev[j] = i
      }
    }
  }
  const cuts: [number, number][] = []
  for (let j = n; j > 0; j = prev[j]) cuts.unshift([prev[j], j])

  return cuts.map(([i, j]) => {
    let text = ""
    let lastParagraph: number | null = null
    for (const unit of units.slice(i, j)) {
      if (lastParagraph !== null && unit.paragraph !== lastParagraph) text += "\n"
      text += unit.text
      lastParagraph = unit.paragraph
    }
    return { text, cont: i > 0 && units[i - 1].paragraph === units[i].paragraph }
  })
}

/** Pages back into running text: a continuing page joins on, others start a paragraph. */
export function joinPages(pages: PageText[]): string {
  return pages.map((p, i) => (i > 0 && !p.cont ? "\n" : "") + p.text).join("")
}

/**
 * Match freshly split pages against the old ones by text and continuation
 * flag. Returns, for each new page, the old page it reuses (or null), plus
 * the old pages nothing reused — their shots lose their page.
 *
 * When several old pages share a text, the one closest in position wins: a
 * repeated refrain must not hand page 3's picture to page 9.
 */
export function reconcile<T extends PageText>(old: T[], fresh: PageText[]): { reuse: (T | null)[]; lost: T[] } {
  const pool = new Map<string, { page: T; index: number }[]>()
  old.forEach((page, index) => {
    const key = (page.cont ? "1" : "0") + page.text
    pool.set(key, [...(pool.get(key) ?? []), { page, index }])
  })
  const reuse = fresh.map((page, i) => {
    const candidates = pool.get((page.cont ? "1" : "0") + page.text)
    if (!candidates?.length) return null
    let best = 0
    for (let k = 1; k < candidates.length; k++) {
      if (Math.abs(candidates[k].index - i) < Math.abs(candidates[best].index - i)) best = k
    }
    return candidates.splice(best, 1)[0].page
  })
  const used = new Set(reuse.filter(Boolean))
  return { reuse, lost: old.filter((page) => !used.has(page)) }
}
