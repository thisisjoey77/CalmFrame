import { describe, expect, it } from 'vitest'
import {
  AREA_LIMIT,
  AREA_WINDOW_FRACTION,
  GRID_CELLS,
  GRID_COLS,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_SCREEN_FRACTION,
  THUMBNAIL_MAX_WIDTH
} from '../shared/config'
import { SRGB8_TO_LINEAR, linearToSrgb } from './luminance'
import {
  encodeGridRgba8,
  linearToSrgb8,
  thumbnailDeviceSize,
  thumbnailShareOfAreaLimit
} from './thumbnail'

describe('thumbnail encoding (Phase 5)', () => {
  it('stays within one 8-bit code of the exact sRGB encoding', () => {
    let worst = 0
    for (let i = 0; i <= 100000; i++) {
      const l = i / 100000
      worst = Math.max(worst, Math.abs(linearToSrgb8(l) - 255 * linearToSrgb(l)))
    }
    expect(worst).toBeLessThanOrEqual(1)
  })

  it('round-trips every 8-bit code', () => {
    for (let code = 0; code < 256; code++) {
      expect(linearToSrgb8(SRGB8_TO_LINEAR[code])).toBe(code)
    }
  })

  it('clamps values outside 0..1', () => {
    expect(linearToSrgb8(-0.5)).toBe(0)
    expect(linearToSrgb8(1.5)).toBe(255)
    expect(linearToSrgb8(NaN)).toBe(0)
  })

  it('encodes RGBA and RGB grids cell by cell, top row first, opaque', () => {
    const rgba = new Float32Array(GRID_CELLS * 4)
    const rgb = new Float32Array(GRID_CELLS * 3)
    // Cell 0 is white, the last cell of the first row is mid-grey, the last cell red.
    const set = (i: number, r: number, g: number, b: number): void => {
      rgba.set([r, g, b, 1], i * 4)
      rgb.set([r, g, b], i * 3)
    }
    set(0, 1, 1, 1)
    set(GRID_COLS - 1, 0.2158605, 0.2158605, 0.2158605) // sRGB 128
    set(GRID_CELLS - 1, 1, 0, 0)
    for (const [grid, channels] of [
      [rgba, 4],
      [rgb, 3]
    ] as const) {
      const out = new Uint8Array(GRID_CELLS * 4)
      encodeGridRgba8(grid, channels, out)
      expect(Array.from(out.subarray(0, 4))).toEqual([255, 255, 255, 255])
      expect(Array.from(out.subarray((GRID_COLS - 1) * 4, GRID_COLS * 4))).toEqual([
        128, 128, 128, 255
      ])
      expect(Array.from(out.subarray(4, 8))).toEqual([0, 0, 0, 255])
      expect(Array.from(out.subarray((GRID_CELLS - 1) * 4))).toEqual([255, 0, 0, 255])
    }
  })

  it('refuses a buffer that is too small', () => {
    expect(() => encodeGridRgba8(new Float32Array(GRID_CELLS * 3), 3, new Uint8Array(4))).toThrow()
  })
})

describe('thumbnail size (Phase 5)', () => {
  it('is exactly 240x135 on a 1080p screen, and never larger', () => {
    expect(thumbnailDeviceSize(1920, 1080)).toEqual({ width: 240, height: 135 })
    expect(thumbnailDeviceSize(2880, 1800)).toEqual({ width: 240, height: 135 })
    expect(thumbnailDeviceSize(3840, 2160)).toEqual({ width: 240, height: 135 })
  })

  it('shrinks with smaller screens, keeping the grid aspect ratio', () => {
    const s = thumbnailDeviceSize(1366, 768)
    expect(s.width).toBeLessThan(THUMBNAIL_MAX_WIDTH)
    expect(s.height).toBeLessThan(THUMBNAIL_MAX_HEIGHT)
    expect(s.width / s.height).toBeCloseTo(96 / 54, 1)
  })

  it('stays under the WCAG area limit on every common screen', () => {
    for (const [w, h] of [
      [1024, 768],
      [1280, 720],
      [1366, 768],
      [1920, 1080],
      [1920, 1200],
      [2560, 1440],
      [2880, 1800],
      [3840, 2160]
    ]) {
      const share = thumbnailShareOfAreaLimit(thumbnailDeviceSize(w, h), w, h)
      expect(share, `${w}x${h}`).toBeLessThan(1)
    }
    // At 1080p it fills about 56% of the limit (32,400 of 57,600 px).
    expect(thumbnailShareOfAreaLimit({ width: 240, height: 135 }, 1920, 1080)).toBeCloseTo(
      0.5625,
      4
    )
  })

  it('takes a screen fraction that keeps any screen under the limit', () => {
    expect(THUMBNAIL_MAX_SCREEN_FRACTION).toBeLessThan(Math.sqrt(AREA_LIMIT) * AREA_WINDOW_FRACTION)
  })
})
