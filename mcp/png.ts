import { inflateSync } from "node:zlib"

/**
 * The tEXt chunks of a PNG, read up to the first IDAT.
 *
 * NovelAI writes the whole request there: `Comment` is JSON with the prompt,
 * negative, seed, steps, size and the V4 character captions, and `Source` names
 * the model ("NovelAI Diffusion V5 0ADF9AB7"). They sit before the pixel data,
 * so the first few KB of a file are enough.
 */
export function pngText(png: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return out
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString("ascii")
    if (type === "IDAT" || type === "IEND") break
    if (type === "tEXt" && at + 8 + length <= png.length) {
      const data = png.subarray(at + 8, at + 8 + length)
      const split = data.indexOf(0)
      if (split > 0) out[data.subarray(0, split).toString("latin1")] = data.subarray(split + 1).toString("utf8")
    }
    at += 12 + length
  }
  return out
}

/**
 * Share of pixels that are actually see-through (alpha below half), or null
 * when this PNG layout is not one the decoder handles.
 *
 * Reading the colour type is not enough: V5 returns RGBA for every image,
 * opaque or not, with alpha sitting at 254–255 everywhere. Only the pixels say
 * whether a requested cut-out happened, so they are decoded — 8-bit,
 * non-interlaced RGBA or grey+alpha, which is what NovelAI sends.
 */
export function transparentFraction(png: Buffer): number | null {
  if (png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString("ascii")
    const data = png.subarray(at + 8, at + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      break
    }
    at += 12 + length
  }
  // No alpha channel at all: nothing can be transparent. (A tRNS palette entry
  // could be, but NovelAI never sends one.)
  if (colorType !== 4 && colorType !== 6) return 0
  if (bitDepth !== 8 || interlace !== 0 || width === 0 || height === 0) return null

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const bpp = colorType === 6 ? 4 : 2
  const stride = width * bpp
  if (raw.length < height * (stride + 1)) return null

  let prev = Buffer.alloc(stride)
  let line = Buffer.alloc(stride)
  let clear = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? line[i - bpp] : 0
      const up = prev[i]
      const upLeft = i >= bpp ? prev[i - bpp] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) return null
      line[i] = (row[i] + predictor) & 0xff
    }
    for (let i = bpp - 1; i < stride; i += bpp) if (line[i] < 128) clear++
    const swap = prev
    prev = line
    line = swap
  }
  return clear / (width * height)
}
