/**
 * The review web page: who gets in, and what the API lets them do.
 *
 * The part that matters most is the door. Cloudflare Access tokens are
 * verified for signature, audience, issuer and expiry, sessions are signed and
 * expire, and without either the answer is no. Then a real server is started
 * and the review flow driven through it — a pick made in the page must be the
 * pick the agent sees.
 *
 *   node dev/test_web.mjs      (needs mcp/node_modules, a built mcp/dist and the font)
 */
import { execFileSync, spawn } from "node:child_process"
import { generateKeyPairSync, createSign } from "node:crypto"
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

const W = await import(bundle("mcp/webauth.ts"))
const L = await import(bundle("mcp/library.ts"))
const S = await import(bundle("mcp/studio.ts"))
const { createCanvas } = await import(join(root, "mcp", "node_modules", "@napi-rs", "canvas", "index.js"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}

const SECRET = "test-secret-" + "x".repeat(40)

console.log("sessions")
{
  const auth = new W.WebAuth(SECRET)
  const cookie = auth.sessionCookie().split(";")[0]
  const req = (headers) => ({ headers })
  check("a fresh session cookie lets you in", (await auth.visitor(req({ cookie })))?.via === "session")
  check("the cookie is HttpOnly, Secure and SameSite=Strict",
        /HttpOnly/.test(auth.sessionCookie()) && /Secure/.test(auth.sessionCookie()) && /SameSite=Strict/.test(auth.sessionCookie()))
  const [name, value] = cookie.split("=")
  const [payload, mac] = value.split(".")
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 10 ** 12 })).toString("base64url")
  check("a payload with someone else's signature is refused", (await auth.visitor(req({ cookie: `${name}=${forged}.${mac}` }))) === null)
  check("a session signed with another key is refused",
        (await new W.WebAuth("another-secret").visitor(req({ cookie }))) === null)
  const old = auth.sessionCookie(Date.now() - 91 * 86400_000).split(";")[0]
  check("an expired session is refused", (await auth.visitor(req({ cookie: old }))) === null)
  check("the bearer key works for scripts", (await auth.visitor(req({ authorization: "Bearer " + SECRET })))?.via === "bearer")
  check("a wrong bearer key does not", (await auth.visitor(req({ authorization: "Bearer nope" }))) === null)
  check("nothing at all gets nothing", (await auth.visitor(req({}))) === null)
  check("an Access header is ignored when Access is not configured",
        (await auth.visitor(req({ "cf-access-jwt-assertion": "a.b.c" }))) === null)

  check("the right key logs in", auth.login(SECRET, "1.2.3.4") === "ok")
  for (let i = 0; i < 10; i++) auth.login("wrong", "5.6.7.8")
  check("ten wrong tries lock that address", auth.login(SECRET, "5.6.7.8") === "locked")
  check("other addresses are unaffected", auth.login(SECRET, "9.9.9.9") === "ok")
  check("the lock lifts after ten minutes", auth.login(SECRET, "5.6.7.8", Date.now() + 601_000) === "ok")
  check("Access settings must come as a pair", (() => {
    process.env.CF_ACCESS_TEAM = "team"
    delete process.env.CF_ACCESS_AUD
    try { W.WebAuth.fromEnv(SECRET); return false } catch { return true } finally { delete process.env.CF_ACCESS_TEAM }
  })())
}

console.log("the web password")
{
  const hash = W.hashPassword("correct horse battery")
  check("only a hash is kept, never the password", hash.startsWith("scrypt$") && !hash.includes("correct horse"))
  check("the same password hashes differently each time (salted)", W.hashPassword("correct horse battery") !== hash)
  check("the right password checks out", W.checkPassword("correct horse battery", hash))
  check("a wrong one does not", !W.checkPassword("correct horse batterY", hash))
  const auth = new W.WebAuth(SECRET, null, hash)
  check("the login asks for the password", auth.usesPassword)
  check("the password logs in", auth.login("correct horse battery", "1.1.1.1") === "ok")
  check("the MCP key no longer logs in to the page", auth.login(SECRET, "1.1.1.2") === "wrong")
  check("the MCP key still works as a bearer for scripts", (await auth.visitor({ headers: { authorization: "Bearer " + SECRET } }))?.via === "bearer")
  const before = new W.WebAuth(SECRET, null, W.hashPassword("old password here")).sessionCookie().split(";")[0]
  check("changing the password signs existing sessions out", (await auth.visitor({ headers: { cookie: before } })) === null)
  const broken = new W.WebAuth(SECRET, null, "not-a-hash")
  check("a malformed hash refuses every login, saying why",
        broken.login("anything", "2.2.2.2") === "misconfigured" && /格式不对/.test(broken.passwordProblem))
}

console.log("Cloudflare Access tokens")
{
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const auth = new W.WebAuth(SECRET, { team: "acme", aud: "aud-123" })
  auth.setAccessKeyForTest("k1", publicKey)
  const now = Math.floor(Date.now() / 1000)
  const jwt = (claims, { kid = "k1", key = privateKey, alg = "RS256" } = {}) => {
    const head = Buffer.from(JSON.stringify({ alg, kid })).toString("base64url")
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url")
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url")
    return `${head}.${body}.${sig}`
  }
  const good = { aud: ["aud-123"], iss: "https://acme.cloudflareaccess.com", exp: now + 600, email: "me@example.com" }
  check("a valid Access token passes, with its email", (await auth.verifyAccess(jwt(good))) === "me@example.com")
  check("it lets you in through the header",
        (await auth.visitor({ headers: { "cf-access-jwt-assertion": jwt(good) } }))?.via === "access")
  check("another application's audience is refused", (await auth.verifyAccess(jwt({ ...good, aud: ["other"] }))) === null)
  check("another team's issuer is refused", (await auth.verifyAccess(jwt({ ...good, iss: "https://evil.cloudflareaccess.com" }))) === null)
  check("an expired token is refused", (await auth.verifyAccess(jwt({ ...good, exp: now - 1 }))) === null)
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  check("a token signed by another key is refused", (await auth.verifyAccess(jwt(good, { key: other }))) === null)
  const parts = jwt(good).split(".")
  const tampered = Buffer.from(JSON.stringify({ ...good, email: "admin@example.com" })).toString("base64url")
  check("a token whose claims were edited is refused", (await auth.verifyAccess(`${parts[0]}.${tampered}.${parts[2]}`)) === null)
  check("alg none is refused", (await auth.verifyAccess(jwt(good, { alg: "none" }))) === null)
  check("garbage is refused", (await auth.verifyAccess("not-a-jwt")) === null)
}

console.log("the API, end to end")
{
  const dir = mkdtempSync(join(tmpdir(), "nai-web-"))
  // Seed a novel with one drawn page, and a real PNG on disk for thumbnails.
  const lib = new L.Library(join(dir, "library.db"))
  const st = new S.Studio(lib)
  st.createProject({ name: "书", kind: "novel" })
  st.setChapter("书", { chapter: 1, text: "雨还在下。她没有回头。\n他把伞往她那边倾了倾。" })
  const pageId = st.listPages("书")[0].id
  const shot = st.setShot({ project: "书", pageId, spec: { prompt: "rain" } })
  const ids = []
  for (let i = 0; i < 2; i++) {
    const canvas = createCanvas(300, 450)
    const ctx = canvas.getContext("2d")
    ctx.fillStyle = i ? "#3060c0" : "#c03060"
    ctx.fillRect(0, 0, 300, 450)
    const file = `nai_20261025_000000_${i + 1}_${"ab".repeat(8)}.png`.replace("ab", String(i))
    writeFileSync(join(dir, file), canvas.toBuffer("image/png"))
    ids.push(lib.add({
      key: "nai/" + file, url: null, stored: "local", createdAt: new Date(Date.now() + i).toISOString(), model: "m", source: null,
      width: 300, height: 450, steps: 28, guidance: 6, sampler: "s", seed: i + 1, prompt: "rain", negative: "", characters: [],
      transparent: 0, bytes: 1, account: "a", cost: 0, origin: "generate", project: "书", shotId: shot.id,
    }).id)
  }
  st.verdict([ids[0]], "favorite", "agent")
  lib.close()

  const WEB_PASSWORD = "e2e test password"
  const port = 18000 + Math.floor(Math.random() * 2000)
  const server = spawn(process.execPath, [join(root, "mcp", "dist", "http.mjs")], {
    env: { ...process.env, MCP_AUTH_TOKEN: SECRET, NOVELAI_OUTPUT_DIR: dir, NOVELAI_TOKENS: "", PORT: String(port), HOST: "127.0.0.1",
           R2_ACCOUNT_ID: "", R2_BUCKET: "", CF_ACCESS_TEAM: "", CF_ACCESS_AUD: "",
           NOVELAI_WEB_PASSWORD_HASH: W.hashPassword(WEB_PASSWORD) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  server.stdout.on("data", (d) => (log += d))
  server.stderr.on("data", (d) => (log += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + "/health")).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }

  try {
    const anon = await fetch(base + "/api/projects")
    check("the API refuses a stranger", anon.status === 401)
    const page = await fetch(base + "/app", { redirect: "manual" })
    check("the page sends a stranger to log in", page.status === 303 && page.headers.get("location") === "/app/login")
    const form = (token) => fetch(base + "/app/login", { method: "POST", body: "token=" + encodeURIComponent(token), headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" })
    check("the login page asks for a password", (await (await fetch(base + "/app/login")).text()).includes("网页登录密码"))
    check("a wrong password is refused", (await form("nope")).status === 401)
    check("the MCP key is not a web password", (await form(SECRET)).status === 401)
    const login = await form(WEB_PASSWORD)
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]
    check("the web password logs in with a cookie", login.status === 303 && cookie.startsWith("nai_session="))
    const as = (path, init = {}) => fetch(base + path, { ...init, headers: { cookie, ...(init.headers ?? {}) } })
    const post = (path, body, extra = { "x-nai-app": "1" }) =>
      as(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...extra } })

    const page2 = await as("/app")
    const html = await page2.text()
    check("the page loads for a member", html.includes("/app/assets/app.js"))
    const version = (html.match(/name="nai-version" content="([0-9a-f]{10})"/) ?? [])[1]
    check("the page carries its front-end version", !!version, html)
    check("assets are loaded by versioned URL", html.includes(`/app/assets/app.js?v=${version}`) && html.includes(`/app/assets/style.css?v=${version}`))
    check("the page itself is never cached", page2.headers.get("cache-control") === "no-store")
    const live = await (await as("/api/version")).json()
    check("the API reports the same version", live.version === version, JSON.stringify(live))
    check("a versioned asset URL is served", (await as(`/app/assets/app.js?v=${version}`)).ok)
    const js = await as("/app/assets/app.js")
    check("the front end is served", js.ok && /javascript/.test(js.headers.get("content-type") ?? ""))
    check("its JSX was built for preact, not a stray factory", !(await js.text()).includes('createElement("header"'))

    const projects = await (await as("/api/projects")).json()
    check("projects are listed", projects.some((p) => p.name === "书" && p.progress.pick === 1))
    const book = await (await as("/api/projects/" + encodeURIComponent("书"))).json()
    const tile = book.chapters[0].pages[0]
    check("a page awaiting a pick shows the favourite as its stand-in", tile.picked === null && tile.cover === ids[0], JSON.stringify(tile))

    const detail = await (await as(`/api/pages/${pageId}`)).json()
    check("a page shows its candidates", detail.candidates.length === 2 && detail.page.number === 1)

    const chapterUrl = `/api/projects/${encodeURIComponent("书")}/chapters/1`
    const marked = await post(chapterUrl, { route: "IF 1" })
    const after = await (await as("/api/projects/" + encodeURIComponent("书"))).json()
    check("a chapter can be marked as a side story from the page", marked.ok && after.chapters[0].route === "IF 1")
    const tooLong = await post(chapterUrl, { route: "一二三四五六七八九十一二三四五六七" })
    check("a bad label is refused with the reason", tooLong.status >= 400 && /16/.test(await tooLong.text()))
    check("marking without the app header is refused", (await post(chapterUrl, { route: "" }, {})).status === 403)
    check("and it can go back to the main story", (await post(chapterUrl, { route: "" })).ok &&
          (await (await as("/api/projects/" + encodeURIComponent("书"))).json()).chapters[0].route === "")

    const csrf = await post("/api/verdict", { imageIds: [ids[1]], action: "pick" }, {})
    check("a write without the app header is refused", csrf.status === 403)
    const pick = await post("/api/verdict", { imageIds: [ids[1]], action: "pick" })
    check("a person can pick in the page", pick.ok && (await pick.json())[0].verdict === "picked")
    const note = await post("/api/feedback", { project: "书", target: "image", targetId: ids[1], body: "表情再惊讶一点" })
    check("a person can leave a note", note.ok)
    const bad = await post("/api/feedback", { project: "书", target: "image", body: "x" })
    check("a note on an image needs its id", bad.status === 400)

    {
      const side = new S.Studio(new L.Library(join(dir, "library.db")))
      side.createProject({ name: "漫画", kind: "gallery" })
      const [p1, p2] = ["一", "二"].map((title) => side.setShot({ project: "漫画", spec: { title } }).id)
      side.library.close()
      const moved = await post("/api/shots/place", { shotIds: [p2], at: 1 })
      check("a person can move a shot along the mainline", moved.ok && (await moved.json())[0].seq === 1)
      const off = await post("/api/shots/unplace", { shotIds: [p1] })
      check("and take one off it", off.ok && (await off.json())[0].seq === null)
      const comic = await (await as("/api/projects/" + encodeURIComponent("漫画"))).json()
      check("the project lists the mainline first", comic.shots.map((x) => `${x.id}:${x.seq}`).join() === `${p2}:1,${p1}:null`, JSON.stringify(comic.shots.map((x) => [x.id, x.seq])))
      const ordered = await post(`/api/projects/${encodeURIComponent("漫画")}/order`, { shotIds: [p1, p2] })
      check("the whole order can be set at once", ordered.ok && (await ordered.json()).map((x) => x.id).join() === `${p1},${p2}`)
      check("place needs shotIds", (await post("/api/shots/place", {})).status === 400)
      check("moving without the app header is refused", (await post("/api/shots/place", { shotIds: [p1] }, {})).status === 403)
    }

    // What the agent sees, from the same database.
    const seen = new S.Studio(new L.Library(join(dir, "library.db")))
    check("the agent sees the person's pick", seen.candidates(shot.id).find((c) => c.id === ids[1]).verdict === "picked")
    check("the agent sees the note to act on", seen.review("书").feedback.some((f) => f.body === "表情再惊讶一点"))
    seen.library.close()

    const thumb = await as(`/api/thumb/${ids[0]}`)
    const thumbBytes = Buffer.from(await thumb.arrayBuffer())
    check("without R2 the thumbnail is served directly as a JPEG",
          thumb.ok && thumb.headers.get("content-type") === "image/jpeg" && thumbBytes[0] === 0xff && thumbBytes[1] === 0xd8)
    const render = await as(`/api/render/page/${pageId}?image=${ids[1]}&w=640`)
    check("a page preview renders", render.ok && render.headers.get("content-type") === "image/jpeg")
    const stranger = await as(`/api/render/page/${pageId}?image=999999`)
    check("a preview with another page's image is refused", stranger.status === 400)
    const logout = await as("/app/logout", { redirect: "manual" })
    check("logging out clears the cookie", /Max-Age=0/.test(logout.headers.get("set-cookie") ?? ""))
  } finally {
    server.kill()
    if (failures) console.log(log.slice(-2000))
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? "\n+ all web checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
