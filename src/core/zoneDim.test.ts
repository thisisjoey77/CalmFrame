import { describe, expect, it } from 'vitest'
import {
  CAPTURE_FPS,
  GAME_RISE_FACTOR,
  GAME_ZONE_COLS,
  GAME_ZONE_ROWS,
  GRID_COLS,
  GRID_ROWS,
  LUMINANCE_THRESHOLD
} from '../shared/config'
import { filterParams } from './filterMath'
import { relativeLuminance } from './luminance'
import { ZoneDimTargets, dimImage, gridToZones } from './zoneDim'

const ZONES = GAME_ZONE_COLS * GAME_ZONE_ROWS
// A small screen for the tests: 4x4 pixels per zone.
const W = GAME_ZONE_COLS * 4
const H = GAME_ZONE_ROWS * 4

const flat = (level: number): Float64Array => new Float64Array(ZONES).fill(level)

function image(r: number, g: number, b: number): Float32Array {
  const px = new Float32Array(W * H * 3)
  for (let p = 0; p < px.length; p += 3) {
    px[p] = r
    px[p + 1] = g
    px[p + 2] = b
  }
  return px
}

function dim(px: Float32Array, zones: ArrayLike<number>, target: ArrayLike<number>): Float32Array {
  const out = new Float32Array(px.length)
  dimImage(px, W, H, zones, target, GAME_ZONE_COLS, GAME_ZONE_ROWS, out)
  return out
}

describe('game mode: dim, never whiten (experimental)', () => {
  it('uses 16x9 zones of 6x6 grid cells', () => {
    expect([GAME_ZONE_COLS, GAME_ZONE_ROWS]).toEqual([16, 9])
    expect(GRID_COLS / GAME_ZONE_COLS).toBe(6)
    expect(GRID_ROWS / GAME_ZONE_ROWS).toBe(6)
  })

  it("averages the grid's luminance into zones", () => {
    // Left half of the grid white, right half black, in RGBA as the GPU reads it back.
    const grid = new Float32Array(GRID_COLS * GRID_ROWS * 4)
    for (let y = 0; y < GRID_ROWS; y++) {
      for (let x = 0; x < GRID_COLS / 2; x++) {
        const p = (y * GRID_COLS + x) * 4
        grid[p] = grid[p + 1] = grid[p + 2] = 1
      }
    }
    const zones = new Float64Array(ZONES)
    gridToZones(grid, 4, GRID_COLS, GRID_ROWS, GAME_ZONE_COLS, GAME_ZONE_ROWS, zones)
    expect(zones[0]).toBeCloseTo(1, 6)
    expect(zones[GAME_ZONE_COLS / 2 - 1]).toBeCloseTo(1, 6)
    expect(zones[GAME_ZONE_COLS / 2]).toBeCloseTo(0, 6)
    expect(zones[ZONES - 1]).toBeCloseTo(0, 6)
    expect(() => gridToZones(grid, 4, GRID_COLS, GRID_ROWS, 10, 9, zones)).toThrow()
  })

  it('lets a target fall at once and rise only slowly, never above the zone itself', () => {
    const targets = new ZoneDimTargets(ZONES)
    targets.step(flat(0.8), 0.25)
    expect(targets.state[0]).toBe(0.8)
    targets.step(flat(0.3), 0.25)
    expect(targets.state[0]).toBe(0.3)
    targets.step(flat(0.8), 0.25)
    expect(targets.state[0]).toBeCloseTo(0.3 + 0.25 * GAME_RISE_FACTOR * 0.5, 12)
    for (let i = 0; i < 200; i++) {
      targets.step(flat(0.8), 0.25)
      expect(targets.state[0]).toBeLessThanOrEqual(0.8)
    }
    expect(targets.state[0]).toBeCloseTo(0.8, 6)
  })

  it('leaves a steady picture exactly as it is', () => {
    const px = image(0.6, 0.3, 0.1)
    const level = relativeLuminance(0.6, 0.3, 0.1)
    const out = dim(px, flat(level), flat(level))
    for (let i = 0; i < px.length; i++) expect(out[i]).toBe(px[i])
  })

  it('only ever dims, keeps black black and keeps every colour its hue', () => {
    const px = image(0.9, 0.45, 0.09)
    const level = relativeLuminance(0.9, 0.45, 0.09)
    const out = dim(px, flat(level), flat(level / 3))
    expect(out[0]).toBeCloseTo(0.3, 6)
    expect(out[1]).toBeCloseTo(0.15, 6)
    expect(out[2]).toBeCloseTo(0.03, 6)
    // A target above the zone's brightness lifts nothing.
    const untouched = dim(px, flat(level), flat(1))
    for (let i = 0; i < px.length; i++) expect(untouched[i]).toBe(px[i])
    const black = dim(image(0, 0, 0), flat(0), flat(0.5))
    for (let i = 0; i < black.length; i++) expect(black[i]).toBe(0)
  })

  it('calms a full-screen strobe between two greys to under the flash threshold', () => {
    // 10 Hz between 0.25 and 0.85, 60 fps, with the alpha the smoothing filter would use.
    const lo = 0.25
    const hi = 0.85
    const { alpha } = filterParams(hi - lo, 10, CAPTURE_FPS)
    const targets = new ZoneDimTargets(ZONES)
    let min = Infinity
    let max = -Infinity
    for (let frame = 0; frame < 4 * CAPTURE_FPS; frame++) {
      const level = Math.floor(frame / 3) % 2 === 0 ? hi : lo
      targets.step(flat(level), alpha)
      if (frame < 3 * CAPTURE_FPS) continue
      const seen = dim(image(level, level, level), flat(level), targets.state)[0]
      min = Math.min(min, seen)
      max = Math.max(max, seen)
      expect(seen).toBeLessThanOrEqual(level)
    }
    expect(max - min).toBeLessThan(LUMINANCE_THRESHOLD)
    // It settles at the dark level, not in the middle: nothing was lifted.
    expect(min).toBeCloseTo(lo, 6)
  })

  describe('what it gives up', () => {
    it('shows a flashing picture at the brightness of its darkest frames', () => {
      const targets = new ZoneDimTargets(ZONES)
      for (let frame = 0; frame < 120; frame++) {
        targets.step(flat(frame % 6 < 3 ? 0.9 : 0.2), 0.05)
      }
      const bright = dim(image(0.9, 0.9, 0.9), flat(0.9), targets.state)[0]
      expect(bright).toBeLessThan(0.3)
    })

    it('goes to black when the flash goes to black', () => {
      // Black cannot be dimmed further and is never lifted, so white frames come down to it.
      const targets = new ZoneDimTargets(ZONES)
      for (let frame = 0; frame < 120; frame++) targets.step(flat(frame % 6 < 3 ? 1 : 0), 0.05)
      const white = dim(image(1, 1, 1), flat(1), targets.state)[0]
      expect(white).toBeLessThan(LUMINANCE_THRESHOLD)
    })
  })
})
