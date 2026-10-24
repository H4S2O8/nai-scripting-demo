/**
 * Drives the built MCP server over stdio with a real MCP client.
 *
 * No NovelAI token is needed: everything except the actual generation is
 * exercised, and generation is checked for the error it must produce without
 * credentials rather than by spending Anlas.
 *
 *   npm run build && node test_server.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " - " + detail : ""))
  }
}

/* --------------------------------------------------------------- zip reader */

console.log("zip reader")
{
  const { readZip, firstPng } = await import(join(here, "dist/zip.mjs"))
    .catch(async () => {
      // zip.ts is bundled into server.mjs; build a standalone copy to test it.
      const out = join(here, "dist/zip.mjs")
      execFileSync(
        "npx",
        ["--yes", "esbuild@0.24.0", join(here, "zip.ts"), "--bundle", "--platform=node", "--format=esm", "--packages=external", "--outfile=" + out],
        { stdio: ["ignore", "ignore", "inherit"] },
      )
      return import(out)
    })

  const work = mkdtempSync(join(tmpdir(), "nai-zip-"))
  // A real archive from the system zip tool, not one this code produced —
  // round-tripping our own writer would prove nothing about NovelAI's.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("x".repeat(5000)),
  ])
  writeFileSync(join(work, "image_0.png"), png)
  writeFileSync(join(work, "notes.txt"), "not the image")
  execFileSync("zip", ["-q", "-X", join(work, "a.zip"), "image_0.png", "notes.txt"], { cwd: work })

  const archive = readFileSync(join(work, "a.zip"))
  const entries = readZip(archive)
  check("reads every entry", entries.length === 2, JSON.stringify(entries.map((e) => e.name)))
  check("inflates deflated data", Buffer.compare(entries.find((e) => e.name.endsWith(".png")).data, png) === 0)
  check("picks the PNG, not the text file", Buffer.compare(firstPng(archive), png) === 0)

  // Stored (method 0) entries take the other branch.
  execFileSync("zip", ["-q", "-X", "-0", join(work, "stored.zip"), "image_0.png"], { cwd: work })
  check("handles stored entries", Buffer.compare(firstPng(readFileSync(join(work, "stored.zip"))), png) === 0)

  let threw = false
  try {
    firstPng(Buffer.from("this is not a zip"))
  } catch {
    threw = true
  }
  check("rejects non-zip input", threw)

  threw = false
  try {
    execFileSync("zip", ["-q", "-X", join(work, "notext.zip"), "notes.txt"], { cwd: work })
    firstPng(readFileSync(join(work, "notext.zip")))
  } catch {
    threw = true
  }
  check("errors when the archive has no PNG", threw)

  rmSync(work, { recursive: true, force: true })
}

/* ------------------------------------------------------------- mcp protocol */

console.log("mcp server over stdio")
{
  const outDir = mkdtempSync(join(tmpdir(), "nai-mcp-out-"))
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(here, "dist/stdio.mjs")],
    env: { ...process.env, NOVELAI_TOKEN: "", NOVELAI_OUTPUT_DIR: outDir },
  })
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(transport)

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  check(
    "exposes every tool",
    JSON.stringify(names) ===
      JSON.stringify(["novelai_account", "novelai_compose_page", "novelai_draw", "novelai_generate_image", "novelai_guide", "novelai_library_get", "novelai_library_search", "novelai_library_update", "novelai_list_options", "novelai_novel_text", "novelai_project", "novelai_review", "novelai_shot", "novelai_verdict"]),
    JSON.stringify(names),
  )
  const gen = tools.find((t) => t.name === "novelai_generate_image")
  check("generate declares a prompt parameter", gen.inputSchema?.properties?.prompt != null)
  check("prompt is the only required one", JSON.stringify(gen.inputSchema?.required) === '["prompt"]', JSON.stringify(gen.inputSchema?.required))

  // Nothing the server would add to the prompt is configurable any more; the
  // presets are text in the manual instead.
  check("generate takes no preset switches",
        gen.inputSchema?.properties?.ucPreset == null && gen.inputSchema?.properties?.qualityPreset == null)
  check("generate says the prompt is sent verbatim", /VERBATIM/.test(gen.description))
  check("generate points at the manual", /novelai_guide/.test(gen.description))

  const guide = tools.find((t) => t.name === "novelai_guide")
  check("the guide's topic is optional", !(guide?.inputSchema?.required ?? []).includes("topic"))
  check("the guide lists its topics in the schema",
        (guide?.inputSchema?.properties?.topic?.enum ?? []).includes("text"))
  const index = await client.callTool({ name: "novelai_guide", arguments: {} })
  check("the guide with no topic returns the index", /manga/.test(index.content[0].text) && !index.isError)
  const textTopic = await client.callTool({ name: "novelai_guide", arguments: { topic: "text" } })
  check("a guide topic returns its text", /Text:/.test(textTopic.content[0].text))
  const badTopic = await client.callTool({ name: "novelai_guide", arguments: { topic: "nope" } })
  check("an unknown guide topic is refused", badTopic.isError === true)

  // The library: a fresh database in the temp output dir.
  check("generate takes a project and tags",
        gen.inputSchema?.properties?.project != null && gen.inputSchema?.properties?.tags != null)
  const badProject = await client.callTool({ name: "novelai_generate_image", arguments: { prompt: "1girl", project: "   " } })
  check("a bad project name is refused before generating",
        badProject.isError === true && /项目名/.test(badProject.content[0].text), badProject.content[0].text)
  const emptyList = await client.callTool({ name: "novelai_project", arguments: { action: "list" } })
  check("an empty studio lists no projects", !emptyList.isError && JSON.parse(emptyList.content[0].text).length === 0, emptyList.content[0].text)
  const made = await client.callTool({ name: "novelai_project", arguments: { action: "create", name: "Test Book", kind: "novel", description: "for the suite" } })
  check("a project can be created", !made.isError && JSON.parse(made.content[0].text).name === "Test Book", made.content[0].text)
  const listed = JSON.parse((await client.callTool({ name: "novelai_project", arguments: { action: "list" } })).content[0].text)
  check("the list shows it", listed.some((p) => p.name === "Test Book" && p.kind === "novel" && p.description === "for the suite"))
  const kindless = await client.callTool({ name: "novelai_project", arguments: { action: "create", name: "X" } })
  check("creating without a kind is refused", kindless.isError === true && /kind/.test(kindless.content[0].text))
  const chapter = await client.callTool({ name: "novelai_novel_text", arguments: { action: "set", project: "Test Book", chapter: 1, text: "雨还在下。\n她没有回头。" } })
  check("a chapter can be set", !chapter.isError && /第 1 章/.test(chapter.content[0].text), chapter.content[0].text)
  const pageList = await client.callTool({ name: "novelai_novel_text", arguments: { action: "pages", project: "Test Book" } })
  const pageId = Number((pageList.content[0].text.match(/页 #(\d+)/) ?? [])[1])
  check("its pages are listed with ids", pageId > 0, pageList.content[0].text)
  const shotSet = await client.callTool({ name: "novelai_shot", arguments: { action: "set", project: "Test Book", pageId, prompt: "rain, night" } })
  const shotId = Number((shotSet.content[0].text.match(/镜头 #(\d+)/) ?? [])[1])
  check("a shot can be set on a page", shotId > 0 && /待抽卡/.test(shotSet.content[0].text), shotSet.content[0].text)
  const drawNoToken = await client.callTool({ name: "novelai_draw", arguments: { shotId, count: 1 } })
  check("drawing without a NovelAI token fails clearly", /NOVELAI_TOKEN|生成失败/.test(drawNoToken.content[0].text), drawNoToken.content[0].text)
  const review = await client.callTool({ name: "novelai_review", arguments: { project: "Test Book" } })
  check("the review lists the shot waiting to be drawn", /待抽卡/.test(review.content[0].text), review.content[0].text)
  const pickLoose = await client.callTool({ name: "novelai_verdict", arguments: { imageIds: [999], action: "pick" } })
  check("a verdict on an unknown image is an error", pickLoose.isError === true)
  const none = await client.callTool({ name: "novelai_library_search", arguments: { project: "Test Book" } })
  check("searching an empty project says so", !none.isError && /没有符合/.test(none.content[0].text))
  const unknown = await client.callTool({ name: "novelai_library_search", arguments: { project: "Nope" } })
  check("searching an unknown project is an error", unknown.isError === true)
  const noop = await client.callTool({ name: "novelai_library_update", arguments: { ids: [1] } })
  check("an update with nothing to change is refused", noop.isError === true)
  const missing = await client.callTool({ name: "novelai_library_get", arguments: { ids: [12345] } })
  check("getting an unknown id is an error", missing.isError === true && /12345/.test(missing.content[0].text))
  check("the library file lives in the output dir", existsSync(join(outDir, "library.db")))

  // The page composer refuses before touching the network where it can.
  const page = tools.find((t) => t.name === "novelai_compose_page")
  check("the composer takes an image link and the text",
        JSON.stringify(page?.inputSchema?.required) === '["imageUrl","text"]', JSON.stringify(page?.inputSchema?.required))
  const internal = await client.callTool({ name: "novelai_compose_page", arguments: { imageUrl: "http://127.0.0.1:8787/health", text: "雨还在下。" } })
  check("the composer will not fetch from this machine", internal.isError === true && /内网/.test(internal.content[0].text), internal.content[0].text)
  const badColour = await client.callTool({ name: "novelai_compose_page", arguments: { imageUrl: "https://example.invalid/x.png", text: "x", background: "black" } })
  check("a bad colour is refused before any download", badColour.isError === true && /#rgb/.test(badColour.content[0].text), badColour.content[0].text)

  const options = await client.callTool({ name: "novelai_list_options", arguments: {} })
  const parsed = JSON.parse(options.content[0].text)
  check("lists models", parsed.models.length >= 8)
  check("reports character slots per model", parsed.models.find((m) => m.id === "nai-diffusion-5-full").characterPrompts === 32)
  check("lists samplers", parsed.samplers.length >= 7)
  check("lists size presets", parsed.sizePresets.length >= 11)
  check("reports the defaults", parsed.defaults.model === "nai-diffusion-5-full" && parsed.defaults.steps === 28)

  const empty = await client.callTool({ name: "novelai_generate_image", arguments: { prompt: "  " } })
  check("an empty prompt is refused before any request", empty.isError === true)

  // No token configured: it must say so rather than fail obscurely at the API.
  const noToken = await client.callTool({
    name: "novelai_generate_image",
    arguments: { prompt: "1girl" },
  })
  check("a missing token is reported clearly", noToken.isError === true && /NOVELAI_TOKEN/.test(noToken.content[0].text), noToken.content[0].text)

  const badModel = await client.callTool({
    name: "novelai_generate_image",
    arguments: { prompt: "1girl", model: "nai-diffusion-3", characters: [{ prompt: "a" }] },
  })
  check(
    "character prompts on an unsupported model are refused",
    badModel.isError === true && /人物 prompt/.test(badModel.content[0].text),
    badModel.content[0].text,
  )

  const account = await client.callTool({ name: "novelai_account", arguments: {} })
  check("account reports the missing token too", account.isError === true)

  await client.close()
  rmSync(outDir, { recursive: true, force: true })
}

/* ------------------------------------------------------------ http transport */

console.log("http transport")
{
  const SECRET = "test-secret-not-a-real-one"
  const PORT = 8791 + (process.pid % 100)
  const outDir = mkdtempSync(join(tmpdir(), "nai-mcp-http-"))
  // Only names this server would have generated are served; the 16 hex chars
  // are the capability that replaces the bearer header on this route.
  const IMG = "nai_20260905_031500_12345_0123456789abcdef.png"
  writeFileSync(join(outDir, IMG), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  // An endpoint that spends Anlas must not be startable without a secret.
  const naked = spawn("node", [join(here, "dist/http.mjs")], {
    env: { ...process.env, MCP_AUTH_TOKEN: "", NOVELAI_TOKEN: "pst-x", PORT: String(PORT + 1) },
    stdio: ["ignore", "ignore", "pipe"],
  })
  const nakedErr = await new Promise((resolve) => {
    let text = ""
    naked.stderr.on("data", (d) => (text += d))
    naked.on("exit", (code) => resolve({ code, text }))
  })
  check("refuses to start without MCP_AUTH_TOKEN", nakedErr.code === 1 && /MCP_AUTH_TOKEN/.test(nakedErr.text), nakedErr.text.slice(0, 120))

  const child = spawn("node", [join(here, "dist/http.mjs")], {
    env: {
      ...process.env,
      MCP_AUTH_TOKEN: SECRET,
      NOVELAI_TOKEN: "pst-not-real",
      NOVELAI_OUTPUT_DIR: outDir,
      PORT: String(PORT),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10000)
    child.stdout.on("data", (d) => {
      if (String(d).includes("novelai mcp on")) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  const base = `http://127.0.0.1:${PORT}`
  const health = await fetch(base + "/health")
  check("health needs no auth", health.status === 200)

  check("mcp without a token is rejected", (await fetch(base + "/mcp", { method: "POST" })).status === 401)
  check(
    "mcp with the wrong token is rejected",
    (await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer wrong" } })).status === 401,
  )
  check(
    "a token of the right length but wrong value is rejected",
    (await fetch(base + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + "x".repeat(SECRET.length) },
    })).status === 401,
  )
  // Deliberately unauthenticated: a chat client rendering the picture cannot
  // attach an Authorization header, so requiring one meant it never displayed.
  const anon = await fetch(base + "/images/" + IMG)
  check("images are served without a bearer header", anon.status === 200 && anon.headers.get("content-type") === "image/png")
  check(
    "a name without the random suffix is refused",
    (await fetch(base + "/images/sample.png")).status === 404,
  )
  check(
    "a plausible but wrong suffix is refused",
    (await fetch(base + "/images/nai_20260905_031500_12345_deadbeef.png")).status === 404,
  )

  const authed = { headers: { authorization: "Bearer " + SECRET } }
  const image = await fetch(base + "/images/" + IMG, authed)
  check("a bearer header is still accepted", image.status === 200)
  // basename() strips any directory part, so traversal cannot escape the folder.
  check(
    "path traversal is refused",
    (await fetch(base + "/images/..%2F..%2F..%2Fetc%2Fpasswd")).status === 404,
  )
  check("unknown paths 404", (await fetch(base + "/nope", authed)).status === 404)

  // OAuth, for clients (Gemini) that will not send a static header.
  const challenge = (await fetch(base + "/mcp", { method: "POST" })).headers.get("www-authenticate") ?? ""
  check("401 points at resource metadata", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(challenge), challenge)
  const prm = await (await fetch(base + "/.well-known/oauth-protected-resource")).json()
  check("protected resource metadata names the auth server", prm.resource === base + "/mcp" && prm.authorization_servers[0] === base)
  const asm = await (await fetch(base + "/.well-known/oauth-authorization-server")).json()
  check("auth server metadata lists endpoints", asm.token_endpoint === base + "/oauth/token" && asm.code_challenge_methods_supported.includes("S256"))

  const { createHash, randomBytes } = await import("node:crypto")
  const verifier = randomBytes(32).toString("base64url")
  const pkce = createHash("sha256").update(verifier).digest("base64url")
  const REDIRECT = "https://client.example/callback"
  const codeFrom = (r) => new URL(r.headers.get("location")).searchParams.get("code")
  const tokenReq = (form, headers = {}) =>
    fetch(base + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form),
    })

  // Static client: client_id novelai-mcp, client_secret = MCP_AUTH_TOKEN.
  const authQ = (cid) =>
    `${base}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1&code_challenge=${pkce}&code_challenge_method=S256`
  const sAuth = await fetch(authQ("novelai-mcp"), { redirect: "manual" })
  const sLoc = new URL(sAuth.headers.get("location") ?? "http://x/")
  check("static client is redirected with a code and state", sAuth.status === 302 && sLoc.searchParams.get("state") === "s1" && !!codeFrom(sAuth))
  const sCode = codeFrom(sAuth)
  const codeForm = { grant_type: "authorization_code", code: sCode, redirect_uri: REDIRECT, code_verifier: verifier, client_id: "novelai-mcp" }
  check("wrong client_secret is refused", (await tokenReq({ ...codeForm, client_secret: "nope" })).status === 401)
  const basic = "Basic " + Buffer.from("novelai-mcp:" + SECRET).toString("base64")
  const sTok = await tokenReq({ ...codeForm, client_id: "" }, { authorization: basic })
  const sJson = await sTok.json()
  check("code exchanges for tokens with client_secret_basic", sTok.status === 200 && sJson.access_token?.startsWith("nmo_"), JSON.stringify(sJson))
  check("a code works only once", (await tokenReq({ ...codeForm, client_secret: SECRET })).status === 400)
  check(
    "OAuth access token opens /mcp",
    (await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + sJson.access_token } })).status !== 401,
  )
  check(
    "a refresh token is not an access token",
    (await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + sJson.refresh_token } })).status === 401,
  )
  const tampered = sJson.access_token.slice(0, -2) + (sJson.access_token.endsWith("AA") ? "BB" : "AA")
  check("a tampered token is refused", (await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + tampered } })).status === 401)
  const rTok = await tokenReq({ grant_type: "refresh_token", refresh_token: sJson.refresh_token, client_id: "novelai-mcp", client_secret: SECRET })
  check("refresh grant issues a new access token", rTok.status === 200 && (await rTok.json()).access_token?.startsWith("nmo_"))
  check("an unknown client is refused at authorize", (await fetch(authQ("someone"), { redirect: "manual" })).status === 400)
  const evil = await fetch(authQ("novelai-mcp").replace(encodeURIComponent(REDIRECT), encodeURIComponent("javascript:alert(1)")), { redirect: "manual" })
  check("a non-https redirect is refused, not followed", evil.status === 400)

  // Dynamic client: registered, public, must type the key on the consent page.
  const reg = await fetch(base + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test", redirect_uris: [REDIRECT] }),
  })
  const regJson = await reg.json()
  check("dynamic registration returns a client_id", reg.status === 201 && !!regJson.client_id)
  const consent = await fetch(authQ(regJson.client_id), { redirect: "manual" })
  check("dynamic client gets a consent page, not a code", consent.status === 200 && /type="password"/.test(await consent.text()))
  const consentForm = (key) => {
    const f = new URL(authQ(regJson.client_id)).searchParams
    f.set("key", key)
    return fetch(base + "/oauth/authorize", { method: "POST", body: f, redirect: "manual" })
  }
  check("wrong key on the consent page is refused", (await consentForm("wrong")).status === 401)
  const dAuth = await consentForm(SECRET)
  check("right key on the consent page redirects with a code", dAuth.status === 302 && !!codeFrom(dAuth))
  const dTok = await tokenReq({ grant_type: "authorization_code", code: codeFrom(dAuth), redirect_uri: REDIRECT, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier", client_id: regJson.client_id })
  check("wrong PKCE verifier is refused", dTok.status === 400)
  const oauthClient = new Client({ name: "test-oauth", version: "1.0.0" })
  {
    const again = await consentForm(SECRET)
    const t = await (await tokenReq({ grant_type: "authorization_code", code: codeFrom(again), redirect_uri: REDIRECT, code_verifier: verifier, client_id: regJson.client_id })).json()
    await oauthClient.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + t.access_token } },
      }),
    )
    const tools = (await oauthClient.listTools()).tools
    check("an MCP client works with an OAuth token", tools.length > 0)
    await oauthClient.close()
  }

  const httpClient = new Client({ name: "test-http", version: "1.0.0" })
  await httpClient.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + SECRET } },
    }),
  )
  const httpTools = (await httpClient.listTools()).tools.map((t) => t.name).sort()
  check(
    "the same tools are served over http",
    JSON.stringify(httpTools) ===
      JSON.stringify(["novelai_account", "novelai_compose_page", "novelai_draw", "novelai_generate_image", "novelai_guide", "novelai_library_get", "novelai_library_search", "novelai_library_update", "novelai_list_options", "novelai_novel_text", "novelai_project", "novelai_review", "novelai_shot", "novelai_verdict"]),
    JSON.stringify(httpTools),
  )
  const opts = await httpClient.callTool({ name: "novelai_list_options", arguments: {} })
  check("tools work over http", JSON.parse(opts.content[0].text).models.length >= 8)

  // Two clients at once: each POST gets its own server and transport.
  const second = new Client({ name: "test-http-2", version: "1.0.0" })
  await second.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + SECRET } },
    }),
  )
  const [a, b] = await Promise.all([
    httpClient.callTool({ name: "novelai_list_options", arguments: {} }),
    second.callTool({ name: "novelai_list_options", arguments: {} }),
  ])
  check("concurrent clients do not interfere", a.content[0].text === b.content[0].text)

  await httpClient.close()
  await second.close()
  child.kill()
  rmSync(outDir, { recursive: true, force: true })
}

console.log(failures === 0 ? "\n[ok] mcp server holds" : "\n[fail] " + failures + " check(s) failed")
process.exit(failures === 0 ? 0 : 1)
