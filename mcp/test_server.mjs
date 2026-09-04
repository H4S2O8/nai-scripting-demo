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
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
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
    "exposes the three tools",
    JSON.stringify(names) ===
      JSON.stringify(["novelai_account", "novelai_generate_image", "novelai_list_options"]),
    JSON.stringify(names),
  )
  const gen = tools.find((t) => t.name === "novelai_generate_image")
  check("generate declares a prompt parameter", gen.inputSchema?.properties?.prompt != null)
  check("prompt is the only required one", JSON.stringify(gen.inputSchema?.required) === '["prompt"]', JSON.stringify(gen.inputSchema?.required))

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
  writeFileSync(join(outDir, "sample.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

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
  check("images need auth too", (await fetch(base + "/images/sample.png")).status === 401)

  const authed = { headers: { authorization: "Bearer " + SECRET } }
  const image = await fetch(base + "/images/sample.png", authed)
  check("an authorised image request is served", image.status === 200 && image.headers.get("content-type") === "image/png")
  // basename() strips any directory part, so traversal cannot escape the folder.
  check(
    "path traversal is refused",
    (await fetch(base + "/images/..%2F..%2F..%2Fetc%2Fpasswd", authed)).status === 404,
  )
  check("unknown paths 404", (await fetch(base + "/nope", authed)).status === 404)

  const httpClient = new Client({ name: "test-http", version: "1.0.0" })
  await httpClient.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + SECRET } },
    }),
  )
  const httpTools = (await httpClient.listTools()).tools.map((t) => t.name).sort()
  check(
    "the same three tools are served over http",
    JSON.stringify(httpTools) ===
      JSON.stringify(["novelai_account", "novelai_generate_image", "novelai_list_options"]),
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
