/**
 * Verifies the vendored crypto against reference implementations, in node.
 *
 * The Scripting platform has no simulator, so this is the only place the
 * BLAKE2b and secretbox ports can be proven correct before they touch a real
 * NovelAI account. Run it after touching blake2b.ts or nacl.ts:
 *
 *   node dev/test_crypto.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naicrypto-"))

// The modules are TS only in their exported tail; bundle them to plain ESM.
function bundle(name) {
  const dest = join(out, name.replace(/\.ts$/, ".mjs"))
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const { blake2b256 } = await import(bundle("blake2b.ts"))
const { secretbox, secretboxOpen } = await import(bundle("nacl.ts"))

let failures = 0
function check(name, ok, detail = "") {
  if (ok) {
    console.log("  ok   " + name)
  } else {
    failures++
    console.log("  FAIL " + name + (detail ? " — " + detail : ""))
  }
}

const hex = (bytes) => Buffer.from(bytes).toString("hex")
const utf8 = (text) => new TextEncoder().encode(text)

/* ------------------------------------------------------------- BLAKE2b-256 */
console.log("BLAKE2b-256 (RFC 7693 vectors)")
const vectors = [
  ["", "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"],
  ["abc", "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"],
]
for (const [input, expected] of vectors) {
  const got = hex(blake2b256(utf8(input)))
  check(`blake2b256(${JSON.stringify(input)})`, got === expected, got)
}
// Longer than one 128-byte block, to exercise the compression loop.
const long = "x".repeat(300)
check(
  "blake2b256(300 bytes) is 32 bytes",
  blake2b256(utf8(long)).length === 32,
)

/* ---------------------------------------------------------------- secretbox */
console.log("secretbox (vs tweetnacl 1.0.3)")
let nacl
try {
  nacl = (await import("tweetnacl")).default
} catch {
  writeFileSync(join(out, "package.json"), '{"type":"commonjs"}')
  execFileSync("npm", ["install", "--no-save", "--prefix", out, "tweetnacl@1.0.3"], {
    stdio: ["ignore", "ignore", "inherit"],
  })
  nacl = (await import(join(out, "node_modules/tweetnacl/nacl-fast.js"))).default
}

// Deterministic filler, so a failure is reproducible. `salt` makes two calls
// of the same length differ — without it the "wrong key" below is the key.
const rand = (n, salt = 0) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 11 + salt * 101) & 0xff
  return b
}

for (const size of [0, 1, 31, 32, 33, 64, 1000]) {
  const key = rand(32)
  const nonce = rand(24)
  const msg = rand(size)
  const mine = secretbox(msg, nonce, key)
  const theirs = nacl.secretbox(msg, nonce, key)
  check(`secretbox(${size}B) matches tweetnacl`, hex(mine) === hex(theirs), hex(mine))
  const opened = secretboxOpen(theirs, nonce, key)
  check(
    `open(${size}B) round-trips`,
    opened != null && hex(opened) === hex(msg),
  )
  const theirsOpened = nacl.secretbox.open(mine, nonce, key)
  check(
    `tweetnacl opens ours (${size}B)`,
    theirsOpened != null && hex(theirsOpened) === hex(msg),
  )
}

// A tampered box must not authenticate.
const key = rand(32)
const nonce = rand(24)
const box = secretbox(utf8("hello"), nonce, key)
box[box.length - 1] ^= 0x01
check("tampered box is rejected", secretboxOpen(box, nonce, key) === null)
check(
  "wrong key is rejected",
  secretboxOpen(secretbox(utf8("hi"), nonce, key), nonce, rand(32, 1)) === null,
)
check(
  "wrong nonce is rejected",
  secretboxOpen(secretbox(utf8("hi"), nonce, key), rand(24, 1), key) === null,
)

console.log(failures === 0 ? "\n✓ all crypto checks passed" : `\n✗ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
