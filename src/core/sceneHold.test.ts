import { describe, expect, it } from 'vitest'
import {
  GAME_HOLD_CELLS_ACROSS,
  GAME_HOLD_MS,
  GRID_CELLS,
  GRID_COLS,
  GRID_ROWS,
  LUMINANCE_THRESHOLD,
  TARGET_RESIDUAL
} from '../shared/config'
import { Detector } from './detector'
import { relativeLuminance } from './luminance'
import { SceneHold, holdCellSize } from './sceneHold'

// 4x4 pixels per cell of the analysis grid.
const W = GRID_COLS * 4
const H = GRID_ROWS * 4
const FPS = 60
const FRAME_MS = 1000 / FPS
/** The level scrolls left by this many pixels a frame: 1,500 px/s at 1920 wide. */
const SCROLL = 5

/** A level made of flat 16 px blocks, as linear grey, wherever it is on screen. */
const BLOCKS = new Map<number, number>()
function level(sceneX: number, sceneY: number): number {
  const key = Math.floor(sceneX / 16) * 1000 + Math.floor(sceneY / 16)
  let v = BLOCKS.get(key)
  if (v === undefined) {
    const f = Math.sin(key * 12.9898) * 43758.5453
    v = 0.05 + 0.3 * (f - Math.floor(f))
    BLOCKS.set(key, v)
  }
  return v
}

type Tint = readonly [number, number, number]
const GREY: Tint = [1, 1, 1]

/** The screen with the level scrolled by `ox` pixels, in a tint, linear R, G, B. */
function screen(ox: number, tint: Tint = GREY): Float32Array {
  const image = new Float32Array(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = level(x + ox, y)
      const p = (y * W + x) * 3
      image[p] = v * tint[0]
      image[p + 1] = v * tint[1]
      image[p + 2] = v * tint[2]
    }
  }
  return image
}

/** A white flash over the picture: every value moved `amount` of the way to white. */
function whiten(image: Float32Array, amount: number): Float32Array {
  return image.map((v) => v + amount * (1 - v))
}

/** The analysis grid of a linear image: 3 values per cell. */
function analysisGrid(image: Float32Array): Float32Array {
  const grid = new Float32Array(GRID_CELLS * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = (Math.floor(y / 4) * GRID_COLS + Math.floor(x / 4)) * 3
      const p = (y * W + x) * 3
      grid[c] += image[p] / 16
      grid[c + 1] += image[p + 1] / 16
      grid[c + 2] += image[p + 2] / 16
    }
  }
  return grid
}

function meanLuminance(image: Float32Array): number {
  let sum = 0
  for (let p = 0; p < image.length; p += 3) {
    sum += relativeLuminance(image[p], image[p + 1], image[p + 2])
  }
  return sum / (image.length / 3)
}

function largestDifference(a: Float32Array, b: Float32Array): number {
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  return worst
}

function meanDifference(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/** Whether frame n of a 10 Hz flash, starting at frame `from`, is a bright one. */
const flashing = (n: number, from: number): boolean =>
  n >= from && Math.floor((n - from) / 3) % 2 === 0

describe('game mode: hold the usual look (experimental)', () => {
  it('uses cells an 80th of the picture wide, and never under 2 px', () => {
    expect(GAME_HOLD_CELLS_ACROSS).toBe(80)
    expect([holdCellSize(1280), holdCellSize(1920), holdCellSize(640)]).toEqual([16, 24, 8])
    expect(holdCellSize(100)).toBe(2)
  })

  it('leaves a level that only scrolls exactly as it is', () => {
    const hold = new SceneHold(W, H)
    const out = new Float32Array(W * H * 3)
    for (let n = 0; n < 90; n++) {
      const image = screen(n * SCROLL)
      hold.step(image, n === 0 ? 0 : SCROLL, 0, n * FRAME_MS)
      hold.draw(image, out)
      expect(largestDifference(out, image), `frame ${n}`).toBe(0)
    }
  })

  it('takes a 10 Hz white flash off a scrolling level and leaves the level', () => {
    const hold = new SceneHold(W, H)
    const before = new Detector({ trigger: 'strict' })
    const after = new Detector({ trigger: 'strict' })
    const out = new Float32Array(W * H * 3)
    let hazardBefore = false
    let hazardAfter = false
    let worstDrift = 0
    let worstPicture = 0
    for (let n = 0; n < 120; n++) {
      const calm = screen(n * SCROLL)
      const image = flashing(n, 30) ? whiten(calm, 0.7) : calm
      hold.step(image, n === 0 ? 0 : SCROLL, 0, n * FRAME_MS)
      hold.draw(image, out)
      const cells = analysisGrid(out)
      hazardBefore = before.step(analysisGrid(image), n * FRAME_MS).hazard || hazardBefore
      hazardAfter = after.step(cells, n * FRAME_MS).hazard || hazardAfter
      // The picture stays the level without the flash: in brightness, and patch by patch.
      worstDrift = Math.max(worstDrift, Math.abs(meanLuminance(out) - meanLuminance(calm)))
      worstPicture = Math.max(worstPicture, meanDifference(cells, analysisGrid(calm)))
    }
    expect(hazardBefore).toBe(true)
    expect(hazardAfter).toBe(false)
    expect(worstDrift).toBeLessThan(TARGET_RESIDUAL)
    expect(worstPicture).toBeLessThan(TARGET_RESIDUAL)
  })

  it('leaves the frames between the flashes exactly as they are', () => {
    const hold = new SceneHold(W, H)
    const out = new Float32Array(W * H * 3)
    let untouched = 0
    for (let n = 0; n < 240; n++) {
      // One bright frame in six: the level looks as usual five frames out of six.
      const bright = n >= 60 && n % 6 === 0
      const calm = screen(n * SCROLL)
      const image = bright ? whiten(calm, 0.7) : calm
      hold.step(image, n === 0 ? 0 : SCROLL, 0, n * FRAME_MS)
      hold.draw(image, out)
      if (!bright && n >= 120) {
        expect(meanDifference(out, image), `frame ${n}`).toBeLessThan(0.01)
        untouched++
      }
    }
    expect(untouched).toBe(100)
  })

  it('lifts a blink to black back to the level, with its colour', () => {
    const tint: Tint = [0.2, 1, 0.4]
    const hold = new SceneHold(W, H)
    const out = new Float32Array(W * H * 3)
    for (let n = 0; n < 180; n++) {
      const dark = n >= 60 && n % 6 === 0
      const calm = screen(n * SCROLL, tint)
      const image = dark ? new Float32Array(W * H * 3) : calm
      hold.step(image, n === 0 ? 0 : SCROLL, 0, n * FRAME_MS)
      hold.draw(image, out)
      if (dark && n >= 120) {
        expect(Math.abs(meanLuminance(out) - meanLuminance(calm))).toBeLessThan(TARGET_RESIDUAL)
        // Green stays the strongest channel: lifted toward the level's colour, not to grey.
        const grid = analysisGrid(out)
        const c = (27 * GRID_COLS + 48) * 3
        expect(grid[c + 1]).toBeGreaterThan(2 * grid[c])
      }
    }
  })

  it('dims with one factor for all three channels, so the hue stays', () => {
    const tint: Tint = [0.2, 1, 0.4]
    const hold = new SceneHold(W, H)
    const out = new Float32Array(W * H * 3)
    for (let n = 0; n < 120; n++) {
      const calm = screen(n * SCROLL, tint)
      // The flash triples the brightness and keeps the colour.
      const bright = flashing(n, 60)
      const image = bright ? calm.map((v) => 3 * v) : calm
      hold.step(image, n === 0 ? 0 : SCROLL, 0, n * FRAME_MS)
      hold.draw(image, out)
      if (!bright || n < 90) continue
      const p = (100 * W + 200) * 3
      expect(out[p] / out[p + 1]).toBeCloseTo(tint[0] / tint[1], 4)
      expect(out[p + 2] / out[p + 1]).toBeCloseTo(tint[2] / tint[1], 4)
      expect(out[p + 1]).toBeLessThan(0.5 * image[p + 1])
    }
  })

  it('leaves a lone mover alone, and re-lits it with its surroundings in a flash', () => {
    const hold = new SceneHold(W, H)
    const out = new Float32Array(W * H * 3)
    /** A bright 16 px square that moves down the still screen, 4 px a frame. */
    const withMover = (image: Float32Array, n: number): { image: Float32Array; at: number } => {
      const top = 20 + ((4 * n) % 150)
      for (let y = top; y < top + 16; y++) {
        for (let x = 100; x < 116; x++) image.fill(0.8, (y * W + x) * 3, (y * W + x) * 3 + 3)
      }
      return { image, at: ((top + 8) * W + 108) * 3 }
    }
    for (let n = 0; n < 150; n++) {
      const bright = n >= 90 && n % 6 === 0
      const { image: calm, at } = withMover(screen(0), n)
      const image = bright ? whiten(calm, 0.6) : calm
      hold.step(image, 0, 0, n * FRAME_MS)
      hold.draw(image, out)
      if (n < 30) continue
      if (!bright) {
        // A calm frame: the mover is as bright as it was drawn, to half a percent. (The
        // targets under its path are nudged while it passes, which is all that is left.)
        expect(out[at], `frame ${n}`).toBeCloseTo(image[at], 2)
      } else if (n >= 102) {
        // A flash frame: it is dimmed with the picture around it, by the same factor. That
        // costs it most of its lead over the level (the flash added the same white to
        // both), but it is not flattened into it: it stays brighter than the picture is
        // on average.
        expect(out[at]).toBeLessThan(0.5 * image[at])
        expect(out[at]).toBeGreaterThan(1.05 * meanLuminance(out))
      }
    }
  })

  it('follows a real change of brightness, GAME_HOLD_MS late', () => {
    const hold = new SceneHold(W, H)
    const out = new Float32Array(W * H * 3)
    const dark = screen(0)
    const lit = dark.map((v) => 2 * v)
    const seen: number[] = []
    for (let n = 0; n < 90; n++) {
      const image = n < 30 ? dark : lit
      hold.step(image, 0, 0, n * FRAME_MS)
      hold.draw(image, out)
      seen.push(meanLuminance(out))
    }
    const held = 30 + Math.floor(GAME_HOLD_MS / FRAME_MS) - 1
    expect(seen[held]).toBeLessThan(meanLuminance(dark) + LUMINANCE_THRESHOLD)
    expect(seen[held]).toBeLessThan(0.75 * meanLuminance(lit))
    expect(seen[89]).toBeCloseTo(meanLuminance(lit), 2)
  })

  it('gives up: detail a flash frame lacks comes back only as coarse as a cell', () => {
    const hold = new SceneHold(W, H)
    const out = new Float32Array(W * H * 3)
    // A still screen of one-pixel stripes, and a flash that is plain white.
    const stripes = new Float32Array(W * H * 3)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++)
        stripes.fill(x % 2 === 0 ? 0.1 : 0.5, (y * W + x) * 3, (y * W + x) * 3 + 3)
    }
    const white = new Float32Array(W * H * 3).fill(1)
    for (let n = 0; n < 91; n++) {
      const image = n >= 60 && n % 6 === 0 ? white : stripes
      hold.step(image, 0, 0, n * FRAME_MS)
      hold.draw(image, out)
    }
    // Frame 90 was a white one. Its brightness is right, and the stripes, 0.4 apart in
    // the picture, are gone: neighbouring pixels differ by a twentieth of that at most.
    const p = (100 * W + 200) * 3
    expect(out[p]).toBeCloseTo(0.3, 1)
    expect(Math.abs(out[p] - out[p + 3])).toBeLessThan(0.02)
  })
})
