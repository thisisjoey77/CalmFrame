import { describe, expect, it } from 'vitest'
import { CAPTURE_FPS, LUMINANCE_THRESHOLD, TARGET_RESIDUAL } from '../shared/config'
import { filterParams } from './filterMath'
import { ReferenceFilter } from './referenceFilter'
import { correctChannel, correctImage } from './regionCorrect'

// A small screen for the tests: a 96x54 grid with 2x2 pixels per cell.
const COLS = 96
const ROWS = 54
const PX = 2
const W = COLS * PX
const H = ROWS * PX

type Painter = (x: number, y: number) => number

/** A grey image, linear R = G = B per pixel. */
function paint(level: Painter): Float32Array {
  const image = new Float32Array(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3
      image[p] = image[p + 1] = image[p + 2] = level(x, y)
    }
  }
  return image
}

/** The image's cell means, R, G, B per cell (each cell holds a whole number of pixels). */
function gridOf(image: Float32Array): Float32Array {
  const grid = new Float32Array(COLS * ROWS * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cell = Math.floor(y / PX) * COLS + Math.floor(x / PX)
      for (let ch = 0; ch < 3; ch++) grid[cell * 3 + ch] += image[(y * W + x) * 3 + ch] / (PX * PX)
    }
  }
  return grid
}

function correct(image: Float32Array, target: ArrayLike<number>): Float32Array {
  const out = new Float32Array(W * H * 3)
  correctImage(image, W, H, gridOf(image), 3, target, COLS, ROWS, out)
  return out
}

/** A picture with detail at every scale down to one pixel, between 0.1 and 0.9. */
const picture: Painter = (x, y) =>
  0.5 + 0.25 * Math.sin(x / 9) * Math.cos(y / 7) + 0.15 * (((x >> 1) + y) % 2 ? 1 : -1)

const at = (image: Float32Array, x: number, y: number): number => image[(y * W + x) * 3]

describe('per-region brightness correction (stretch, trail #10)', () => {
  it('leaves a region that is already at its target exactly as it is', () => {
    for (const x of [0, 0.2, 0.5, 1]) {
      expect(correctChannel(x, 0.3, 0.3)).toBeCloseTo(x, 12)
    }
  })

  it('scales a region that is too bright toward black, and one too dark toward white', () => {
    // Too bright: black stays black, everything keeps its ratio.
    expect(correctChannel(0, 0.8, 0.4)).toBe(0)
    expect(correctChannel(0.8, 0.8, 0.4)).toBeCloseTo(0.4, 12)
    expect(correctChannel(1, 0.8, 0.4)).toBeCloseTo(0.5, 12)
    // Too dark: white stays white, a black region is lifted to the target.
    expect(correctChannel(1, 0.2, 0.6)).toBe(1)
    expect(correctChannel(0.2, 0.2, 0.6)).toBeCloseTo(0.6, 12)
    expect(correctChannel(0, 0, 0.5)).toBeCloseTo(0.5, 12)
    // Nothing to scale: an all-black region asked to stay black, an all-white one asked to
    // be darker (scaled down, as for any too-bright region).
    expect(correctChannel(0, 0, 0)).toBe(0)
    expect(correctChannel(1, 1, 0.5)).toBeCloseTo(0.5, 12)
  })

  it("sends a region's mean to its target and never leaves 0..1, so nothing clips", () => {
    const pixels = [0, 0.05, 0.3, 0.3, 0.9, 1, 0.6, 0.45]
    const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length
    for (const target of [0.02, 0.2, mean, 0.7, 0.98]) {
      const out = pixels.map((x) => correctChannel(x, mean, target))
      expect(out.reduce((a, b) => a + b, 0) / out.length).toBeCloseTo(target, 12)
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('returns a still picture unchanged', () => {
    const image = paint(picture)
    const out = correct(image, gridOf(image))
    for (let i = 0; i < image.length; i++) expect(out[i]).toBeCloseTo(image[i], 6)
  })

  it('undoes a flash that brightens the whole picture, with every edge where it is now', () => {
    // The frame is the picture at double brightness; each region's target is the picture's
    // own level. The output is the current frame's detail at the target's brightness.
    const calm = paint((x, y) => 0.5 * picture(x, y))
    const flash = paint(picture)
    const out = correct(flash, gridOf(calm))
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(calm[i], 6)
  })

  it('leaves the same swing as the smoothing filter on a full-screen strobe', () => {
    // 10 Hz, full contrast, 60 fps: the targets are the smoothing filter run on the grid,
    // and on a flat screen every pixel lands on its region's target.
    const { alpha } = filterParams(1, 10, CAPTURE_FPS)
    const targets = new ReferenceFilter(COLS * ROWS)
    const white = paint(() => 1)
    const black = paint(() => 0)
    let lo = Infinity
    let hi = -Infinity
    for (let frame = 0; frame < 4 * CAPTURE_FPS; frame++) {
      const image = Math.floor(frame / 3) % 2 === 0 ? white : black
      targets.step(gridOf(image), alpha)
      if (frame < 3 * CAPTURE_FPS) continue
      const seen = at(correct(image, targets.state), W / 2, H / 2)
      lo = Math.min(lo, seen)
      hi = Math.max(hi, seen)
    }
    expect(hi - lo).toBeCloseTo(TARGET_RESIDUAL, 2)
    expect(hi - lo).toBeLessThan(LUMINANCE_THRESHOLD)
  })

  describe('what it gives up against the smoothing filter', () => {
    // A hard-edged patch strobing between white and black on a still grey screen, one pixel
    // off the cell boundaries. Each region's target is its mean over the two phases.
    const x0 = 30 * PX + 1
    const x1 = 60 * PX + 1
    const y0 = 15 * PX + 1
    const y1 = 35 * PX + 1
    const inside = (x: number, y: number): boolean => x >= x0 && x < x1 && y >= y0 && y < y1
    const still = 0.2
    const bright = paint((x, y) => (inside(x, y) ? 1 : still))
    const dark = paint((x, y) => (inside(x, y) ? 0 : still))
    const gridBright = gridOf(bright)
    const gridDark = gridOf(dark)
    const target = gridBright.map((v, i) => (v + gridDark[i]) / 2)
    const seenBright = correct(bright, target)
    const seenDark = correct(dark, target)
    const swing = (x: number, y: number): number =>
      Math.abs(at(seenBright, x, y) - at(seenDark, x, y))
    /** Distance in pixels from the patch's edge: positive outside, negative inside. */
    const fromEdge = (x: number, y: number): number => {
      const dx = Math.max(x0 - x, x - (x1 - 1))
      const dy = Math.max(y0 - y, y - (y1 - 1))
      return Math.max(dx, dy)
    }

    it('calms the flash, and leaves still content alone, two cells or more from a hard edge', () => {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const d = fromEdge(x, y)
          if (d < -2 * PX) expect(swing(x, y)).toBeLessThan(0.01)
          if (d > 2 * PX) {
            expect(at(seenBright, x, y)).toBeCloseTo(still, 6)
            expect(at(seenDark, x, y)).toBeCloseTo(still, 6)
          }
        }
      }
    })

    it('keeps a flickering rim about a cell wide at the hard edge, on both sides', () => {
      // Just outside the patch the still screen now flickers, and just inside it the flash
      // is only partly removed. The smoothing filter leaves neither.
      expect(swing(x0 - 1, (y0 + y1) / 2)).toBeGreaterThan(LUMINANCE_THRESHOLD)
      expect(swing(x0, (y0 + y1) / 2)).toBeGreaterThan(LUMINANCE_THRESHOLD)
    })

    it('does nothing to a pattern finer than a cell, which keeps its region means steady', () => {
      // A one-pixel checkerboard that inverts: every cell's mean stays 0.5, as it does for
      // the detector (Step 2), so there is nothing to correct and the frame passes through.
      const checker = paint((x, y) => ((x + y) % 2 ? 1 : 0))
      const inverted = paint((x, y) => ((x + y) % 2 ? 0 : 1))
      const out = correct(inverted, gridOf(checker))
      for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(inverted[i], 6)
    })
  })
})
