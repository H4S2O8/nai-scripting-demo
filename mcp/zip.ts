/**
 * Minimal ZIP reader for NovelAI's generate-image response.
 *
 * The response is a ZIP holding one PNG. Rather than take a dependency for
 * that, read the central directory and inflate with node's zlib — the archive
 * is one entry, stored or deflated, and nothing else is needed.
 *
 * The central directory is used in preference to scanning local headers
 * because a local header may carry zeroed sizes with a trailing data
 * descriptor; the central directory always has the real values.
 */
import zlib from "node:zlib"

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export type ZipEntry = { name: string; data: Buffer }

function findEndOfCentralDirectory(buf: Buffer): number {
  // The comment field means the record is not necessarily at the very end.
  const earliest = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}

function inflateEntry(method: number, raw: Buffer, name: string): Buffer {
  if (method === 0) return raw
  if (method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`ZIP 条目 ${name} 用了不支持的压缩方法 ${method}`)
}

export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd === -1) throw new Error("不是有效的 ZIP：找不到中央目录结尾")

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("ZIP 中央目录损坏")
    }
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP 条目 ${name} 的本地头损坏`)
    }
    // The local header's own name/extra lengths are authoritative for where the
    // data starts; the central copy of "extra" is frequently a different size.
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength

    entries.push({
      name,
      data: inflateEntry(method, buf.subarray(dataStart, dataStart + compressedSize), name),
    })

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** The first PNG in the archive, which is what a generation returns. */
export function firstPng(buf: Buffer): Buffer {
  const png = readZip(buf).find((entry) => entry.name.toLowerCase().endsWith(".png"))
  if (!png) throw new Error("ZIP 里没有 PNG —— 接口可能返回了错误页")
  return png.data
}
