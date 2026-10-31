/**
 * The studio: page splitting, shots, candidate verdicts, review, and the
 * schema migration that brings the live image library up to it.
 *
 * The rules most worth pinning down are the ones that would lose work quietly:
 * a re-split that drops a page's picture, an agent picking when the person was
 * meant to, a novel page ending up with two pictures, an old database losing
 * rows on upgrade.
 *
 *   node dev/test_studio.mjs      (needs mcp/node_modules for better-sqlite3)
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync } from "node:fs"
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

const SP = await import(bundle("mcp/split.ts"))
const L = await import(bundle("mcp/library.ts"))
const S = await import(bundle("mcp/studio.ts"))
const Database = (await import(join(root, "mcp", "node_modules", "better-sqlite3", "lib", "index.js"))).default

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}
function throws(fn, pattern) {
  try {
    fn()
    return false
  } catch (error) {
    return pattern ? pattern.test(error.message) : true
  }
}

const PARA = [
  "站台上的灯一盏接一盏亮起来，雨水顺着雨棚的边缘落成一道细帘。林夏把手插在风衣口袋里，看着远处的轨道慢慢没入雾里。",
  "“你也坐这班车？有人说这趟车今晚会晚点。”有人在她身后问。",
  "她回过头，看见一个撑着黑伞的年轻人，伞面朝她这边倾了倾，自己的半边肩膀已经湿透了。“嗯，”她说，“末班车。”",
  "他笑了一下，没再说话，只是把伞又往她那边移了一点。",
  "列车进站的时候带起一阵风，把站台上的雨丝吹得斜斜的。车厢里几乎没有人，灯光发白，座椅上还留着白天的报纸。",
  "他们隔着一个座位坐下。窗外的城市一格一格往后退，像被雨水洗过的胶片。林夏忽然想起，自己已经很久没有和陌生人说过话了。",
]
const CHAPTER = Array(4).fill(PARA.join("\n")).join("\n")

console.log("splitting")
{
  const pages = SP.splitPages(CHAPTER)
  const lengths = pages.map((p) => SP.countChars(p.text))
  check("pages stay within the hard maximum", lengths.every((n) => n <= 260), lengths.join(","))
  check("pages sit near the 200-character target", Math.abs(lengths.slice(0, -1).reduce((a, b) => a + b, 0) / (lengths.length - 1) - 200) < 40, lengths.join(","))
  check("no text is lost or added", SP.joinPages(pages) === SP.splitParagraphs(CHAPTER).join("\n"))
  check("a quoted sentence is never cut", pages.every((p) => (p.text.match(/“/g) ?? []).length === (p.text.match(/”/g) ?? []).length))
  check("the first page does not continue anything", pages[0].cont === false)
  const sents = SP.sentences("他说：“走吧。快点！”然后转身。", 260)
  check("end marks inside quotes do not end the sentence", sents.length === 2 && sents[0].endsWith("”然后转身。") === false && sents[0].includes("快点！”"), JSON.stringify(sents))
  const long = SP.sentences("一" + "二，".repeat(200) + "完。", 50)
  check("an over-long sentence is cut at commas", long.length > 1 && long.every((x) => SP.countChars(x) <= 50))
  check("bad settings are refused", throws(() => SP.splitPages("x", { target: 100, min: 150, max: 200 }), /min ≤ target/))
  const old = SP.splitPages(CHAPTER)
  const fresh = SP.splitPages(CHAPTER.replace("末班车", "最后一班车"))
  const { reuse, lost } = SP.reconcile(old, fresh)
  check("an edit only replaces the page it touches", lost.length === 1 && reuse.filter(Boolean).length === fresh.length - 1, `${lost.length} lost`)
  // Two identical pages: the edited one must be the one that is lost.
  const twins = [{ text: "甲", cont: false }, { text: "乙", cont: false }, { text: "甲", cont: false }]
  const edited = [{ text: "甲改", cont: false }, { text: "乙", cont: false }, { text: "甲", cont: false }]
  const m = SP.reconcile(twins, edited)
  check("identical pages are matched by position", m.reuse[2] === twins[2] && m.lost[0] === twins[0])
}

function fresh() {
  return new S.Studio(new L.Library(":memory:"))
}
let drawn = 0
function draw(studio, shotId, project, n = 2) {
  return Array.from({ length: n }, () =>
    studio.library.add({
      key: `nai/test_${++drawn}.png`, url: `https://x.test/${drawn}.png`, stored: "r2",
      createdAt: new Date(Date.now() + drawn).toISOString(), model: "nai-diffusion-5-full", source: null,
      width: 832, height: 1216, steps: 28, guidance: 6, sampler: "k_euler_ancestral", seed: drawn,
      prompt: "p", negative: "", characters: [], transparent: 0, bytes: 1, account: "a", cost: 0,
      origin: "generate", project, tags: [], shotId,
    }).id,
  )
}

console.log("projects")
{
  const st = fresh()
  const p = st.createProject({ name: "末班车", kind: "novel", style: { prompt: "anime coloring" } })
  check("a novel project starts empty", p.kind === "novel" && p.progress.pages === 0 && p.picker === "human")
  check("a duplicate name is refused", throws(() => st.createProject({ name: "末班车", kind: "gallery" }), /已经有/))
  const u = st.updateProject("末班车", { style: { negative: "text" }, layout: { split: { target: 150, min: 100, max: 200 } } })
  check("style merges field by field", u.style.prompt === "anime coloring" && u.style.negative === "text")
  check("bad split settings are refused", throws(() => st.updateProject("末班车", { layout: { split: { target: 10, min: 50, max: 60 } } })))
  st.setCharacters("末班车", [{ key: "lin", name: "林夏", tags: "black hair", outfits: { coat: "trench coat" } }])
  const c = st.setCharacters("末班车", [{ key: "LIN", tags: "long black hair" }])
  check("a character updates by key, ignoring case, keeping other fields",
        c.characters.length === 1 && c.characters[0].name === "林夏" && c.characters[0].tags === "long black hair" && c.characters[0].outfits.coat)
  check("removing an unknown character is an error", throws(() => st.setCharacters("末班车", [], ["nobody"]), /nobody/))
  check("an unknown project is an error", throws(() => st.getProject("nope"), /没有叫/))
  check("a gallery has no chapters", (() => { st.createProject({ name: "图集", kind: "gallery" }); return throws(() => st.setChapter("图集", { chapter: 1, text: "x" }), /图集项目/) })())
}

console.log("novel pages and shots")
{
  const st = fresh()
  st.createProject({ name: "书", kind: "novel" })
  check("chapters cannot skip numbers", throws(() => st.setChapter("书", { chapter: 2, text: CHAPTER }), /第 1 章/))
  const ch = st.setChapter("书", { chapter: 1, title: "雨夜", text: CHAPTER })
  const pages = st.listPages("书")
  check("the chapter is cut into pages", ch.pages === pages.length && pages.length >= 4, String(pages.length))
  check("every page starts needing a shot", pages.every((p) => p.status === "shot" && p.shotId === null))
  check("a novel shot needs a page", throws(() => st.setShot({ project: "书", spec: { prompt: "x" } }), /pageId/))
  const shot = st.setShot({ project: "书", pageId: pages[1].id, spec: { prompt: "1girl, rain", characters: [{ prompt: "girl", x: 0.3, y: 0.5 }] } })
  check("a shot with a prompt waits to be drawn", shot.status === "draw" && shot.pageId === pages[1].id)
  check("a second shot cannot take the same page",
        throws(() => { const other = st.setShot({ project: "书", pageId: pages[2].id, spec: { prompt: "y" } }); st.setShot({ project: "书", shotId: other.id, pageId: pages[1].id, spec: {} }) }, /已经有镜头/))
  const same = st.setShot({ project: "书", pageId: pages[1].id, spec: { negative: "lowres" } })
  check("setting a page's shot again edits it", same.id === shot.id && same.prompt === "1girl, rain" && same.negative === "lowres")
  check("half a coordinate pair is refused", throws(() => st.setShot({ project: "书", pageId: pages[1].id, spec: { characters: [{ prompt: "g", x: 0.2 }] } }), /x、y/))

  const ids = draw(st, shot.id, "书", 3)
  check("drawn images are candidates", st.candidates(shot.id).every((i) => i.verdict === "candidate") && st.getShots([shot.id])[0].status === "pick")
  check("the agent may recommend", st.verdict([ids[0]], "favorite", "agent")[0].favorite === true)
  check("the agent may not pick when a person picks", throws(() => st.verdict([ids[0]], "pick", "agent"), /由人来选图/))
  st.verdict([ids[0]], "pick", "human")
  st.verdict([ids[1]], "pick", "human")
  const picked = st.candidates(shot.id).filter((i) => i.verdict === "picked")
  check("a novel shot keeps exactly one pick", picked.length === 1 && picked[0].id === ids[1])
  check("the shot is done", st.getShots([shot.id])[0].status === "done")
  check("rejecting clears the recommendation", (() => { const r = st.verdict([ids[0]], "reject", "agent")[0]; return r.verdict === "rejected" && !r.favorite })())
  check("an image outside any shot has no verdict", throws(() => st.verdict([st.library.add({ ...st.library.get([ids[2]])[0], key: "loose", shotId: null }).id], "pick", "human"), /不是任何镜头/))
  st.updateProject("书", { picker: "agent" })
  check("a project can let the agent pick", st.verdict([ids[2]], "pick", "agent")[0].verdict === "picked")

  // Re-split: the shot on an unchanged page stays; a changed page's shot detaches.
  const before = st.listPages("书")
  const keepPage = before[1]
  // Edit page 3 itself (the chapter repeats, so a plain replace could hit another page).
  const changed = SP.joinPages(before.map((p, i) => ({ text: i === 2 ? p.text.slice(0, 6) + "（改）" + p.text.slice(6) : p.text, cont: p.cont })))
  const shotOnChanged = st.listPages("书").find((p) => p.id === before[2].id).shotId
  const r = st.setChapter("书", { chapter: 1, text: changed })
  const after = st.listPages("书")
  check("an unchanged page keeps its id and its picture", after.some((p) => p.id === keepPage.id && p.status === "done"))
  check("a changed page's shot is detached, not deleted",
        r.detached.some((d) => d.shotId === shotOnChanged) && st.getShots([shotOnChanged])[0].pageId === null)
  check("page numbers run 1..n again", after.every((p, i) => p.page === i + 1))
  const rev = st.review("书")
  check("the review lists the detached shot", rev.detached.some((s) => s.id === shotOnChanged))
  const target = after.find((p) => p.shotId === null)
  st.setShot({ project: "书", shotId: shotOnChanged, pageId: target.id, spec: {} })
  check("a detached shot can be hung on a page again", st.listPages("书").find((p) => p.id === target.id).shotId === shotOnChanged)
  const rs = st.resplitChapter("书", { chapter: 1, split: { target: 120, min: 80, max: 160 }, fromPage: 3 })
  const resplit = st.listPages("书")
  check("resplit from a page keeps the pages before it", resplit[0].id === after[0].id && resplit[1].id === after[1].id)
  check("resplit makes more, shorter pages", resplit.length > after.length && rs.lengths.max <= 160, `${after.length}→${resplit.length}`)
  check("resplit does not lose text",
        SP.joinPages(resplit.map((p) => ({ text: p.text, cont: p.cont }))) === SP.joinPages(after.map((p) => ({ text: p.text, cont: p.cont }))))
}

console.log("galleries")
{
  const st = fresh()
  st.createProject({ name: "立绘", kind: "gallery" })
  check("a gallery shot needs a title", throws(() => st.setShot({ project: "立绘", spec: { prompt: "x" } }), /title/))
  check("a gallery shot has no page", throws(() => st.setShot({ project: "立绘", pageId: 1, spec: { title: "t" } }), /不挂在页上/))
  const shot = st.setShot({ project: "立绘", spec: { title: "主角正面", prompt: "1girl" } })
  const ids = draw(st, shot.id, "立绘", 3)
  st.verdict(ids.slice(0, 2), "pick", "human")
  const picked = st.candidates(shot.id).filter((i) => i.verdict === "picked")
  check("a gallery shot keeps one main image, the last picked", picked.length === 1 && picked[0].id === ids[1])
  const empty = st.setShot({ project: "立绘", spec: { title: "背景" } })
  const rev = st.review("立绘")
  check("the review lists a shot without a prompt", rev.toWrite.some((s) => s.id === empty.id))
  check("progress counts shots by status", st.getProject("立绘").progress.done === 1 && st.getProject("立绘").progress.shot === 1)
}

console.log("a gallery's mainline")
{
  const st = fresh()
  st.createProject({ name: "漫画", kind: "gallery" })
  const order = () => st.listShots("漫画").filter((s) => s.seq !== null).map((s) => s.title).join(",")
  const a = st.setShot({ project: "漫画", spec: { title: "A" } })
  const b = st.setShot({ project: "漫画", spec: { title: "B" } })
  const c = st.setShot({ project: "漫画", spec: { title: "C" } })
  check("new shots are appended in order", order() === "A,B,C" && c.seq === 3)
  const x = st.setShot({ project: "漫画", place: { before: b.id }, spec: { title: "X" } })
  check("a new shot can be inserted before another", order() === "A,X,B,C" && x.seq === 2)
  st.setShot({ project: "漫画", place: { after: c.id }, spec: { title: "Y" } })
  st.setShot({ project: "漫画", place: { at: 1 }, spec: { title: "Z" } })
  check("after a shot, and at a position", order() === "Z,A,X,B,C,Y", order())
  const sheet = st.setShot({ project: "漫画", place: false, spec: { title: "定妆" } })
  check("a shot can be kept off the mainline", sheet.seq === null && order() === "Z,A,X,B,C,Y")
  check("the list puts the mainline first, then shots off it", st.listShots("漫画").at(-1).id === sheet.id)
  st.place(c.id, { at: 1 })
  check("placing a shot on the mainline moves it", order() === "C,Z,A,X,B,Y", order())
  st.place(a.id, { at: 99 })
  check("a position past the end appends", order() === "C,Z,X,B,Y,A", order())
  st.unplace(x.id)
  check("unplacing closes the gap", order() === "C,Z,B,Y,A" && st.getShots([b.id])[0].seq === 3, order())
  st.place(sheet.id, { after: c.id })
  check("an off-line shot goes back on", order() === "C,定妆,Z,B,Y,A", order())
  check("the anchor must be on the mainline", throws(() => st.place(b.id, { before: x.id }), /不在.*主线/))
  check("only one of before / after / at", throws(() => st.place(b.id, { before: a.id, at: 1 }), /只能给一个/))
  check("a shot cannot anchor on itself", throws(() => st.place(b.id, { after: b.id }), /正在挪/))
  check("editing a shot leaves its place alone", st.setShot({ project: "漫画", shotId: b.id, spec: { prompt: "p" } }).seq === 4)
  check("progress counts the mainline", st.getProject("漫画").progress.mainline === 6 && st.getProject("漫画").progress.shots === 7)

  // A panel drawn again as a new shot, in another style: fold it back in.
  const keepIds = draw(st, b.id, "漫画", 2)
  const dupIds = draw(st, y().id, "漫画", 2)
  function y() { return st.listShots("漫画").find((s) => s.title === "Y") }
  const dupId = y().id
  st.verdict([dupIds[1]], "pick", "human")
  st.comment("漫画", { target: "shot", targetId: dupId, body: "这格换新画风", author: "human" })
  const merged = st.merge(b.id, [dupId])
  check("merging moves the images over as candidates", merged.counts.candidate + merged.counts.picked === 4)
  check("with no main image yet, the other shot's pick becomes it",
        st.candidates(b.id).find((i) => i.verdict === "picked")?.id === dupIds[1])
  check("the merged shot is gone and off the mainline", throws(() => st.getShots([dupId]), /没有/) && order() === "C,定妆,Z,B,A", order())
  check("its feedback follows", st.feedbackOn("漫画", [{ target: "shot", id: b.id }]).some((f) => f.body === "这格换新画风"))
  const other = st.setShot({ project: "漫画", spec: { title: "W" } })
  const w = draw(st, other.id, "漫画", 1)
  st.verdict(w, "pick", "human")
  st.merge(b.id, [other.id])
  const after = st.candidates(b.id)
  check("a pick from the merged shot does not replace the main image",
        after.find((i) => i.verdict === "picked")?.id === dupIds[1] && after.find((i) => i.id === w[0])?.verdict === "candidate" && after.find((i) => i.id === w[0])?.favorite)
  check("merging needs another shot", throws(() => st.merge(b.id, [b.id]), /别的镜头/))
  st.createProject({ name: "别处", kind: "gallery" })
  const elsewhere = st.setShot({ project: "别处", spec: { title: "E" } })
  check("merging across projects is refused", throws(() => st.merge(b.id, [elsewhere.id]), /不是/))
}

console.log("several shots at once")
{
  const st = fresh()
  st.createProject({ name: "多格", kind: "gallery" })
  const order = () => st.listShots("多格").filter((s) => s.seq !== null).map((s) => s.title).join(",")
  const [a, b, c] = st.setShots("多格", ["A", "B", "C"].map((title) => ({ spec: { title } })))
  check("new shots are appended in the order given", order() === "A,B,C" && c.seq === 3)
  const made = st.setShots("多格", [{ spec: { title: "X" } }, { spec: { title: "Y" } }], { after: a.id })
  check("placed as one block, in order", order() === "A,X,Y,B,C" && made.map((s) => s.seq).join() === "2,3", order())
  st.setShots("多格", [{ spec: { title: "s1" } }, { spec: { title: "s2" } }], false)
  check("a batch can stay off the mainline", order() === "A,X,Y,B,C" && st.listShots("多格").length === 7)
  const edited = st.setShots("多格", [{ shotId: a.id, spec: { prompt: "pa" } }, { shotId: c.id, spec: { prompt: "pc" } }])
  check("editing several leaves their places alone", edited.map((s) => s.prompt).join() === "pa,pc" && order() === "A,X,Y,B,C")
  check("a batch is all or nothing", throws(() => st.setShots("多格", [{ spec: { title: "ok" } }, { spec: { prompt: "no title" } }]), /title/) &&
        !st.listShots("多格").some((s) => s.title === "ok"))
  check("the same shot twice in a batch is refused", throws(() => st.setShots("多格", [{ shotId: a.id, spec: {} }, { shotId: a.id, spec: {} }]), /不止一次/))
  st.place([c.id, b.id], { at: 1 })
  check("place moves several as a block, in the order given", order() === "C,B,A,X,Y", order())
  check("the anchor cannot be one of the shots moving", throws(() => st.place([a.id, b.id], { before: b.id }), /正在挪/))
  st.unplace([made[0].id, made[1].id])
  check("unplace takes several off", order() === "C,B,A", order())
  const all = st.order("多格", [a.id, made[1].id, c.id])
  check("order rewrites the whole mainline", order() === "A,Y,C" && all.filter((s) => s.seq === null).length === 4, order())
  check("order with duplicates is refused", throws(() => st.order("多格", [a.id, a.id]), /重复/))
  st.createProject({ name: "别的", kind: "gallery" })
  const stranger = st.setShot({ project: "别的", spec: { title: "Z" } })
  check("order with another project's shot is refused", throws(() => st.order("多格", [a.id, stranger.id]), /不是|不属于/))
  check("place across projects is refused", throws(() => st.place([a.id, stranger.id]), /不是/))
  check("an unknown shot is refused, nothing changes", throws(() => st.place([a.id, 99999], { at: 1 }), /没有/) && order() === "A,Y,C")
  st.order("多格", [])
  check("an empty order empties the mainline", order() === "")
}

console.log("a novel has no mainline")
{
  const st = fresh()
  st.createProject({ name: "书2", kind: "novel" })
  st.setChapter("书2", { chapter: 1, text: CHAPTER })
  const pageId = st.listPages("书2")[0].id
  const shot = st.setShot({ project: "书2", pageId, spec: { prompt: "p" } })
  check("a novel shot has no place", shot.seq === null)
  check("placing a novel shot is refused", throws(() => st.place(shot.id), /只有图集/))
  check("set with a place is refused in a novel", throws(() => st.setShot({ project: "书2", pageId, place: {}, spec: {} }), /只有图集/))
  const ids = draw(st, shot.id, "书2", 2)
  check("a shot on a page cannot be merged away", throws(() => st.merge(st.setShot({ project: "书2", pageId: st.listPages("书2")[1].id, spec: { prompt: "q" } }).id, [shot.id]), /挂在页/))
  void ids
}

console.log("feedback")
{
  const st = fresh()
  st.createProject({ name: "书", kind: "novel" })
  const f = st.comment("书", { target: "image", targetId: 5, body: "手画坏了，重抽", author: "human" })
  check("a person's comment shows in the review", st.review("书").feedback.some((x) => x.id === f.id))
  check("a comment on an image needs its id", throws(() => st.comment("书", { target: "image", body: "x", author: "human" }), /targetId/))
  st.comment("书", { target: "project", body: "已重抽", author: "agent" })
  check("the agent's own notes are not its to-do", st.review("书").feedback.length === 1)
  st.resolve("书", [f.id])
  check("resolved feedback leaves the review", st.review("书").feedback.length === 0)
  check("resolving twice is an error", throws(() => st.resolve("书", [f.id]), /已经解决/))
}

console.log("side stories")
{
  const st = fresh()
  st.createProject({ name: "雨夜", kind: "novel" })
  st.setChapter("雨夜", { chapter: 1, text: "雨还在下。\n她没有回头。" })
  st.setChapter("雨夜", { chapter: 2, text: "第二章。" })
  const extra = st.setChapter("雨夜", { chapter: 3, title: "如果她回头", route: " IF 1 ", text: "她回头了。\n他愣住。" })
  check("a chapter can open a side story, its label trimmed", extra.route === "IF 1")
  check("the chapter after a side story must say where it belongs",
        throws(() => st.setChapter("雨夜", { chapter: 4, text: "接着。" }), /route/))
  st.setChapter("雨夜", { chapter: 4, route: "IF 1", text: "接着 IF 1。" })
  st.setChapter("雨夜", { chapter: 5, title: "另一条路", route: "IF 2", text: "IF 2 开始。" })
  check("the main story cannot follow a side story",
        throws(() => st.setChapter("雨夜", { chapter: 6, route: "", text: "正文？" }), /正文/))
  check("a side story's chapters stay together",
        throws(() => st.setChapter("雨夜", { chapter: 6, route: "IF 1", text: "回到 IF 1？" }), /连在一起/))
  check("nothing was written by a refused chapter", st.listPages("雨夜").every((p) => p.chapter <= 5))
  check("a long label is refused", throws(() => st.setChapterInfo("雨夜", { chapter: 5, route: "一二三四五六七八九十一二三四五六七" }), /16/))
  check("moving a middle chapter out of the main story is refused",
        throws(() => st.setChapterInfo("雨夜", { chapter: 1, route: "IF 0" }), /正文/))
  const pages = st.listPages("雨夜")
  const by = (chapter) => pages.filter((p) => p.chapter === chapter)
  check("the main story counts on", JSON.stringify(by(2).map((p) => [p.route, p.routePage])) === JSON.stringify([["", by(1).length + 1]]))
  check("a side story counts from 1 across its chapters",
        by(3)[0].routePage === 1 && by(4)[0].routePage === by(3).length + 1 && by(5)[0].routePage === 1)
  check("one chapter's pages keep their place in the story", st.listPages("雨夜", { chapter: 4 })[0].routePage === by(3).length + 1)
  check("the footer names the side story", S.pageFooter(by(4)[0]) === `IF 1 · ${by(3).length + 1}` && S.pageFooter(by(2)[0]) === "2")
  const detail = st.pageDetail(by(4)[0].id).page
  check("a page knows its side story and its title", detail.route === "IF 1" && detail.routeTitle === "如果她回头")
  check("the overview carries routes", st.novelOverview("雨夜").map((c) => c.route).join(",") === ",,IF 1,IF 1,IF 2")
}

console.log("migrating the live library")
{
  // The schema as first deployed: no user_version, no studio tables.
  const dir = mkdtempSync(join(tmpdir(), "nai-migrate-"))
  const path = join(dir, "library.db")
  const v1 = new Database(path)
  v1.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE images (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, url TEXT, stored TEXT NOT NULL CHECK (stored IN ('r2','local','archive')), created_at TEXT NOT NULL,
      model TEXT, source TEXT, width INTEGER, height INTEGER, steps INTEGER, guidance REAL, sampler TEXT, seed INTEGER,
      prompt TEXT NOT NULL DEFAULT '', negative TEXT NOT NULL DEFAULT '', characters TEXT NOT NULL DEFAULT '[]', transparent REAL,
      bytes INTEGER, account TEXT, cost INTEGER, origin TEXT NOT NULL CHECK (origin IN ('generate','backfill')),
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, note TEXT NOT NULL DEFAULT '');
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE image_tags (image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (image_id, tag_id)) WITHOUT ROWID;
    INSERT INTO projects (name, description, created_at) VALUES ('图库测试', 'old', '2026-10-23');
    INSERT INTO images (key, stored, created_at, prompt, origin, project_id, note) VALUES ('nai/a.png', 'r2', '2026-10-23', 'fox', 'generate', 1, 'kept');
    INSERT INTO tags (name) VALUES ('动物'); INSERT INTO image_tags VALUES (1, 1);
  `)
  v1.close()
  const lib = new L.Library(path)
  const st = new S.Studio(lib)
  const row = lib.get([1])[0]
  check("old images survive the upgrade", row.prompt === "fox" && row.note === "kept" && row.tags[0] === "动物" && row.project === "图库测试")
  check("old images have no verdict", row.verdict === null && row.shotId === null && row.favorite === false)
  check("old projects become galleries picked by a person", st.getProject("图库测试").kind === "gallery" && st.getProject("图库测试").picker === "human")
  check("the version is recorded", lib.handle.pragma("user_version", { simple: true }) === 6)
  check("chapters gain a route, composed pages a size", ["route"].every((c) =>
        lib.handle.prepare("SELECT 1 FROM pragma_table_info('chapters') WHERE name = ?").get(c)) &&
        ["width", "height"].every((c) => lib.handle.prepare("SELECT 1 FROM pragma_table_info('page_renders') WHERE name = ?").get(c)))
  check("the publishing tables exist", ["mascots", "publications", "page_renders"].every((t) =>
        lib.handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)))
  check("old images gain an empty thumbnail link", row.thumbUrl === null)
  lib.close()
  const again = new L.Library(path)
  check("opening an upgraded library again changes nothing", again.get([1])[0].prompt === "fox")
  again.close()
}

console.log("upgrading a gallery to the mainline")
{
  const dir = mkdtempSync(join(tmpdir(), "nai-mainline-"))
  const path = join(dir, "library.db")
  const lib = new L.Library(path)
  const st = new S.Studio(lib)
  st.createProject({ name: "旧图集", kind: "gallery" })
  const one = st.setShot({ project: "旧图集", spec: { title: "一" } })
  const two = st.setShot({ project: "旧图集", spec: { title: "二" } })
  const ids = draw(st, one.id, "旧图集", 3)
  // As version 5 left it: no mainline, and a gallery shot with several picks.
  lib.handle.exec("ALTER TABLE shots DROP COLUMN seq")
  lib.handle.prepare(`UPDATE images SET verdict = 'picked' WHERE id IN (${ids.join(",")})`).run()
  lib.handle.pragma("user_version = 5")
  lib.close()
  const up = new L.Library(path)
  const st2 = new S.Studio(up)
  const shots = st2.listShots("旧图集")
  check("existing shots join the mainline in the order they were made", shots.map((s) => `${s.id}:${s.seq}`).join(",") === `${one.id}:1,${two.id}:2`)
  const imgs = st2.candidates(one.id)
  check("the newest pick stays the main image", imgs.filter((i) => i.verdict === "picked").map((i) => i.id).join() === String(ids[2]))
  check("the other picks become starred candidates", ids.slice(0, 2).every((id) => { const i = imgs.find((x) => x.id === id); return i.verdict === "candidate" && i.favorite }))
  up.close()
}

console.log(failures === 0 ? "\n+ all studio checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
