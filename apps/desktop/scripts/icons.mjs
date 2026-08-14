import { deflateSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Draws the menu bar icon.
 *
 * A generated icon rather than a committed binary: the mark is nine numbers and
 * a rounded rectangle, and nine numbers in a script are reviewable in a way a
 * 400-byte PNG in a diff is not. It also keeps @1x and @2x from ever drifting,
 * which is the usual way tray icons end up blurry.
 *
 * macOS template images carry shape in the alpha channel and ignore colour --
 * the system tints them for the light bar, the dark bar, and the inverted
 * selection state. So every pixel here is black at some coverage.
 *
 * The mark is the bot face from `packages/ui/src/components/bot-mark.tsx`: a
 * squircle with a slot cut across its lower third.
 */

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out")

/* --- geometry, in fractions of the icon box ---------------------------------- */

const BODY = { x: 0.09, y: 0.13, w: 0.82, h: 0.74, r: 0.3 }
const SLOT = { x: 0.29, y: 0.6, w: 0.42, h: 0.13, r: 0.065 }
/** 4x4 supersampling. At 16px, coverage is the difference between a mark and a smudge. */
const SAMPLES = 4

/** Signed coverage test for a rounded rect, in normalised coordinates. */
const insideRounded = (px, py, rect) => {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  if (px < rect.x || px > right || py < rect.y || py > bottom) return false
  const r = Math.min(rect.r, rect.w / 2, rect.h / 2)
  // Only the four corner boxes can fall outside; everything else is the cross.
  const cx = px < rect.x + r ? rect.x + r : px > right - r ? right - r : px
  const cy = py < rect.y + r ? rect.y + r : py > bottom - r ? bottom - r : py
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

const alphaAt = (x, y, size) => {
  let hits = 0
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const px = (x + (sx + 0.5) / SAMPLES) / size
      const py = (y + (sy + 0.5) / SAMPLES) / size
      if (insideRounded(px, py, BODY) && !insideRounded(px, py, SLOT)) hits += 1
    }
  }
  return Math.round((hits / (SAMPLES * SAMPLES)) * 255)
}

/* --- a minimal PNG encoder ---------------------------------------------------- */

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const encodePng = (size) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // 10..12: deflate, adaptive filtering, no interlace — all zero.

  // One filter byte (0 = None) per scanline, then RGBA. Black at every pixel;
  // the shape lives entirely in alpha, which is what makes it a template image.
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      raw[y * stride + 1 + x * 4 + 3] = alphaAt(x, y, size)
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
for (const [name, size] of [
  ["trayTemplate.png", 16],
  ["trayTemplate@2x.png", 32],
]) {
  writeFileSync(join(OUT, name), encodePng(size))
  console.log(`icons: out/${name} (${size}x${size})`)
}
