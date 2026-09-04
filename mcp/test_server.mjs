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
  const { readZip, firstPng } = await import(join(here, "dist/server.mjs").replace(/server\.mjs$/, "zip.mjs"))
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
    args: [join(here, "dist/server.mjs")],
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

console.log(failures === 0 ? "\n[ok] mcp server holds" : "\n[fail] " + failures + " check(s) failed")
process.exit(failures === 0 ? 0 : 1)
