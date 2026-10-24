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
  check("a gallery shot keeps several picks", st.candidates(shot.id).filter((i) => i.verdict === "picked").length === 2)
  const empty = st.setShot({ project: "立绘", spec: { title: "背景" } })
  const rev = st.review("立绘")
  check("the review lists a shot without a prompt", rev.toWrite.some((s) => s.id === empty.id))
  check("progress counts shots by status", st.getProject("立绘").progress.done === 1 && st.getProject("立绘").progress.shot === 1)
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
  check("the version is recorded", lib.handle.pragma("user_version", { simple: true }) === 2)
  lib.close()
  const again = new L.Library(path)
  check("opening an upgraded library again changes nothing", again.get([1])[0].prompt === "fox")
  again.close()
}

console.log(failures === 0 ? "\n+ all studio checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
