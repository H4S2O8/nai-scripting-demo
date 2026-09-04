/**
 * Raw DEFLATE (RFC 1951) decoder.
 *
 * NovelAI compresses user objects with raw DEFLATE. `Data.decompressed("zlib")`
 * was supposed to be the same thing — Apple's compression framework documents
 * COMPRESSION_ZLIB as raw DEFLATE — but the on-device probe says otherwise, and
 * without an inflate we cannot read a single existing chunk. So the decoder is
 * vendored rather than borrowed.
 *
 * Algorithm is tinf / tiny-inflate (Joergen Ibsen; JS port by Devon Govett),
 * zlib licence, with a growable output buffer since the decompressed size is
 * not known in advance. Fuzzed against node's zlib in dev/test_inflate.mjs.
 */

type Tree = { table: Uint16Array; trans: Uint16Array }

function makeTree(): Tree {
  return { table: new Uint16Array(16), trans: new Uint16Array(288) }
}

const LENGTH_BITS = new Uint8Array(30)
const LENGTH_BASE = new Uint16Array(30)
const DIST_BITS = new Uint8Array(30)
const DIST_BASE = new Uint16Array(30)

/** Code-length alphabet order from RFC 1951 §3.2.7. */
const CLC_ORDER = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
])

function buildBitsBase(
  bits: Uint8Array,
  base: Uint16Array,
  delta: number,
  first: number,
) {
  for (let i = 0; i < delta; i++) bits[i] = 0
  for (let i = 0; i < 30 - delta; i++) bits[i + delta] = Math.floor(i / delta)
  let sum = first
  for (let i = 0; i < 30; i++) {
    base[i] = sum
    sum += 1 << bits[i]
  }
}

buildBitsBase(LENGTH_BITS, LENGTH_BASE, 4, 3)
buildBitsBase(DIST_BITS, DIST_BASE, 2, 1)
// Length code 285 is the documented special case: 258 bytes, no extra bits.
LENGTH_BITS[28] = 0
LENGTH_BASE[28] = 258

/** Bytes the bit buffer may read past the end before we call it truncated. */
const MAX_OVERREAD = 4

const FIXED_LITERAL = makeTree()
const FIXED_DISTANCE = makeTree()

;(function buildFixedTrees() {
  for (let i = 0; i < 7; i++) FIXED_LITERAL.table[i] = 0
  FIXED_LITERAL.table[7] = 24
  FIXED_LITERAL.table[8] = 152
  FIXED_LITERAL.table[9] = 112
  for (let i = 0; i < 24; i++) FIXED_LITERAL.trans[i] = 256 + i
  for (let i = 0; i < 144; i++) FIXED_LITERAL.trans[24 + i] = i
  for (let i = 0; i < 8; i++) FIXED_LITERAL.trans[24 + 144 + i] = 280 + i
  for (let i = 0; i < 112; i++) FIXED_LITERAL.trans[24 + 144 + 8 + i] = 144 + i

  for (let i = 0; i < 5; i++) FIXED_DISTANCE.table[i] = 0
  FIXED_DISTANCE.table[5] = 32
  for (let i = 0; i < 32; i++) FIXED_DISTANCE.trans[i] = i
})()

class Stream {
  source: Uint8Array
  sourceIndex = 0
  tag = 0
  bitcount = 0
  overread = 0
  dest: Uint8Array
  destLen = 0
  literalTree = makeTree()
  distanceTree = makeTree()
  lengths = new Uint8Array(288 + 32)
  offsets = new Uint16Array(16)

  constructor(source: Uint8Array) {
    this.source = source
    this.dest = new Uint8Array(Math.max(1024, source.length * 4))
  }

  /** The decompressed size is unknown up front, so the buffer grows on demand. */
  reserve(extra: number) {
    if (this.destLen + extra <= this.dest.length) return
    let size = this.dest.length * 2
    while (size < this.destLen + extra) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.dest.subarray(0, this.destLen))
    this.dest = grown
  }

  /**
   * The bit buffer refills in 8-bit steps until it holds 24 bits, so a
   * well-formed stream legitimately reads a few bytes past the end — those
   * bits are never consumed. Feed zeros for those, but count them: reading
   * far past the end means the stream really was truncated.
   */
  byte(): number {
    if (this.sourceIndex >= this.source.length) {
      this.sourceIndex++
      if (++this.overread > MAX_OVERREAD) {
        throw new Error("DEFLATE 数据在结束前被截断")
      }
      return 0
    }
    return this.source[this.sourceIndex++]
  }

  getBit(): number {
    if (this.bitcount-- === 0) {
      this.tag = this.byte()
      this.bitcount = 7
    }
    const bit = this.tag & 1
    this.tag >>>= 1
    return bit
  }

  readBits(count: number, base: number): number {
    if (!count) return base
    while (this.bitcount < 24) {
      this.tag |= this.byte() << this.bitcount
      this.bitcount += 8
    }
    const value = this.tag & (0xffff >>> (16 - count))
    this.tag >>>= count
    this.bitcount -= count
    return value + base
  }

  decodeSymbol(tree: Tree): number {
    while (this.bitcount < 24) {
      this.tag |= this.byte() << this.bitcount
      this.bitcount += 8
    }
    let sum = 0
    let cur = 0
    let len = 0
    let tag = this.tag
    do {
      cur = 2 * cur + (tag & 1)
      tag >>>= 1
      len++
      sum += tree.table[len]
      cur -= tree.table[len]
      if (len >= 16) throw new Error("DEFLATE 哈夫曼码超长，数据已损坏")
    } while (cur >= 0)
    this.tag = tag
    this.bitcount -= len
    return tree.trans[sum + cur]
  }
}

function buildTree(tree: Tree, lengths: Uint8Array, off: number, num: number, offsets: Uint16Array) {
  for (let i = 0; i < 16; i++) tree.table[i] = 0
  for (let i = 0; i < num; i++) tree.table[lengths[off + i]]++
  tree.table[0] = 0
  let sum = 0
  for (let i = 0; i < 16; i++) {
    offsets[i] = sum
    sum += tree.table[i]
  }
  for (let i = 0; i < num; i++) {
    if (lengths[off + i]) tree.trans[offsets[lengths[off + i]]++] = i
  }
}

function decodeTrees(d: Stream) {
  const codeTree = makeTree()
  const hlit = d.readBits(5, 257)
  const hdist = d.readBits(5, 1)
  const hclen = d.readBits(4, 4)

  for (let i = 0; i < 19; i++) d.lengths[i] = 0
  for (let i = 0; i < hclen; i++) d.lengths[CLC_ORDER[i]] = d.readBits(3, 0)
  buildTree(codeTree, d.lengths, 0, 19, d.offsets)

  let num = 0
  while (num < hlit + hdist) {
    const symbol = d.decodeSymbol(codeTree)
    if (symbol === 16) {
      const prev = d.lengths[num - 1]
      for (let length = d.readBits(2, 3); length; length--) d.lengths[num++] = prev
    } else if (symbol === 17) {
      for (let length = d.readBits(3, 3); length; length--) d.lengths[num++] = 0
    } else if (symbol === 18) {
      for (let length = d.readBits(7, 11); length; length--) d.lengths[num++] = 0
    } else {
      d.lengths[num++] = symbol
    }
  }

  buildTree(d.literalTree, d.lengths, 0, hlit, d.offsets)
  buildTree(d.distanceTree, d.lengths, hlit, hdist, d.offsets)
}

function inflateBlock(d: Stream, literal: Tree, distance: Tree) {
  for (;;) {
    let symbol = d.decodeSymbol(literal)
    if (symbol === 256) return
    if (symbol < 256) {
      d.reserve(1)
      d.dest[d.destLen++] = symbol
      continue
    }
    symbol -= 257
    if (symbol >= 30) throw new Error("DEFLATE 长度码越界，数据已损坏")
    const length = d.readBits(LENGTH_BITS[symbol], LENGTH_BASE[symbol])
    const distSymbol = d.decodeSymbol(distance)
    if (distSymbol >= 30) throw new Error("DEFLATE 距离码越界，数据已损坏")
    const offset = d.destLen - d.readBits(DIST_BITS[distSymbol], DIST_BASE[distSymbol])
    if (offset < 0) throw new Error("DEFLATE 回溯距离越界，数据已损坏")
    d.reserve(length)
    // Copies may overlap (that is how runs are encoded), so copy byte by byte.
    for (let i = 0; i < length; i++) d.dest[d.destLen++] = d.dest[offset + i]
  }
}

function inflateStored(d: Stream) {
  while (d.bitcount > 8) {
    d.sourceIndex--
    d.bitcount -= 8
  }
  const length = d.source[d.sourceIndex + 1] * 256 + d.source[d.sourceIndex]
  const inverse = d.source[d.sourceIndex + 3] * 256 + d.source[d.sourceIndex + 2]
  if (length !== (~inverse & 0xffff)) {
    throw new Error("DEFLATE 存储块长度校验失败")
  }
  d.sourceIndex += 4
  if (d.sourceIndex + length > d.source.length) {
    throw new Error("DEFLATE 存储块超出数据末尾")
  }
  d.reserve(length)
  for (let i = 0; i < length; i++) d.dest[d.destLen++] = d.source[d.sourceIndex++]
  d.bitcount = 0
}

/** Decompress a raw DEFLATE stream (no zlib or gzip wrapper). */
export function inflateRaw(source: Uint8Array): Uint8Array {
  const d = new Stream(source)
  let final = 0
  do {
    final = d.getBit()
    const type = d.readBits(2, 0)
    if (type === 0) inflateStored(d)
    else if (type === 1) inflateBlock(d, FIXED_LITERAL, FIXED_DISTANCE)
    else if (type === 2) {
      decodeTrees(d)
      inflateBlock(d, d.literalTree, d.distanceTree)
    } else throw new Error("DEFLATE 块类型无效")
  } while (!final)
  return d.dest.slice(0, d.destLen)
}

/** Strip a zlib (RFC 1950) or gzip (RFC 1952) wrapper, then inflate. */
export function inflateAuto(source: Uint8Array): Uint8Array {
  if (source.length >= 2) {
    // gzip: 1f 8b 08
    if (source[0] === 0x1f && source[1] === 0x8b && source[2] === 8) {
      let index = 10
      const flags = source[3]
      if (flags & 4) index += 2 + source[index] + (source[index + 1] << 8)
      if (flags & 8) while (source[index++] !== 0) {}
      if (flags & 16) while (source[index++] !== 0) {}
      if (flags & 2) index += 2
      return inflateRaw(source.subarray(index))
    }
    // zlib: low nibble 8, and the two bytes are a multiple of 31
    const cmf = source[0]
    if ((cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | source[1]) % 31 === 0) {
      return inflateRaw(source.subarray(2))
    }
  }
  return inflateRaw(source)
}
