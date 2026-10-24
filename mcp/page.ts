/**
 * "Picture on the left, text on the right" novel pages.
 *
 * The layout rules are ported from the novel-illustration skill's book.py,
 * where they were tuned by eye on real pages: punctuation that may not start a
 * line hangs at the end of the previous one, an opening bracket never ends a
 * line, a last line holding a single character pulls one down from above, and
 * lines that end a little short are justified.
 *
 * What is new here is fitting arbitrary amounts of text, for reading on a phone
 * or a tablet: the page stays narrow and the text fills it. The column is never
 * wider than the picture and holds 14–30 characters a line; within that, the
 * layout whose text looks largest once the page is scaled to a screen's width
 * wins, so short text is set large in a narrow column rather than floating in
 * a wide empty one. Text that does
 * not fit at the smallest size and tightest leading is refused with an estimate
 * of how much would — never truncated, and the page is never widened for it.
 *
 * Measurement is injected, so the layout itself is testable without a canvas.
 */
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas"
import { existsSync } from "node:fs"

export const NO_LINE_START = new Set(Array.from("，。、；：？！…—）」』”’》〉】,.;:?!)"))
export const NO_LINE_END = new Set(Array.from("（「『“‘《〈【("))

export type Token = { text: string; width: number }
export type Line = { tokens: Token[]; first: boolean; last: boolean }
export type Measure = (text: string) => number

/** Latin words, numbers, …… and —— stay whole; everything else is one character. */
export function tokenize(paragraph: string): string[] {
  return paragraph.match(/[A-Za-z0-9'’.\-]+|……|——|./gsu) ?? []
}

export function layoutParagraph(paragraph: string, measure: Measure, width: number, indent: number): Line[] {
  const tokens = tokenize(paragraph).map((text) => ({ text, width: measure(text) }))
  const raw: { tokens: Token[]; first: boolean }[] = []
  let current: Token[] = []
  let used = indent
  let first = true
  for (const token of tokens) {
    // A space that would open a line is dropped, not drawn as a dent.
    if (current.length === 0 && token.text === " " && raw.length > 0) continue
    if (current.length > 0 && used + token.width > width) {
      if (NO_LINE_START.has(token.text[0])) {
        // Hangs at the end of the line instead of opening the next one.
        current.push(token)
        used += token.width
        continue
      }
      const moved: Token[] = []
      while (current.length > 0 && NO_LINE_END.has(current[current.length - 1].text.slice(-1))) {
        moved.unshift(current.pop()!)
      }
      raw.push({ tokens: current, first })
      first = false
      current = moved
      used = moved.reduce((sum, t) => sum + t.width, 0)
      if (current.length === 0 && token.text === " ") continue
    }
    current.push(token)
    used += token.width
  }
  if (current.length > 0 || raw.length === 0) raw.push({ tokens: current, first })
  // No widow: a last line with one character (plus punctuation) takes one more.
  if (raw.length > 1) {
    const last = raw[raw.length - 1].tokens
    const previous = raw[raw.length - 2].tokens
    const body = last.filter((t) => !NO_LINE_START.has(t.text[0]))
    if (body.length <= 1 && previous.length > 2 && !NO_LINE_START.has(previous[previous.length - 1].text[0])) {
      last.unshift(previous.pop()!)
    }
  }
  return raw.map((line, i) => ({ ...line, last: i === raw.length - 1 }))
}

/**
 * Paragraphs from pasted text: one per line, blank lines dropped, and leading
 * spaces removed — Chinese text pasted from anywhere already carries its own
 * full-width indent, and the layout adds one.
 */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[\s　]+|[\s　]+$/g, ""))
    .filter((line) => line.length > 0)
}

export type Fit = {
  fontSize: number
  lineHeight: number
  columnWidth: number
  /** Text column width relative to the picture's width. */
  columnScale: number
  marginX: number
  marginTop: number
  marginBottom: number
  paragraphs: Line[][]
  lines: number
}

export type FitOptions = {
  /** The picture's size; the text column is laid out against it. */
  artWidth: number
  artHeight: number
  /** First paragraph continues from the previous page: no indent. */
  continued?: boolean
  indent?: boolean
}

/**
 * Sizes on a 1216 px page, scaled to the picture. The floor and the margins
 * are book.py's; the ceiling sits higher than its 40 px so that a few lines of
 * text fill the column instead of leaving most of it empty.
 */
export function sizesFor(artHeight: number) {
  return {
    maxFont: Math.round((artHeight * 60) / 1216),
    minFont: Math.max(14, Math.round((artHeight * 26) / 1216)),
    marginX: Math.round((artHeight * 88) / 1216),
    marginTop: Math.round((artHeight * 120) / 1216),
    marginBottom: Math.round((artHeight * 130) / 1216),
  }
}

const LINE_HEIGHTS = [1.9, 1.75, 1.6]
/**
 * Line length, in characters. Thirty is about what a phone held upright shows
 * comfortably and what keeps a spread narrow; fewer than fourteen and the
 * text breaks so often it stops reading as prose.
 */
export const MIN_LINE_CHARS = 14
export const MAX_LINE_CHARS = 30

/**
 * The layout whose text reads largest on a phone or tablet.
 *
 * A screen shows the whole page scaled to its width, so what the reader sees
 * is the font size relative to the page's total width, not the font size
 * itself: 41 px in a page 2400 wide reads smaller than 34 px in one 1900 wide.
 * That ratio is what gets maximised. For each font size the narrowest column
 * that holds the text is taken (a wider one only lowers the ratio), within
 * 14–30 characters a line and never wider than the picture; then the size
 * with the best ratio wins, the larger font on a tie. Leading tightens only if
 * nothing fits at all. Throws then, with an estimate of what would fit.
 */
export function fitText(text: string, measureAt: (size: number) => Measure, options: FitOptions): Fit {
  const paras = paragraphs(text)
  if (paras.length === 0) throw new Error("右侧文字不能为空")
  const s = sizesFor(options.artHeight)
  const boxHeight = options.artHeight - s.marginTop - s.marginBottom
  const indentEm = options.indent === false ? 0 : 2
  let last: { lines: number; capacity: number } | null = null

  /** The narrowest column holding the text at this size and leading, if any. */
  const tryAt = (size: number, lineHeight: number): Fit | null => {
    const measure = measureAt(size)
    const em = measure("中")
    const capacity = Math.floor(boxHeight / (size * lineHeight))
    // The picture's width bounds the column. A size whose shortest line would
    // not fit inside it is skipped for a smaller one; only at the smallest size
    // does a very narrow picture get a column a little wider than itself.
    if (MIN_LINE_CHARS * em > options.artWidth - 2 * s.marginX && size > s.minFont) return null
    const widest = Math.max(
      Math.min(options.artWidth - 2 * s.marginX, MAX_LINE_CHARS * em),
      MIN_LINE_CHARS * em,
    )
    for (let chars = MIN_LINE_CHARS; chars * em <= widest + 0.5; chars++) {
      const boxWidth = Math.ceil(chars * em)
      const laid = paras.map((p, i) =>
        layoutParagraph(p, measure, boxWidth, i === 0 && options.continued ? 0 : indentEm * em),
      )
      const lines = laid.reduce((n, p) => n + p.length, 0)
      if (lines <= capacity) {
        const columnWidth = boxWidth + 2 * s.marginX
        return {
          fontSize: size,
          lineHeight,
          columnWidth,
          columnScale: Math.round((columnWidth / options.artWidth) * 100) / 100,
          marginX: s.marginX,
          marginTop: s.marginTop,
          marginBottom: s.marginBottom,
          paragraphs: laid,
          lines,
        }
      }
      last = { lines, capacity }
    }
    return null
  }
  const onScreen = (fit: Fit) => fit.fontSize / (options.artWidth + fit.columnWidth)

  let best: Fit | null = null
  for (let size = s.maxFont; size >= s.minFont; size--) {
    const fit = tryAt(size, LINE_HEIGHTS[0])
    if (fit && (!best || onScreen(fit) > onScreen(best))) best = fit
  }
  if (best) return best
  for (const lineHeight of LINE_HEIGHTS.slice(1)) {
    const fit = tryAt(s.minFont, lineHeight)
    if (fit) return fit
  }
  const found = last as { lines: number; capacity: number } | null
  const chars = paras.join("").length
  const fits = found ? Math.floor((chars * found.capacity) / found.lines) : 0
  throw new Error(
    `文字太多放不下：共 ${chars} 字。字号降到最小、行距收到最紧、文字栏放到最宽（不超过图宽、每行至多 ${MAX_LINE_CHARS} 字）也排不下` +
      `（需要 ${found?.lines} 行，只有 ${found?.capacity} 行）。按这张图的尺寸一页大约能放 ${fits} 字，请拆成多页。`,
  )
}

export type PageOptions = {
  text: string
  background?: string
  textColor?: string
  title?: string
  pageNumber?: string
  continued?: boolean
  indent?: boolean
}

export type PageResult = { png: Buffer; width: number; height: number; fit: Fit; characters: number }

const FAMILY = "NAI Page Sans"
let registered: string | null = null

/** The bundled font. Missing is an error: no substitute font is ever used. */
export function ensureFont(path: string): string {
  if (registered === path) return FAMILY
  if (!existsSync(path)) {
    throw new Error(`排版字体不存在：${path}。在服务器上运行 mcp/fetch-font.sh 下载。`)
  }
  if (!GlobalFonts.registerFromPath(path, FAMILY)) throw new Error(`排版字体加载失败：${path}`)
  registered = path
  return FAMILY
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function rgb(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.slice(1).split("").map((c) => c + c).join("") : hex.slice(1)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/** Header and page number: the text colour pulled 55% of the way to the background. */
function muted(ink: string, paper: string): string {
  const a = rgb(ink)
  const b = rgb(paper)
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * 0.55).toString(16).padStart(2, "0")).join("")
}

/** Everything that can be refused without the picture: checked before downloading it. */
export function checkPageOptions(options: PageOptions, fontPath: string) {
  for (const [name, value] of [["background", options.background], ["textColor", options.textColor]]) {
    if (value !== undefined && !HEX.test(value)) throw new Error(`${name} 要写成 #rgb 或 #rrggbb，收到的是 ${value}`)
  }
  if (paragraphs(options.text).length === 0) throw new Error("右侧文字不能为空")
  ensureFont(fontPath)
}

export async function composePage(image: Buffer, options: PageOptions, fontPath: string): Promise<PageResult> {
  checkPageOptions(options, fontPath)
  const paper = options.background ?? "#000000"
  const ink = options.textColor ?? "#ffffff"
  let art
  try {
    art = await loadImage(image)
  } catch (error) {
    throw new Error("左侧图片无法解码：" + (error instanceof Error ? error.message : String(error)))
  }
  if (art.width < 200 || art.height < 200) throw new Error(`左侧图片太小（${art.width}×${art.height}），至少 200×200`)

  const probe = createCanvas(8, 8).getContext("2d")
  const measureAt = (size: number): Measure => {
    probe.font = `${size}px "${FAMILY}"`
    const cache = new Map<string, number>()
    return (text) => {
      let width = cache.get(text)
      if (width === undefined) {
        width = probe.measureText(text).width
        cache.set(text, width)
      }
      return width
    }
  }
  const fit = fitText(options.text, measureAt, {
    artWidth: art.width,
    artHeight: art.height,
    continued: options.continued,
    indent: options.indent,
  })

  const width = art.width + fit.columnWidth
  const height = art.height
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(art, 0, 0)

  const measure = measureAt(fit.fontSize)
  const em = measure("中")
  const boxWidth = fit.columnWidth - 2 * fit.marginX
  const boxHeight = height - fit.marginTop - fit.marginBottom
  const lineHeight = fit.fontSize * fit.lineHeight
  const textHeight = fit.lines * lineHeight
  const x0 = art.width + fit.marginX
  // Set a little above centre, as book.py does: optically centred.
  let y = fit.marginTop + Math.max(0, (boxHeight - textHeight) * 0.4)
  // Text sits in the middle of its line box rather than on a baseline guess.
  const lead = (lineHeight - fit.fontSize) / 2
  ctx.font = `${fit.fontSize}px "${FAMILY}"`
  ctx.fillStyle = ink
  ctx.textBaseline = "top"
  fit.paragraphs.forEach((lines, pi) => {
    for (const line of lines) {
      const indent = line.first && !(pi === 0 && options.continued) && options.indent !== false ? 2 * em : 0
      const natural = line.tokens.reduce((sum, t) => sum + t.width, 0)
      let gap = 0
      if (!line.last && line.tokens.length > 1) {
        const slack = boxWidth - indent - natural
        if (slack > 0 && slack < 2.2 * em) gap = slack / (line.tokens.length - 1)
      }
      let x = x0 + indent
      for (const token of line.tokens) {
        ctx.fillText(token.text, x, y + lead)
        x += token.width + gap
      }
      y += lineHeight
    }
  })

  const small = Math.max(12, Math.round((height * 22) / 1216))
  const centre = art.width + fit.columnWidth / 2
  ctx.font = `${small}px "${FAMILY}"`
  ctx.fillStyle = muted(ink, paper)
  ctx.textAlign = "center"
  if (options.title?.trim()) ctx.fillText(options.title.trim(), centre, fit.marginTop / 2 - small / 2)
  if (options.pageNumber?.trim()) {
    ctx.fillText(`— ${options.pageNumber.trim()} —`, centre, height - fit.marginBottom / 2 - small / 2)
  }

  return {
    png: canvas.toBuffer("image/png"),
    width,
    height,
    fit,
    characters: paragraphs(options.text).join("").length,
  }
}
