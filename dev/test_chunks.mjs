/**
 * Cross-checks the chunk / keystore codec against the userscript's own
 * implementation (tweetnacl + node zlib), in node.
 *
 * The userscript is known to work against the live service, so byte-for-byte
 * interop with it is the closest thing to an end-to-end test we can run without
 * pointing this at a real NovelAI account.
 *
 *   node dev/test_chunks.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import zlib from "node:zlib"
import crypto from "node:crypto"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naichunks-"))

/* ------------------------------------------------- Scripting global shims */

class FakeData {
  constructor(buf) {
    this.buf = Buffer.from(buf)
  }
  get size() {
    return this.buf.length
  }
  static fromString(text) {
    return new FakeData(Buffer.from(text, "utf8"))
  }
  static fromUint8Array(bytes) {
    return new FakeData(Buffer.from(bytes))
  }
  static fromBase64String(b64) {
    try {
      return new FakeData(Buffer.from(b64, "base64"))
    } catch {
      return null
    }
  }
  toUint8Array() {
    return new Uint8Array(this.buf)
  }
  toRawString() {
    return this.buf.toString("utf8")
  }
  toBase64String() {
    return this.buf.toString("base64")
  }
  // The whole point of the probe in chunks.ts: Apple's "zlib" is raw DEFLATE.
  compressed(algorithm) {
    if (algorithm !== "zlib") throw new Error("unsupported")
    return new FakeData(zlib.deflateRawSync(this.buf))
  }
  decompressed(algorithm) {
    if (algorithm !== "zlib") throw new Error("unsupported")
    return new FakeData(zlib.inflateRawSync(this.buf))
  }
  slice(start, end) {
    return new FakeData(this.buf.subarray(start, end))
  }
}

globalThis.Data = FakeData
globalThis.Crypto = {
  generateSymmetricKey(bits = 256) {
    return new FakeData(crypto.randomBytes(bits / 8))
  },
}
globalThis.UUID = { string: () => crypto.randomUUID() }
globalThis.Storage = {
  _v: {},
  get(k) {
    return this._v[k] ?? null
  },
  set(k, v) {
    this._v[k] = v
    return true
  },
}
globalThis.Keychain = {
  _v: {},
  get(k) {
    return this._v[k] ?? null
  },
  set(k, v) {
    this._v[k] = v
    return true
  },
  remove(k) {
    delete this._v[k]
  },
}

/* ------------------------------------------------------------------ setup */

function bundle(name) {
  const dest = join(out, name.replace(/\.ts$/, ".mjs"))
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const C = await import(bundle("chunks.ts"))
let nacl
try {
  nacl = (await import("tweetnacl")).default
} catch {
  execFileSync("npm", ["install", "--no-save", "--prefix", out, "tweetnacl@1.0.3"], {
    stdio: ["ignore", "ignore", "inherit"],
  })
  nacl = (await import(join(out, "node_modules/tweetnacl/nacl-fast.js"))).default
}

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " — " + detail : ""))
  }
}

const MAGIC = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])

/* --------------------- the userscript's codec, reimplemented for reference */

function refDecode(obj, keyBytes) {
  let raw = Buffer.from(obj.data, "base64")
  const compressed = raw.length >= 16 && raw.subarray(0, 16).equals(MAGIC)
  if (compressed) raw = raw.subarray(16)
  const nonce = new Uint8Array(raw.subarray(0, 24))
  const box = new Uint8Array(raw.subarray(24))
  let plain = nacl.secretbox.open(box, nonce, new Uint8Array(keyBytes))
  if (!plain) throw new Error("ref decrypt failed")
  if (compressed) plain = new Uint8Array(zlib.inflateRawSync(Buffer.from(plain)))
  return JSON.parse(Buffer.from(plain).toString("utf8"))
}

function refEncode(chunk, keyBytes, { compress = true } = {}) {
  const payload = Buffer.from(JSON.stringify(chunk), "utf8")
  const body = compress ? zlib.deflateRawSync(payload) : payload
  const nonce = crypto.randomBytes(24)
  const box = nacl.secretbox(
    new Uint8Array(body),
    new Uint8Array(nonce),
    new Uint8Array(keyBytes),
  )
  const prefix = compress ? MAGIC : Buffer.alloc(0)
  return {
    data: Buffer.concat([prefix, nonce, Buffer.from(box)]).toString("base64"),
    meta: chunk.containerId,
  }
}

/* ------------------------------------------------------------------ tests */

console.log("compression probes")
check("vendored decoder works", C.decoderUsable() === true)
check("platform encoder validated by our decoder", C.compressionUsable() === true)
console.log("chunk codec")
const containerId = crypto.randomUUID()
const keyBytes = Array.from(crypto.randomBytes(32))
const ks = { master: new Uint8Array(crypto.randomBytes(32)), keys: { [containerId]: keyBytes }, extras: {}, dirty: false }

const sample = {
  containerId,
  id: "chunk-1",
  label: "蓝眼",
  expansion: "blue eyes, {{detailed eyes}}",
  color: "#7C5CFA",
  version: 1,
  isCategory: false,
}

const mine = C.encodeChunk({ ...sample }, ks)
const viaRef = refDecode(mine, keyBytes)
check("userscript decodes our chunk", viaRef.label === sample.label && viaRef.expansion === sample.expansion, JSON.stringify(viaRef))
check("we write the compressed magic", Buffer.from(mine.data, "base64").subarray(0, 16).equals(MAGIC))
check("remoteId is blanked on the wire", viaRef.remoteId === "")

for (const compress of [true, false]) {
  const theirs = refEncode({ ...sample, remoteId: "" }, keyBytes, { compress })
  const decoded = C.decodeChunk({ id: "obj-1", data: theirs.data, meta: containerId }, ks)
  check(
    `we decode the userscript's ${compress ? "compressed" : "uncompressed"} chunk`,
    decoded.label === sample.label && decoded.expansion === sample.expansion,
  )
  check(`remoteId is filled from the object id (${compress ? "z" : "raw"})`, decoded.remoteId === "obj-1")
}

const category = {
  containerId: crypto.randomUUID(),
  id: "cat-1",
  label: "人物",
  expansion: "",
  color: "#808080",
  version: 1,
  isCategory: true,
  childOrder: ["chunk-1", "chunk-2"],
  categoryOrder: [],
}
const encCat = C.encodeChunk({ ...category }, ks)
const refCat = refDecode(encCat, ks.keys[category.containerId])
check("category keeps childOrder", JSON.stringify(refCat.childOrder) === JSON.stringify(category.childOrder))
check("category is marked", refCat.isCategory === true)

{
  // Reading must not go through Data.decompressed at all: on the real device
  // that call is not raw DEFLATE, which is what broke every existing chunk.
  const saved = FakeData.prototype.decompressed
  FakeData.prototype.decompressed = function () {
    throw new Error("platform decompress must not be used for reading")
  }
  const cid = crypto.randomUUID()
  const kb = Array.from(crypto.randomBytes(32))
  const only = { master: new Uint8Array(32), keys: { [cid]: kb }, extras: {}, dirty: false }
  const obj = refEncode({ ...sample, containerId: cid, remoteId: "" }, kb, { compress: true })
  let ok = false
  try {
    ok = C.decodeChunk({ id: "o", data: obj.data, meta: cid }, only).expansion === sample.expansion
  } catch (e) {
    ok = false
  }
  FakeData.prototype.decompressed = saved
  check("compressed chunks decode without the platform decompressor", ok)
}


console.log("keystore key shapes")
// new Uint8Array(x) fails silently for two of these, which is exactly how
// "every object failed to decrypt" happens with a keystore that opened fine.
const shapes = {
  "number array": keyBytes,
  "base64 string": Buffer.from(keyBytes).toString("base64"),
  "stringified typed array": Object.fromEntries(keyBytes.map((b, i) => [String(i), b])),
}
for (const [name, stored] of Object.entries(shapes)) {
  const cid = crypto.randomUUID()
  const shaped = { master: new Uint8Array(32), keys: { [cid]: stored }, extras: {}, dirty: false }
  const obj = refEncode({ ...sample, containerId: cid, remoteId: "" }, keyBytes)
  let ok = false
  try {
    ok = C.decodeChunk({ id: "o", data: obj.data, meta: cid }, shaped).expansion === sample.expansion
  } catch (e) {
    ok = false
  }
  check(`keystore key stored as ${name} decodes`, ok)
}
{
  const cid = crypto.randomUUID()
  const shaped = { master: new Uint8Array(32), keys: { [cid]: [1, 2, 3] }, extras: {}, dirty: false }
  let msg = ""
  try {
    C.decodeChunk({ id: "o", data: "AAAA", meta: cid }, shaped)
  } catch (e) {
    msg = String(e)
  }
  check("a wrong-length key is named, not mistaken for a bad key", /形状不对/.test(msg), msg)
}

console.log("failure summary")
{
  const cid = crypto.randomUUID()
  const emptyKs = { master: new Uint8Array(32), keys: {}, extras: {}, dirty: false }
  const listed = {
    chunks: [],
    failed: 2,
    total: 2,
    failures: [
      { id: "a", meta: cid, reason: "keystore 中缺少 meta=" + cid + " 的密钥", keyPresent: false, compressed: true },
      { id: "b", meta: cid, reason: "keystore 中缺少 meta=" + cid + " 的密钥", keyPresent: false, compressed: true },
    ],
  }
  const lines = C.summarizeFailures(listed, emptyKs).join("\n")
  check("empty keystore is called out by name", /一个密钥都没有/.test(lines), lines)
  check("identical reasons collapse into one bucket", /× 2/.test(lines), lines)
}
{
  const populated = { master: new Uint8Array(32), keys: { other: keyBytes }, extras: {}, dirty: false }
  const listed = {
    chunks: [], failed: 1, total: 1,
    failures: [{ id: "a", meta: "abc", reason: "keystore 中缺少 meta=abc 的密钥", keyPresent: false, compressed: false }],
  }
  const lines = C.summarizeFailures(listed, populated).join("\n")
  check("keys present but not matching points at a mismatched account", /不同的账户/.test(lines), lines)
}
{
  const cid = crypto.randomUUID()
  const populated = { master: new Uint8Array(32), keys: { [cid]: keyBytes }, extras: {}, dirty: false }
  const listed = {
    chunks: [], failed: 1, total: 1,
    failures: [{ id: "a", meta: cid, reason: "对象 a 解密失败", keyPresent: true, compressed: true }],
  }
  const lines = C.summarizeFailures(listed, populated).join("\n")
  check("key present and decryption failing points at encryption_key", /encryption_key 不是这个账户/.test(lines), lines)
}
check("no failures means no summary", C.summarizeFailures({ chunks: [], failed: 0, total: 0, failures: [] }, ks).length === 0)

console.log("keystore blob")
const ks2 = { master: new Uint8Array(crypto.randomBytes(32)), keys: { a: keyBytes }, extras: { iv: "legacy-iv", data: "legacy-data" }, dirty: false }
const blob = C.encodeKeystoreBlob(ks2)
const inner = JSON.parse(Buffer.from(blob, "base64").toString("utf8"))
check("keystore version is 2", inner.version === 2)
check("legacy iv / data are carried through", inner.iv === "legacy-iv" && inner.data === "legacy-data")
check("nonce is 24 bytes", Array.isArray(inner.nonce) && inner.nonce.length === 24)
const opened = nacl.secretbox.open(new Uint8Array(inner.sdata), new Uint8Array(inner.nonce), ks2.master)
check("userscript opens our keystore", opened != null && JSON.stringify(JSON.parse(Buffer.from(opened).toString("utf8")).keys.a) === JSON.stringify(keyBytes))

console.log("import / export")
const exported = C.makeExport([{ ...sample }, { ...category }])
check("export counts chunks and categories", exported.counts.chunks === 1 && exported.counts.categories === 1)
check("export drops remoteId", exported.chunks.every((c) => c.remoteId === undefined))
const reimported = C.parseImport(JSON.stringify(exported))
check("re-import round-trips", reimported.length === 2 && reimported[0].expansion === sample.expansion)
check("bare array is accepted", C.parseImport(JSON.stringify([sample])).length === 1)
try {
  C.parseImport('{"format":"something-else","chunks":[]}')
  check("wrong format is rejected", false)
} catch {
  check("wrong format is rejected", true)
}

console.log("sync planning")
const remote = [
  { ...sample, remoteId: "r1", containerId: "c1" },
  { id: "only-remote", containerId: "c2", remoteId: "r2", label: "旧的", expansion: "old", color: "#333", version: 1, isCategory: false },
]
const incoming = [
  { ...sample, expansion: "blue eyes, changed", containerId: "" },
  { id: "brand-new", containerId: "", label: "新的", expansion: "new", color: "#333", version: 1, isCategory: false },
]
const merge = C.planSync(incoming, remote, "merge")
check("merge only creates", merge.create.length === 1 && merge.update.length === 0 && merge.remove.length === 0)
const update = C.planSync(incoming, remote, "update")
check("update creates and updates", update.create.length === 1 && update.update.length === 1 && update.remove.length === 0)
check("update reuses the remote containerId", update.update[0].containerId === "c1" && update.update[0].remoteId === "r1")
const mirror = C.planSync(incoming, remote, "mirror")
check("mirror also removes", mirror.remove.length === 1 && mirror.remove[0].id === "only-remote")
check("mirror never removes the root", C.planSync([], [{ id: C.ROOT_ID, containerId: C.ROOT_ID, remoteId: "rr", label: "", expansion: "", color: "", version: 1, isCategory: true }], "mirror").remove.length === 0)

console.log("grouping")
const library = [
  { id: C.ROOT_ID, containerId: C.ROOT_ID, label: "Root", expansion: "", color: "", version: 1, isCategory: true, childOrder: ["loose-1"], categoryOrder: ["cat-1"] },
  { ...category, childOrder: ["chunk-1"] },
  { ...sample },
  { id: "loose-1", containerId: "c9", label: "散装", expansion: "solo", color: "#333", version: 1, isCategory: false },
]
const groups = C.groupChunks(library)
check("category group comes first", groups[0].category?.id === "cat-1" && groups[0].items[0].id === "chunk-1")
check("loose chunks get their own bucket", groups[groups.length - 1].category === null && groups[groups.length - 1].items[0].id === "loose-1")
check("every chunk is placed exactly once", groups.reduce((n, g) => n + g.items.length, 0) === 2)
check("search matches label and expansion", C.searchChunks(library, "blue").length === 1 && C.searchChunks(library, "散装").length === 1)
check("empty query returns all non-categories", C.searchChunks(library, "  ").length === 2)

console.log(failures === 0 ? "\n✓ all chunk checks passed" : `\n✗ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
