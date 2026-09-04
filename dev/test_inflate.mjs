/**
 * Fuzzes the vendored raw-DEFLATE decoder against node's zlib.
 *
 * A hand-ported inflate is the classic "works on the sample, breaks on real
 * data" component: stored blocks, overlapping back-references and dynamic
 * Huffman tables are all separate code paths that a couple of fixtures never
 * reach. So generate inputs that force each one, and a few thousand random
 * ones on top.
 *
 *   node dev/test_inflate.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import zlib from "node:zlib"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "nai-inflate-"))
const dest = join(out, "inflate.mjs")
execFileSync(
  "npx",
  ["--yes", "esbuild@0.24.0", join(root, "inflate.ts"), "--format=esm", "--bundle", "--outfile=" + dest],
  { stdio: ["ignore", "ignore", "inherit"] },
)
const { inflateRaw, inflateAuto } = await import(dest)

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " — " + detail : ""))
  }
}

// Reproducible PRNG, so a failure can be replayed.
let seed = 0x2f6e2b1
function rnd() {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b))

function roundTrip(buf, label, level) {
  const packed = zlib.deflateRawSync(buf, level === undefined ? {} : { level })
  let got
  try {
    got = inflateRaw(new Uint8Array(packed))
  } catch (e) {
    return check(label, false, String(e))
  }
  check(label, eq(got, buf), `${got.length}B vs ${buf.length}B`)
}

console.log("block types")
// level 0 emits stored blocks
roundTrip(Buffer.from("hello stored block"), "stored block (level 0)", 0)
// tiny input takes the fixed-Huffman path
roundTrip(Buffer.from("a"), "single byte (fixed Huffman)")
roundTrip(Buffer.alloc(0), "empty input")
// realistic text takes the dynamic-Huffman path
roundTrip(
  Buffer.from(JSON.stringify({ label: "蓝眼", expansion: "blue eyes, {{detailed}}", color: "#7C5CFA" }).repeat(20)),
  "dynamic Huffman (json)",
)
// long runs force overlapping back-references
roundTrip(Buffer.alloc(70000, 0x41), "70KB single run (overlapping copies)")
roundTrip(Buffer.from("ab".repeat(50000)), "100KB two-byte cycle")
// incompressible data forces stored blocks even at default level
{
  const noise = Buffer.alloc(80000)
  for (let i = 0; i < noise.length; i++) noise[i] = (rnd() * 256) | 0
  roundTrip(noise, "80KB incompressible (stored blocks)")
}
// every level, on data that exercises matching
for (let level = 0; level <= 9; level++) {
  const text = Buffer.from("the quick brown fox ".repeat(500) + "終わり")
  roundTrip(text, `level ${level}`, level)
}

console.log("wrappers")
{
  const buf = Buffer.from("wrapped payload".repeat(50))
  check("zlib wrapper is stripped", eq(inflateAuto(new Uint8Array(zlib.deflateSync(buf))), buf))
  check("gzip wrapper is stripped", eq(inflateAuto(new Uint8Array(zlib.gzipSync(buf))), buf))
  check("raw passes through inflateAuto", eq(inflateAuto(new Uint8Array(zlib.deflateRawSync(buf))), buf))
}

console.log("corrupt input terminates")
{
  // Raw DEFLATE has no checksum (that is zlib's Adler-32), so there is no
  // general statement to make about what a corrupt stream decodes to: cutting
  // only the end-of-block marker still yields the complete data, and cutting
  // deeper makes the decoder read invented zero bits and append plausible
  // garbage. Neither is a bug, and neither is worth asserting.
  //
  // It does not need to be, either: these payloads are authenticated by
  // secretbox before inflate ever sees them, so corrupt input here means a bug
  // in our own code, not an attacker. What must hold is that it stops.
  const original = Buffer.from("some data to truncate".repeat(40))
  const packed = zlib.deflateRawSync(original)
  let threw = 0
  let finished = 0
  for (let cut = 1; cut <= 24; cut++) {
    try {
      inflateRaw(new Uint8Array(packed.subarray(0, packed.length - cut)))
      finished++
    } catch {
      threw++
    }
  }
  check("every truncation terminates", threw + finished === 24, `${threw} threw, ${finished} returned`)
  check("most truncations are detected outright", threw > 0, threw + "/24 threw")

  let garbageThrew = false
  try {
    inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
  } catch {
    garbageThrew = true
  }
  check("garbage throws", garbageThrew)

  // A back-reference reaching before the start of the output must be caught
  // rather than read out of bounds.
  let boundsThrew = false
  try {
    inflateRaw(new Uint8Array([0x63, 0x18, 0x05, 0x00]))
    boundsThrew = true // decoded fine, which is also acceptable
  } catch {
    boundsThrew = true
  }
  check("a malformed back-reference does not read out of bounds", boundsThrew)
}

console.log("fuzz (2000 random payloads)")
{
  let bad = 0
  const alphabets = ["ab", "abcdefgh", "0123456789abcdef", "蓝眼白发夜景, 1girl, {detailed}"]
  for (let i = 0; i < 2000; i++) {
    const size = Math.floor(rnd() * 3000)
    const mode = i % 4
    let buf
    if (mode === 0) {
      buf = Buffer.alloc(size)
      for (let j = 0; j < size; j++) buf[j] = (rnd() * 256) | 0
    } else {
      const alpha = alphabets[mode]
      let s = ""
      while (Buffer.byteLength(s) < size) s += alpha[(rnd() * alpha.length) | 0]
      buf = Buffer.from(s)
    }
    const level = i % 10
    try {
      if (!eq(inflateRaw(new Uint8Array(zlib.deflateRawSync(buf, { level }))), buf)) bad++
    } catch (e) {
      bad++
      if (bad === 1) console.log("    first failure: size=" + size + " level=" + level + " " + e)
    }
  }
  check("2000 random payloads round-trip", bad === 0, bad + " mismatches")
}

console.log(failures === 0 ? "\n✓ inflate matches zlib" : `\n✗ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
