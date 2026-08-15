import { execFileSync } from "node:child_process"
import { deflateSync } from "node:zlib"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Draws the Evie mark: the app icon and the menu bar icon.
 *
 * The mark is a solid shape with two slots -- a wall socket, the thing you plug
 * work into. Its geometry is authored in a 34-unit box in
 * `packages/ui/src/components/bot-mark.tsx` and reproduced here to the same
 * numbers, so the icon in the dock and the face in the rail are one drawing at
 * two scales. `apps/landing/app/icon.svg` is the same mark, and the two static
 * colours below are the ones it already commits to -- an app icon cannot react
 * to the theme the way `BotMark`'s tokens do.
 *
 * Generated rather than committed: the mark is nine numbers and two shapes, and
 * nine numbers in a script are reviewable in a way a binary in a diff is not.
 * It also stops @1x and @2x drifting, which is the usual way a tray icon ends
 * up blurry.
 */

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out")

/* --- the mark, in the design's 34-unit box ------------------------------------ */

const BOX = 34
const BODY = { cx: 17, cy: 17, r: 17 }
const SLOTS = [
  { x: 11.6, y: 17.4, w: 3.6, h: 7, r: 1.8 },
  { x: 18.8, y: 17.4, w: 3.6, h: 7, r: 1.8 },
]

/** What `apps/landing/app/icon.svg` commits to. */
const INK = { r: 0x1d, g: 0x1d, b: 0x1d }
const SLOT_INK = { r: 0xff, g: 0xff, b: 0xff }

/**
 * The mark fills 88% of the app icon's canvas.
 *
 * macOS reserves the outer margin for the shadow it draws under every icon; a
 * full-bleed circle reads a size larger than the squircles it sits beside in
 * the dock. The menu bar has no such grid, so the tray icon uses the full box.
 */
const APP_INSET = 0.88
/** 4x4 supersampling. At 16px, coverage is the difference between a mark and a smudge. */
const SAMPLES = 4

const insideCircle = (px, py) => {
  const dx = px - BODY.cx
  const dy = py - BODY.cy
  return dx * dx + dy * dy <= BODY.r * BODY.r
}

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

/**
 * Coverage of the body and of the slots at one pixel, each 0..1.
 *
 * Kept separate so the two outputs can compose them differently: the app icon
 * paints white slots *over* the body, while the template icon knocks them out
 * of the alpha channel entirely.
 */
const coverage = (x, y, size, inset) => {
  const scale = BOX / (size * inset)
  const offset = (size * (1 - inset)) / 2
  let body = 0
  let slot = 0
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const px = (x + (sx + 0.5) / SAMPLES - offset) * scale
      const py = (y + (sy + 0.5) / SAMPLES - offset) * scale
      if (!insideCircle(px, py)) continue
      body += 1
      if (SLOTS.some((rect) => insideRounded(px, py, rect))) slot += 1
    }
  }
  const total = SAMPLES * SAMPLES
  return { body: body / total, slot: slot / total }
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

/** `paint(x, y)` returns `{ r, g, b, a }` with a in 0..255. */
const encodePng = (size, paint) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // 10..12: deflate, adaptive filtering, no interlace — all zero.

  const stride = size * 4 + 1 // one filter byte (0 = None) per scanline
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const { r, g, b, a } = paint(x, y)
      const at = y * stride + 1 + x * 4
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      raw[at + 3] = a
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/* --- the two icons ------------------------------------------------------------ */

/**
 * The menu bar icon: a template image, which carries shape in the alpha channel
 * and no colour at all. macOS tints it for the light bar, the dark bar, and the
 * selected state, which is why the slots are punched out of the alpha rather
 * than painted white -- a white slot would stay white on a white menu bar.
 */
const trayPixel = (size) => (x, y) => {
  const { body, slot } = coverage(x, y, size, 1)
  return { r: 0, g: 0, b: 0, a: Math.round(Math.max(0, body - slot) * 255) }
}

/**
 * The app icon: the mark in its committed colours on a transparent canvas.
 *
 * The slots are composited over the body rather than knocked through it,
 * because here they are white paint, not a hole -- punching them out would show
 * the desktop through the middle of the dock icon.
 */
const appPixel = (size) => (x, y) => {
  const { body, slot } = coverage(x, y, size, APP_INSET)
  if (body <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const t = Math.min(slot / body, 1)
  return {
    r: Math.round(INK.r * (1 - t) + SLOT_INK.r * t),
    g: Math.round(INK.g * (1 - t) + SLOT_INK.g * t),
    b: Math.round(INK.b * (1 - t) + SLOT_INK.b * t),
    a: Math.round(body * 255),
  }
}

mkdirSync(OUT, { recursive: true })

for (const [name, size] of [
  ["trayTemplate.png", 16],
  ["trayTemplate@2x.png", 32],
]) {
  writeFileSync(join(OUT, name), encodePng(size, trayPixel(size)))
  console.log(`icons: out/${name} (${size}x${size})`)
}

writeFileSync(join(OUT, "icon.png"), encodePng(1024, appPixel(1024)))
console.log("icons: out/icon.png (1024x1024)")

/*
 * `.icns` for the packaged bundle. `iconutil` ships with macOS; on any other
 * platform the PNG above is what Electron uses, so a missing tool is a skipped
 * step rather than a failed build.
 */
const ICONSET = join(OUT, "Evie.iconset")
try {
  rmSync(ICONSET, { recursive: true, force: true })
  mkdirSync(ICONSET, { recursive: true })
  // The exact names `iconutil` expects; anything else is silently ignored.
  for (const [name, size] of [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]) {
    writeFileSync(join(ICONSET, name), encodePng(size, appPixel(size)))
  }
  execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", join(OUT, "icon.icns")])
  rmSync(ICONSET, { recursive: true, force: true })
  console.log("icons: out/icon.icns")
} catch (error) {
  rmSync(ICONSET, { recursive: true, force: true })
  console.warn(`icons: skipped icon.icns (${error.message})`)
}
