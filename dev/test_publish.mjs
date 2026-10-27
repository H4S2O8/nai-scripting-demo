/**
 * Publishing to E-Hentai, against a recording stand-in for the publisher MCP.
 *
 * What would go wrong quietly: uploading images in the wrong order, sending an
 * archived image the publisher cannot fetch, a GURO gallery without its
 * gender, a cover spec or setting that never reaches the publisher, and a
 * novel recomposing every page on every attempt.
 *
 *   node dev/test_publish.mjs      (needs mcp/node_modules and the font)
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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

const L = await import(bundle("mcp/library.ts"))
const S = await import(bundle("mcp/studio.ts"))
const T = await import(bundle("mcp/thumbs.ts"))
const P = await import(bundle("mcp/publish.ts"))
const { createCanvas } = await import(join(root, "mcp", "node_modules", "@napi-rs", "canvas", "index.js"))
const FONT = join(root, "mcp", "fonts", "NotoSansSC-DemiLight.otf")

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}
async function rejects(fn, pattern) {
  try {
    await fn()
    return false
  } catch (error) {
    return pattern.test(error.message)
  }
}

function png(width, height, colour = "#3060c0") {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer("image/png")
}

const dir = mkdtempSync(join(tmpdir(), "nai-publish-"))
const lib = new L.Library(join(dir, "library.db"))
const st = new S.Studio(lib)
let n = 0
let storeGate = null
/** An image on "R2", with its file on this server's disk so pages can be composed. */
function image(project, shotId, extra = {}) {
  n++
  const file = `nai_20261025_000000_${n}_${String(n).padStart(16, "0")}.png`
  writeFileSync(join(dir, file), png(300, 450))
  return lib.add({
    key: "nai/" + file, url: `https://preview.example/nai/${file}`, stored: "r2",
    createdAt: new Date(Date.now() + n).toISOString(), model: "m", source: null, width: 300, height: 450,
    steps: 28, guidance: 6, sampler: "s", seed: n, prompt: "p", negative: "", characters: [], transparent: 0,
    bytes: 1, account: "a", cost: 0, origin: "generate", project, tags: [], shotId, ...extra,
  }).id
}

const calls = []
let job = { state: "prepared", cover: { preview_url: "https://x/c.png" } }
const eh = {
  async call(name, args) {
    calls.push({ name, args })
    if (name === "preview_cover") return { json: { width: 300 }, image: Buffer.from([0xff, 0xd8, 0xff]) }
    if (name === "prepare_gallery") return { json: { id: "job" + calls.length, state: "queued" }, image: null }
    if (name === "get_job") return { json: { id: args.job_id, ...job }, image: null }
    return { json: { ok: true, name }, image: null }
  },
}
const stored = []
const store = async (name, body, type) => {
  if (storeGate) await storeGate
  stored.push({ name, bytes: body.length, type })
  return `https://preview.example/nai-${name}`
}
const thumbs = new T.Thumbs(dir, () => FONT, () => lib)
let configured = true
const pub = new P.Publisher(() => lib, thumbs, () => FONT, () => (configured ? eh : null), store)

async function settled(id) {
  for (let i = 0; i < 200; i++) {
    const row = lib.handle.prepare("SELECT state, eh_job_id, error FROM publications WHERE id = ?").get(id)
    if (row.state === "failed" || row.eh_job_id) return row
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("publication never settled")
}

console.log("what a gallery uploads")
st.createProject({ name: "画集", kind: "gallery" })
const shotA = st.setShot({ project: "画集", spec: { title: "第一个", prompt: "a" } })
const shotB = st.setShot({ project: "画集", spec: { title: "第二个", prompt: "b" } })
const a1 = image("画集", shotA.id), a2 = image("画集", shotA.id), b1 = image("画集", shotB.id)
st.verdict([a1, a2, b1], "pick", "human")
const loose = image("画集", null)
const archived = image("画集", null, { stored: "archive", url: null })
{
  const c = pub.candidates("画集")
  check("picked images come first, oldest shot first, in pick order",
        JSON.stringify(c.filter((x) => x.selected).map((x) => x.imageId)) === JSON.stringify([a1, a2, b1]),
        JSON.stringify(c.map((x) => x.imageId)))
  check("loose images are offered but not selected", c.some((x) => x.imageId === loose && !x.selected && !x.blocked))
  check("an archived image is blocked, with the reason", c.some((x) => x.imageId === archived && /Mac 备份/.test(x.blocked ?? "")))
}

console.log("refusals before anything starts")
const good = { title: "My Gallery", coverStyle: "ai" }
check("an empty selection", await rejects(() => pub.start("画集", [], good), /没有选/))
check("a missing title", await rejects(() => pub.start("画集", [{ imageId: a1 }], { ...good, title: " " }), /标题/))
check("GURO without a gender", await rejects(() => pub.start("画集", [{ imageId: a1 }], { ...good, coverStyle: "ai_guro" }), /性别/))
check("an image from elsewhere", await rejects(() => pub.start("画集", [{ imageId: 99999 }], good), /不在这个项目/))
check("an archived image", await rejects(() => pub.start("画集", [{ imageId: archived }], good), /不在这个项目/))
configured = false
check("no E-Hentai service configured", await rejects(() => pub.start("画集", [{ imageId: a1 }], good), /EH_MCP_URL/))
configured = true
check("nothing was sent to the publisher for any of these", calls.length === 0)

console.log("preparing a gallery")
{
  const spec = { mascot: { url: "https://preview.example/m.png", position: "top-left" } }
  const id = pub.start("画集", [{ imageId: b1 }, { imageId: loose }, { imageId: a1 }],
                       { ...good, description: "d", coverSpec: spec, backgroundImageId: loose, acceptSiteTerms: true })
  const row = await settled(id)
  check("it settles with the publisher's job id", row.eh_job_id && !row.error, JSON.stringify(row))
  const prep = calls.find((c) => c.name === "prepare_gallery").args
  check("images go in the chosen order", JSON.stringify(prep.image_urls) ===
        JSON.stringify([b1, loose, a1].map((i) => lib.get([i])[0].url)), JSON.stringify(prep.image_urls))
  check("the cover spec reaches the publisher untouched", JSON.stringify(prep.cover_spec) === JSON.stringify(spec))
  check("the background is the chosen image's original", prep.cover_background_url === lib.get([loose])[0].url)
  check("settings map onto the publisher's fields",
        prep.title === "My Gallery" && prep.description === "d" && prep.accept_site_terms === true &&
        prep.language === "No Text" && prep.cover_style === "ai" && prep.guro_gender === null)
  check("the settings become the project's defaults", pub.settings("画集").coverSpec?.mascot?.position === "top-left")
  const status = await pub.status(id)
  check("status carries the publisher's view", status.job.state === "prepared" && status.items.length === 3)
}

console.log("after preparing")
{
  const id = pub.publications("画集")[0].id
  calls.length = 0
  await pub.update(id, { title: "Renamed", coverSpec: null, coverStyle: "ai_guro", guroGender: "female" })
  const args = calls.find((c) => c.name === "update_gallery").args
  check("an edit sends only what changed, and a cleared spec as {}",
        args.title === "Renamed" && JSON.stringify(args.cover_spec) === "{}" && args.cover_style === "ai_guro" &&
        args.guro_gender === "female" && !("description" in args), JSON.stringify(args))
  await pub.createDraft(id)
  check("a draft is the publisher's create_draft for this job", calls.at(-1).name === "create_draft" && calls.at(-1).args.job_id)
  check("a link that is not a gallery is refused", await rejects(() => pub.linkPublished(id, "https://example.com/g/1/abc/"), /画廊链接/))
  await pub.linkPublished(id, "https://e-hentai.org/g/1234567/abcdef1234/")
  check("a gallery link goes to apply_required_tags", calls.at(-1).name === "apply_required_tags" &&
        calls.at(-1).args.gallery_url === "https://e-hentai.org/g/1234567/abcdef1234/")
}

console.log("a novel uploads its composed pages")
{
  st.createProject({ name: "小说", kind: "novel" })
  st.setChapter("小说", { chapter: 1, text: "雨还在下。她没有回头。\n他把伞往她那边倾了倾。" })
  st.setChapter("小说", { chapter: 2, text: "第二章开头。" })
  const pages = st.listPages("小说")
  const picks = []
  for (const page of pages.slice(0, 1)) {
    const shot = st.setShot({ project: "小说", pageId: page.id, spec: { prompt: "rain" } })
    const img = image("小说", shot.id)
    st.verdict([img], "pick", "human")
    picks.push({ pageId: page.id, imageId: img })
  }
  const c = pub.candidates("小说")
  check("a page without a pick is listed but blocked", c.some((x) => x.pageId === pages[1].id && /还没选图/.test(x.blocked ?? "")))
  check("a page with a pick is selected", c.some((x) => x.pageId === picks[0].pageId && x.selected))
  stored.length = 0
  calls.length = 0
  const first = await settled(pub.start("小说", picks, { title: "雨夜", coverStyle: "ai" }))
  check("the first attempt composes and stores the page", !first.error && stored.length === 1 && stored[0].name.startsWith("pages/"), JSON.stringify([first, stored]))
  const prep = calls.find((c) => c.name === "prepare_gallery").args
  check("the publisher gets the composed page, not the bare picture", prep.image_urls[0].includes("nai-pages/"))
  check("a novel defaults to Chinese", prep.language === "Chinese")
  await settled(pub.start("小说", picks, { title: "雨夜 2", coverStyle: "ai" }))
  check("a second attempt reuses the composed page", stored.length === 1)
  check("a blocked page cannot be smuggled in", await rejects(() => pub.start("小说", [{ pageId: pages[1].id, imageId: 0 }], good), /不能上传/))
}

console.log("progress")
{
  const id = pub.publications("画集")[0].id
  job = { state: "prepared" }
  check("nothing to show once prepared: it waits on the person", (await pub.status(id)).bar === null)
  job = { state: "downloading", downloaded: 2, artwork_count: 3 }
  let b = (await pub.status(id)).bar
  check("a gallery has no compose step", JSON.stringify(b.steps) === JSON.stringify(["下载图片", "生成封面", "上传草稿"]))
  check("downloading counts images", b.step === 0 && b.done === 2 && b.total === 3 && b.unit === "image", JSON.stringify(b))
  job = { state: "rendering_cover" }
  b = (await pub.status(id)).bar
  check("the cover cannot be measured", b.step === 1 && b.total === undefined)
  job = { state: "uploading", upload_bytes: 5_000_000, upload_total: 20_000_000 }
  b = (await pub.status(id)).bar
  check("uploading counts bytes", b.step === 2 && b.done === 5_000_000 && b.total === 20_000_000 && b.unit === "byte")
  job = { state: "uploading", upload_bytes: 20_000_000, upload_total: 20_000_000 }
  b = (await pub.status(id)).bar
  check("all bytes sent: waiting on the site, unmeasured", b.total === undefined && /核对/.test(b.label))
  job = { state: "draft_ready" }
  check("a ready draft has no bar", (await pub.status(id)).bar === null)
  job = { state: "prepared", cover: { preview_url: "https://x/c.png" } }

  const picks = pub.candidates("小说").filter((c) => c.selected).map(({ pageId, imageId }) => ({ pageId, imageId }))
  // Forget the composed pages so this attempt composes, and hold it at the upload to R2.
  lib.handle.prepare("DELETE FROM page_renders").run()
  let open
  storeGate = new Promise((resolve) => (open = resolve))
  const novel = pub.start("小说", picks, { title: "雨夜 3", coverStyle: "ai", description: "fresh" })
  await new Promise((r) => setTimeout(r, 50))
  b = (await pub.status(novel)).bar
  check("a novel starts with composing its pages", b && b.steps[0] === "合成页面" && b.step === 0 && b.unit === "page" &&
        b.total === picks.length, JSON.stringify(b))
  open()
  storeGate = null
  await settled(novel)
  lib.handle.prepare("UPDATE publications SET state = 'composing', eh_job_id = NULL WHERE id = ?").run(novel)
  b = (await pub.status(novel)).bar
  check("composing that this process is not doing says it stopped", /重新开始准备/.test(b.label) && b.total === undefined)
}

console.log("side stories")
{
  st.createProject({ name: "番外书", kind: "novel" })
  st.setChapter("番外书", { chapter: 1, text: "正文。" })
  st.setChapter("番外书", { chapter: 2, title: "如果", route: "IF 1", text: "IF 1 的一页。" })
  st.setChapter("番外书", { chapter: 3, route: "IF 2", text: "IF 2 的一页。" })
  const picks = st.listPages("番外书").map((page) => {
    const shot = st.setShot({ project: "番外书", pageId: page.id, spec: { prompt: "p" } })
    const img = image("番外书", shot.id)
    st.verdict([img], "pick", "human")
    return { pageId: page.id, imageId: img }
  })
  const c = pub.candidates("番外书")
  check("candidates carry their side story", c.map((x) => x.route).join(",") === ",IF 1,IF 2" && /^IF 1 · /.test(c[1].label))
  calls.length = 0
  stored.length = 0
  const id = pub.start("番外书", picks, { title: "番外书", coverStyle: "ai", description: "简介。" })
  await settled(id)
  const prep = calls.find((x) => x.name === "prepare_gallery").args
  const kinds = prep.image_urls.map((u) => (u.includes("pages/title-") ? "title" : "page"))
  check("the upload is page, then each side story's title page and pages, with no END page",
        JSON.stringify(kinds) === JSON.stringify(["page", "title", "page", "title", "page"]), JSON.stringify(prep.image_urls))
  check("each composed page and title page reached R2", stored.length === 5, JSON.stringify(stored.map((x) => x.name)))
  check("the table of contents counts the cover as page 1",
        prep.description === "简介。\n\n目录\n正文 p.2\nIF 1「如果」p.3–4\nIF 2 p.5–6", JSON.stringify(prep.description))
  calls.length = 0
  await pub.update(id, { description: "新简介。" })
  check("a new description keeps the table of contents",
        calls.at(-1).args.description === "新简介。\n\n目录\n正文 p.2\nIF 1「如果」p.3–4\nIF 2 p.5–6")
  calls.length = 0
  await settled(pub.start("番外书", picks.slice(1), { title: "只有番外", coverStyle: "ai", toc: false }))
  const only = calls.find((x) => x.name === "prepare_gallery").args
  check("side stories alone: a title page each, and no contents when turned off",
        only.image_urls.length === 4 && only.description === "", JSON.stringify(only))
  calls.length = 0
  await settled(pub.start("番外书", picks.slice(0, 1), { title: "只有正文", coverStyle: "ai" }))
  const plain = calls.find((x) => x.name === "prepare_gallery").args
  check("the main story alone is just its pages", plain.image_urls.length === 1 && plain.description === "")
}

console.log("cover preview and mascots")
{
  const preview = await pub.previewCover({ backgroundImageId: a1, coverStyle: "ai", coverSpec: { panel: { position: "top" } } })
  check("a preview returns the publisher's image", preview.image[0] === 0xff)
  check("an archived background is refused", await rejects(() => pub.previewCover({ backgroundImageId: archived, coverStyle: "ai" }), /线上没有原图/))
  check("a tiny mascot is refused", await rejects(() => pub.uploadMascot("小", png(60, 60)), /太小/))
  check("something that is not an image is refused", await rejects(() => pub.uploadMascot("x", Buffer.from("hello")), /PNG、WebP 或 JPEG/))
  stored.length = 0
  const m = await pub.uploadMascot("我的吉祥物", png(200, 300))
  check("a mascot is stored and listed", stored[0]?.name.startsWith("assets/mascots/") && m.width === 200 &&
        pub.mascots().some((x) => x.name === "我的吉祥物"))
  const fromLib = pub.mascotFromImage("", a2)
  check("a library image can be a mascot", fromLib.url === lib.get([a2])[0].url)
  check("an archived image cannot", await rejects(async () => pub.mascotFromImage("", archived), /线上没有原图/))
  pub.removeMascot(m.id)
  check("a removed mascot leaves the list", !pub.mascots().some((x) => x.id === m.id))
}

lib.close()
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\n+ all publish checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
