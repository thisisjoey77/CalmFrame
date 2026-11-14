import { describe, expect, it } from 'vitest'
import {
  AREA_LIMIT,
  AREA_WINDOW_COLS,
  AREA_WINDOW_ROWS,
  CONCURRENCY_MAX_OPPOSING,
  GRID_CELLS,
  GRID_COLS,
  GRID_ROWS
} from '../shared/config'
import { ConcurrencyGate } from './concurrency'
import type { Rect } from './testing/synthetic'

const WCAG_WINDOW = { cols: AREA_WINDOW_COLS, rows: AREA_WINDOW_ROWS }
/** A quarter of the 32x18 window. */
const NEEDED = AREA_LIMIT * AREA_WINDOW_COLS * AREA_WINDOW_ROWS

function flips(): Int8Array {
  return new Int8Array(GRID_CELLS)
}

function fill(flip: Int8Array, r: Rect, value: (x: number, y: number) => number): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) flip[y * GRID_COLS + x] = value(x, y)
  }
}

function apply(flip: Int8Array, window = WCAG_WINDOW): { counted: Uint8Array; n: number } {
  const counted = new Uint8Array(GRID_CELLS).fill(9)
  const n = new ConcurrencyGate(GRID_COLS, GRID_ROWS, window).apply(flip, counted)
  return { counted, n }
}

const countIn = (counted: Uint8Array, r: Rect): number => {
  let n = 0
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) n += counted[y * GRID_COLS + x]
  }
  return n
}

describe('concurrency rule (Step 5a)', () => {
  it('counts reversals that a quarter of a window makes the same way in one frame', () => {
    expect(NEEDED).toBe(144)
    const patch = { x: 40, y: 20, w: 16, h: 9 }
    const flip = flips()
    fill(flip, patch, () => 1)
    const { counted, n } = apply(flip)
    expect(n).toBe(144)
    expect(countIn(counted, patch)).toBe(144)
  })

  it('counts none when one cell fewer reverses', () => {
    const flip = flips()
    fill(flip, { x: 40, y: 20, w: 13, h: 11 }, () => -1)
    expect(apply(flip).n).toBe(0)
  })

  it('counts nothing on a frame with no reversals, and clears the output', () => {
    const { counted, n } = apply(flips())
    expect(n).toBe(0)
    expect(counted.every((c) => c === 0)).toBe(true)
  })

  it('counts neither direction when cells in one area reverse both ways at once', () => {
    // 60% rising and 40% falling, mixed through a 24x12 block: what a scrolling page does.
    const flip = flips()
    fill(flip, { x: 30, y: 20, w: 24, h: 12 }, (x, y) => ((x + 2 * y) % 5 < 2 ? -1 : 1))
    expect(apply(flip).n).toBe(0)
  })

  it('tolerates a few reversals the other way, up to a quarter as many', () => {
    expect(CONCURRENCY_MAX_OPPOSING).toBe(0.25)
    const block = { x: 30, y: 20, w: 20, h: 10 }
    const mixed = (falling: number): number => {
      const flip = flips()
      let left = falling
      fill(flip, block, (x) => (x % 5 === 0 && left-- > 0 ? -1 : 1))
      return apply(flip).n
    }
    // 160 rising and 40 falling: 40 is exactly a quarter of 160, so the rising cells count.
    expect(mixed(40)).toBe(160)
    // 180 rising and 20 falling in a window that holds them all still counts 180.
    expect(mixed(20)).toBe(180)
  })

  it('counts both directions when each fills its own area', () => {
    // Left half brighter, right half darker, as in a strobe whose halves alternate.
    const flip = flips()
    fill(flip, { x: 0, y: 0, w: 48, h: GRID_ROWS }, () => 1)
    fill(flip, { x: 48, y: 0, w: 48, h: GRID_ROWS }, () => -1)
    expect(apply(flip).n).toBe(GRID_CELLS)
  })

  it('leaves out cells that reverse far from any qualifying window', () => {
    const patch = { x: 10, y: 10, w: 16, h: 9 }
    const stray = { x: 80, y: 45, w: 5, h: 2 }
    const flip = flips()
    fill(flip, patch, () => 1)
    fill(flip, stray, () => 1)
    const { counted, n } = apply(flip)
    expect(n).toBe(144)
    expect(countIn(counted, stray)).toBe(0)
  })

  it('works for a patch in the corner of the grid', () => {
    const flip = flips()
    fill(flip, { x: GRID_COLS - 16, y: GRID_ROWS - 9, w: 16, h: 9 }, () => -1)
    expect(apply(flip).n).toBe(144)
  })

  it('uses the whole grid as the window in IRIS area mode', () => {
    const whole = { cols: GRID_COLS, rows: GRID_ROWS }
    const quarter = flips()
    fill(quarter, { x: 0, y: 0, w: 48, h: 27 }, () => 1)
    expect(apply(quarter, whole).n).toBe(48 * 27)
    const less = flips()
    fill(less, { x: 0, y: 0, w: 48, h: 26 }, () => 1)
    expect(apply(less, whole).n).toBe(0)
  })
})
