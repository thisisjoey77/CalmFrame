import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { drawStatusIcon, encodePng } from './trayIcon'

const pixel = (rgba: Uint8Array, size: number, x: number, y: number): number[] =>
  Array.from(rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4))

/** Minimal PNG reader for the test: chunks, CRCs and the unfiltered pixels. */
function readPng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  const types: string[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = png.readUInt32BE(offset + 8 + length)
    expect(crc).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0)
    types.push(type)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect(Array.from(data.subarray(8))).toEqual([8, 6, 0, 0, 0])
    }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  expect(types).toEqual(['IHDR', 'IDAT', 'IEND'])
  const raw = inflateSync(Buffer.concat(idat))
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0)
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4)
  }
  return { width, height, rgba }
}

describe('tray icons (Phase 5)', () => {
  it('encodes a PNG that decodes back to the same pixels', () => {
    const rgba = drawStatusIcon('smoothing', 24)
    const back = readPng(encodePng(rgba, 24, 24))
    expect(back.width).toBe(24)
    expect(back.height).toBe(24)
    expect(Array.from(back.rgba)).toEqual(Array.from(rgba))
  })

  it('refuses pixels that do not match the size', () => {
    expect(() => encodePng(new Uint8Array(10), 2, 2)).toThrow()
  })

  it('leaves the corners transparent and the centre opaque', () => {
    for (const status of ['protected', 'smoothing', 'off'] as const) {
      for (const size of [16, 20, 24, 32]) {
        const icon = drawStatusIcon(status, size)
        expect(pixel(icon, size, 0, 0)[3]).toBe(0)
        expect(pixel(icon, size, size - 1, size - 1)[3]).toBe(0)
      }
    }
    const p = drawStatusIcon('protected', 32)
    expect(pixel(p, 32, 16, 16)).toEqual([46, 160, 67, 255])
  })

  it('gives each status its own shape: a white wave, a hollow centre with a slash', () => {
    const s = drawStatusIcon('smoothing', 32)
    let white = 0
    for (let i = 0; i < s.length; i += 4) {
      if (s[i] === 255 && s[i + 1] === 255 && s[i + 2] === 255 && s[i + 3] === 255) white++
    }
    expect(white).toBeGreaterThan(40) // the wave
    expect(pixel(s, 32, 16, 5)).toEqual([56, 139, 253, 255]) // the disc above it
    expect(pixel(drawStatusIcon('protected', 32), 32, 16, 5)).toEqual([46, 160, 67, 255])
    const o = drawStatusIcon('off', 32)
    expect(pixel(o, 32, 16, 16)[3]).toBe(255) // the slash crosses the centre
    expect(pixel(o, 32, 10, 10)[3]).toBe(0) // the ring is hollow off the slash
  })
})
