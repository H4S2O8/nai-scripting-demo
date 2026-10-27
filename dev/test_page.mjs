/**
 * The picture-and-text page composer.
 *
 * Layout runs against a fake measure (CJK = 1 em, Latin = half) so the
 * line-breaking rules are checked exactly; one real render then checks the
 * canvas, the font and the colours. The render needs mcp/fonts, which
 * mcp/fetch-font.sh downloads.
 *
 *   node dev/test_page.mjs      (needs mcp/node_modules and the font)
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = join(root, "mcp", "node_modules", ".cache", "nai-tests")
mkdirSync(out, { recursive: true })

function bundle(name) {
  const dest = join(out, name.replace(/[\/.]/g, "_") + ".mjs")
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle",
     "--platform=node", "--packages=external", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const P = await import(bundle("mcp/page.ts"))
const F = await import(bundle("mcp/fetchimage.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}

const EM = 10
const measure = (t) => Array.from(t).reduce((w, c) => w + (/[\x00-\x7f]/.test(c) ? EM / 2 : EM), 0)
const text = (line) => line.tokens.map((t) => t.text).join("")

console.log("tokens")
check("Latin words stay whole", JSON.stringify(P.tokenize("用Python写")) === '["用","Python","写"]')
check("…… and —— stay whole", JSON.stringify(P.tokenize("啊……——")) === '["啊","……","——"]')
check("astral characters are one token", P.tokenize("𠮷野").length === 2)

console.log("line breaking")
{
  // 10 em wide: ten characters a line.
  const lines = P.layoutParagraph("一二三四五六七八九十，后面", measure, 10 * EM, 0)
  check("a comma that would start a line hangs at the end instead", text(lines[0]) === "一二三四五六七八九十，", text(lines[0]))
  const quote = P.layoutParagraph("一二三四五六七八九「十一」", measure, 10 * EM, 0)
  check("an opening bracket never ends a line", text(quote[0]) === "一二三四五六七八九" && text(quote[1]).startsWith("「"), quote.map(text).join("|"))
  const widow = P.layoutParagraph("一二三四五六七八九十十", measure, 10 * EM, 0)
  check("a single-character last line pulls one down", text(widow[1]).length === 2, widow.map(text).join("|"))
  const indented = P.layoutParagraph("一二三四五六七八九十", measure, 10 * EM, 2 * EM)
  check("the indent takes room on the first line only", text(indented[0]).length === 8 && indented[0].first && !indented[1].first)
  check("the last line is marked", indented[1].last && !indented[0].last)
  const latin = P.layoutParagraph("abc defgh ijklmnop qrs", measure, 6 * EM, 0)
  check("no line starts with a space", latin.slice(1).every((l) => l.tokens[0].text !== " "), latin.map(text).join("|"))
}

console.log("paragraphs")
{
  const paras = P.paragraphs("　　第一段。\r\n\r\n  第二段。  \n\n\n第三段。")
  check("one per line, blank lines dropped", paras.length === 3, JSON.stringify(paras))
  check("pasted full-width indents are stripped", paras[0] === "第一段。" && paras[1] === "第二段。")
}

console.log("fitting")
const at = (size) => (t) => (measure(t) / EM) * size
{
  const art = { artWidth: 832, artHeight: 1216 }
  const s = P.sizesFor(1216)
  check("sizes on a 1216 px page", s.maxFont === 60 && s.minFont === 26 && s.marginX === 88)
  const para = "站台上的灯一盏接一盏亮起来，雨水顺着雨棚的边缘落成一道细帘。林夏把手插在风衣口袋里，看着远处的轨道慢慢没入雾里。"
  const boxChars = (f) => (f.columnWidth - 2 * f.marginX) / f.fontSize
  const onScreen = (f, a) => f.fontSize / (a.artWidth + f.columnWidth)
  const cases = {
    "short on portrait": ["雨还在下。", art],
    "medium on portrait": [Array(2).fill(para).join("\n"), art],
    "long on portrait": [Array(5).fill(para).join("\n"), art],
    "medium on landscape": [Array(3).fill(para).join("\n"), { artWidth: 1216, artHeight: 832 }],
    "long on square": [Array(5).fill(para).join("\n"), { artWidth: 1024, artHeight: 1024 }],
  }
  for (const [name, [body, a]] of Object.entries(cases)) {
    const fit = P.fitText(body, at, a)
    check(`${name}: the column is never wider than the picture`, fit.columnWidth <= a.artWidth, `${fit.columnWidth} > ${a.artWidth}`)
    check(`${name}: 14 to 30 characters a line`,
          boxChars(fit) >= P.MIN_LINE_CHARS - 0.01 && boxChars(fit) <= P.MAX_LINE_CHARS + 0.05, String(boxChars(fit)))
    // Nothing that also fits may read larger once the page is fitted to a screen.
    const sz = P.sizesFor(a.artHeight)
    let beaten = ""
    for (let size = sz.minFont; size <= sz.maxFont; size++) {
      const em = size
      for (let chars = P.MIN_LINE_CHARS; chars <= P.MAX_LINE_CHARS && chars * em + 2 * sz.marginX <= a.artWidth; chars++) {
        const box = chars * em
        const lines = P.paragraphs(body).map((p, i) => P.layoutParagraph(p, at(size), box, 2 * em).length).reduce((x, y) => x + y, 0)
        const cap = Math.floor((a.artHeight - sz.marginTop - sz.marginBottom) / (size * 1.9))
        if (lines <= cap && size / (a.artWidth + box + 2 * sz.marginX) > onScreen(fit, a) + 1e-9) beaten = `${size}px x${chars}`
      }
    }
    check(`${name}: no fitting layout reads larger on a screen`, beaten === "", `${fit.fontSize}px lost to ${beaten}`)
  }
  const short = P.fitText("雨还在下。", at, art)
  check("short text is set larger than the old 40 px ceiling", short.fontSize > 40, String(short.fontSize))
  const medium = P.fitText(Array(3).fill(para).join("\n"), at, { artWidth: 1216, artHeight: 832 })
  check("a landscape picture gets a column narrower than itself", medium.columnScale < 1, String(medium.columnScale))
  let message = ""
  try {
    P.fitText(Array(40).fill(para).join("\n"), at, art)
  } catch (error) {
    message = error.message
  }
  check("text that cannot fit is refused, not cut", /放不下/.test(message) && /一页大约能放 \d+ 字/.test(message), message)
  let narrow = null
  try { narrow = P.fitText(para, at, { artWidth: 300, artHeight: 1216 }) } catch (error) { narrow = error }
  check("a picture too narrow for 14 characters still gets a 14-character column at the smallest size",
        !(narrow instanceof Error) && narrow.fontSize === s.minFont && boxChars(narrow) >= P.MIN_LINE_CHARS - 0.01,
        narrow instanceof Error ? narrow.message : `${narrow.fontSize}px ${boxChars(narrow)}`)
  check("empty text is refused", (() => { try { P.fitText(" \n　\n", at, art); return false } catch { return true } })())
  const continued = P.fitText("接着上一页。\n新的一段。", at, { ...art, continued: true })
  check("a continued first paragraph has no indent",
        continued.paragraphs[0][0].tokens.length >= 6 && text(continued.paragraphs[0][0]).startsWith("接着上一页"))
}

console.log("addresses the composer will not fetch")
for (const [address, blocked] of [
  ["127.0.0.1", true], ["10.1.2.3", true], ["172.16.0.1", true], ["172.32.0.1", false],
  ["192.168.1.1", true], ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true],
  ["::1", true], ["fd00::1", true], ["fe80::1", true], ["::ffff:127.0.0.1", true],
  ["104.18.2.3", false], ["2606:4700::1", false],
]) {
  check(`${address} ${blocked ? "is" : "is not"} blocked`, F.isPrivateAddress(address) === blocked)
}
for (const [url, pattern] of [
  ["file:///etc/passwd", /http/],
  ["http://127.0.0.1:8787/health", /内网/],
  ["http://localhost/x.png", /内网/],
  ["not a url", /URL/],
]) {
  let message = ""
  try { await F.fetchImage(url) } catch (error) { message = error.message }
  check(`refuses ${url}`, pattern.test(message), message)
}

console.log("rendering")
const font = join(root, "mcp", "fonts", "NotoSansSC-DemiLight.otf")
if (!existsSync(font)) {
  failures++
  console.log("  FAIL the font is missing -- run mcp/fetch-font.sh")
} else {
  const { createCanvas } = await import(join(root, "mcp", "node_modules", "@napi-rs", "canvas", "index.js"))
  const art = createCanvas(400, 600)
  const actx = art.getContext("2d")
  actx.fillStyle = "#ff0000"
  actx.fillRect(0, 0, 400, 600)
  const page = await P.composePage(art.toBuffer("image/png"), { text: "雨还在下。\n她没有回头。", pageNumber: "3" }, font)
  check("the page is the picture plus a column no wider than it",
        page.width > 400 && page.width <= 800 && page.height === 600, `${page.width}x${page.height}`)
  const { loadImage } = await import(join(root, "mcp", "node_modules", "@napi-rs", "canvas", "index.js"))
  const img = await loadImage(page.png)
  const c = createCanvas(page.width, page.height)
  const ctx = c.getContext("2d")
  ctx.drawImage(img, 0, 0)
  const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
  check("the picture is on the left, untouched", JSON.stringify(px(200, 300)) === "[255,0,0]")
  check("the background is black by default", JSON.stringify(px(790, 5)) === "[0,0,0]")
  const above = ctx.getImageData(400, 0, page.width - 400, Math.floor(page.fit.marginTop)).data
  check("nothing is drawn above the text", !above.some((v, i) => i % 4 !== 3 && v !== 0))
  const tp = P.composeTitlePage({ width: page.width, height: page.height, label: "IF 1" }, font)
  const timg = await loadImage(tp.png)
  check("a title page takes the size it is given", timg.width === page.width && timg.height === page.height)
  const tc = createCanvas(timg.width, timg.height).getContext("2d")
  tc.drawImage(timg, 0, 0)
  const litIn = (x, y, w, h) => tc.getImageData(x, y, w, h).data.some((v, i) => i % 4 !== 3 && v > 40)
  check("its text sits in the middle", litIn(0, Math.round(timg.height * 0.35), timg.width, Math.round(timg.height * 0.3)))
  check("and nowhere near the edges", !litIn(0, 0, timg.width, Math.round(timg.height * 0.25)) &&
        !litIn(0, Math.round(timg.height * 0.75), timg.width, Math.round(timg.height * 0.25)))
  check("a title page needs some text", (() => { try { P.composeTitlePage({ width: 400, height: 400, label: " " }, font); return false } catch (e) { return /没有文字/.test(e.message) } })())
  const column = ctx.getImageData(400, 0, 400, 600).data
  let lit = 0
  for (let i = 0; i < column.length; i += 4) if (column[i] > 200 && column[i + 1] > 200 && column[i + 2] > 200) lit++
  check("white text was drawn in the column", lit > 200, String(lit))
  const light = await P.composePage(art.toBuffer("image/png"), { text: "白底黑字。", background: "#fff", textColor: "#222222" }, font)
  const li = await loadImage(light.png)
  const lc = createCanvas(light.width, light.height).getContext("2d")
  lc.drawImage(li, 0, 0)
  check("colours can be changed", JSON.stringify(Array.from(lc.getImageData(790, 5, 1, 1).data.slice(0, 3))) === "[255,255,255]")
  let bad = ""
  try { await P.composePage(art.toBuffer("image/png"), { text: "x", background: "black" }, font) } catch (e) { bad = e.message }
  check("a colour that is not hex is refused", /#rgb/.test(bad), bad)
  let tiny = ""
  try { await P.composePage(createCanvas(50, 50).toBuffer("image/png"), { text: "x" }, font) } catch (e) { tiny = e.message }
  check("a tiny picture is refused", /太小/.test(tiny), tiny)
  let garbage = ""
  try { await P.composePage(Buffer.from("not an image"), { text: "x" }, font) } catch (e) { garbage = e.message }
  check("an undecodable picture is refused", /无法解码/.test(garbage), garbage)
  let nofont = ""
  try { P.checkPageOptions({ text: "x" }, "/nonexistent/font.otf") } catch (e) { nofont = e.message }
  check("a missing font is an error, not a substitute", /排版字体不存在/.test(nofont), nofont)
}

console.log(failures === 0 ? "\n+ all page checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
