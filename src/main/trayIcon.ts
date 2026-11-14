/**
 * Tray icons for the three statuses (docs/SPEC.md, Phase 5), drawn in code so there are no
 * image files to keep in step. Each status has its own shape as well as its own colour, so
 * the icon reads without colour vision:
 * - Protected: a filled green disc.
 * - Smoothing: a blue disc with a flat white line across it (the flattened flicker).
 * - Protection off: a grey ring with a slash through it.
 *
 * Electron's createFromBitmap takes a platform-dependent pixel format, so the icons are
 * encoded as PNG, which createFromBuffer decodes the same way everywhere. No Electron
 * imports here, so the drawing is unit-tested.
 */

import { crc32, deflateSync } from 'node:zlib'
import type { ProtectionStatus } from '../shared/status'

type Rgb = readonly [number, number, number]

/** Calm colours with a dark edge, so the icon holds up on light and dark taskbars. */
const COLORS: Record<ProtectionStatus, Rgb> = {
  protected: [46, 160, 67],
  smoothing: [56, 139, 253],
  off: [139, 148, 158]
}
const EDGE: Rgb = [20, 24, 29]
const WHITE: Rgb = [255, 255, 255]

/** Sub-samples per pixel along each axis, for anti-aliased edges. */
const SUPERSAMPLE = 4

interface Layer {
  color: Rgb
  /** Is the point (in units of the icon size, 0..1 each way) inside this layer? */
  inside(x: number, y: number): boolean
}

function layersFor(status: ProtectionStatus, size: number): Layer[] {
  // The edge is about one pixel wide at any size.
  const edge = 1 / size
  const r = 0.46
  const dist = (x: number, y: number): number => Math.hypot(x - 0.5, y - 0.5)
  const disc = (radius: number, color: Rgb): Layer => ({
    color,
    inside: (x, y) => dist(x, y) <= radius
  })
  const ring = (outer: number, inner: number, color: Rgb): Layer => ({
    color,
    inside: (x, y) => {
      const d = dist(x, y)
      return d <= outer && d >= inner
    }
  })
  const fill = COLORS[status]
  if (status === 'protected') return [disc(r, EDGE), disc(r - edge, fill)]
  if (status === 'smoothing') {
    // A gentle white wave: flicker turned into a soft ripple. A straight bar read as a
    // "no entry" sign.
    const half = Math.max(0.065, edge)
    const amplitude = 0.09
    const wave = (x: number): number => 0.5 + amplitude * Math.sin((x - 0.18) * 2 * Math.PI * 1.55)
    return [
      disc(r, EDGE),
      disc(r - edge, fill),
      {
        color: WHITE,
        inside: (x, y) => Math.abs(y - wave(x)) <= half && x >= 0.18 && x <= 0.82
      }
    ]
  }
  // Off: a ring and a slash from top right to bottom left, both with a dark edge.
  const width = Math.max(0.12, 2 * edge)
  const slash = (w: number): ((x: number, y: number) => boolean) => {
    return (x, y) => Math.abs(x + y - 1) / Math.SQRT2 <= w / 2 && dist(x, y) <= r
  }
  return [
    ring(r, r - width - 2 * edge, EDGE),
    { color: EDGE, inside: slash(width + 2 * edge) },
    ring(r - edge, r - width - edge, fill),
    { color: fill, inside: slash(width) }
  ]
}

/**
 * Draw the icon for a status as RGBA8, size x size, row 0 at the top. Pixels outside the
 * shape are fully transparent; edges are anti-aliased by supersampling.
 */
export function drawStatusIcon(status: ProtectionStatus, size: number): Uint8Array {
  const layers = layersFor(status, size)
  const out = new Uint8Array(size * size * 4)
  const n = SUPERSAMPLE * SUPERSAMPLE
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size
          // The topmost layer containing the point wins.
          for (let i = layers.length - 1; i >= 0; i--) {
            if (layers[i].inside(x, y)) {
              const c = layers[i].color
              r += c[0]
              g += c[1]
              b += c[2]
              a++
              break
            }
          }
        }
      }
      const o = (py * size + px) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round((255 * a) / n)
      }
    }
  }
  return out
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** Encode RGBA8 pixels, row 0 at the top, as a PNG (8-bit RGBA, no interlace). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('pixel buffer does not match size')
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // no interlace
  // Each row starts with its filter type, 0 (none).
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1)
    rows[start] = 0
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), start + 1)
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
