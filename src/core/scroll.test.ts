import { describe, expect, it } from 'vitest'
import { SCROLL_MIN_CORRELATION } from '../shared/config'
import { ScrollEstimator } from './scroll'

const W = 320
const H = 180
/** A level larger than the screen: random rectangles on grey, as encoded brightness. */
const LEVEL_W = 900
const LEVEL_H = 300
const LEVEL = buildLevel()

function buildLevel(): Float32Array {
  const level = new Float32Array(LEVEL_W * LEVEL_H).fill(90)
  let seed = 12345
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let k = 0; k < 400; k++) {
    const w = 8 + Math.floor(random() * 40)
    const h = 8 + Math.floor(random() * 40)
    const x0 = Math.floor(random() * (LEVEL_W - w))
    const y0 = Math.floor(random() * (LEVEL_H - h))
    const v = 20 + random() * 220
    for (let y = y0; y < y0 + h; y++) level.fill(v, y * LEVEL_W + x0, y * LEVEL_W + x0 + w)
  }
  return level
}

/** The screen with its top-left corner at (ox, oy) of the level, times `gain`. */
function view(ox: number, oy: number, gain = 1): Float32Array {
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out[y * W + x] = gain * LEVEL[(y + oy) * LEVEL_W + x + ox]
  }
  return out
}

describe('scroll estimator: how far the picture moved, from its edges (experimental)', () => {
  it('refuses a picture too small to measure in', () => {
    expect(() => new ScrollEstimator(12, 12)).toThrow()
  })

  it('measures a steady scroll to a fraction of a pixel', () => {
    const scroll = new ScrollEstimator(W, H)
    for (let n = 0; n < 30; n++) {
      scroll.step(view(5 * n, 20 + 2 * n))
      if (n === 0) continue
      expect(scroll.correlation).toBeGreaterThan(0.9)
      expect(scroll.dx).toBeCloseTo(5, 1)
      expect(scroll.dy).toBeCloseTo(2, 1)
    }
  })

  it('follows a shake on top of the scroll, frame by frame', () => {
    const scroll = new ScrollEstimator(W, H)
    const shakes = [0, 3, -4, 2, -1, 4, -3, 0, 1, -2]
    let ox = 0
    let oy = 40
    scroll.step(view(ox, oy))
    for (const shake of shakes) {
      ox += 6
      oy += shake
      scroll.step(view(ox, oy))
      expect(scroll.dx).toBeCloseTo(6, 1)
      expect(scroll.dy).toBeCloseTo(shake, 1)
    }
  })

  it('is not thrown by a flash: brightness changes, the edges stay where they are', () => {
    const scroll = new ScrollEstimator(W, H)
    for (let n = 0; n < 30; n++) {
      // Every third frame at a quarter of the brightness.
      scroll.step(view(7 * n, 30, n % 3 === 0 ? 0.25 : 1))
      if (n === 0) continue
      expect(scroll.dx).toBeCloseTo(7, 1)
      expect(scroll.dy).toBeCloseTo(0, 1)
    }
  })

  it('assumes the usual scroll through a frame with nothing in it', () => {
    const scroll = new ScrollEstimator(W, H)
    for (let n = 0; n < 12; n++) scroll.step(view(4 * n, 30))
    scroll.step(new Float32Array(W * H).fill(255))
    expect(scroll.correlation).toBeLessThan(SCROLL_MIN_CORRELATION)
    expect(scroll.dx).toBeCloseTo(4, 1)
    expect(scroll.dy).toBeCloseTo(0, 1)
  })

  it('reports no movement for a picture that stands still, or has no edges at all', () => {
    const still = new ScrollEstimator(W, H)
    for (let n = 0; n < 5; n++) still.step(view(100, 50))
    expect(still.dx).toBeCloseTo(0, 2)
    expect(still.dy).toBeCloseTo(0, 2)
    const blank = new ScrollEstimator(W, H)
    for (let n = 0; n < 5; n++) blank.step(new Float32Array(W * H).fill(n % 2 === 0 ? 30 : 220))
    expect(blank.dx).toBe(0)
    expect(blank.dy).toBe(0)
  })
})
