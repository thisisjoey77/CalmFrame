import { describe, expect, it } from 'vitest'
import { GRID_COLS, GRID_ROWS } from '../shared/config'
import { SummedAreaTable, areaWindow, largestAreaCount, visualFieldWidthCm } from './area'

/** Visible width of a 16:9 screen from its diagonal in inches. */
const widthCm = (diagonalInches: number): number => (diagonalInches * 2.54 * 16) / Math.hypot(16, 9)

/** Deterministic pseudo-random 0/1 mask. */
function randomMask(cells: number, seed: number): Uint8Array {
  const mask = new Uint8Array(cells)
  let s = seed
  for (let i = 0; i < cells; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    mask[i] = s % 3 === 0 ? 1 : 0
  }
  return mask
}

describe('area windows (Step 6)', () => {
  it('uses one third of the grid each way in WCAG mode', () => {
    expect(areaWindow('wcag', GRID_COLS, GRID_ROWS)).toEqual({ cols: 32, rows: 18 })
  })

  it('uses the whole grid in IRIS mode', () => {
    expect(areaWindow('iris', GRID_COLS, GRID_ROWS)).toEqual({ cols: 96, rows: 54 })
  })

  it('makes a 10° field 10.5 cm wide at 60 cm', () => {
    expect(visualFieldWidthCm(60)).toBeCloseTo(10.5, 1)
  })

  it('covers 30% of a 15.6-inch laptop but only 20% of a 24-inch monitor', () => {
    const laptop = areaWindow('calibrated', GRID_COLS, GRID_ROWS, { screenWidthCm: widthCm(15.6) })
    const monitor = areaWindow('calibrated', GRID_COLS, GRID_ROWS, { screenWidthCm: widthCm(24) })
    expect(laptop.cols / GRID_COLS).toBeCloseTo(0.3, 1)
    expect(monitor.cols / GRID_COLS).toBeCloseTo(0.2, 1)
    // A bigger screen means a smaller window, so the same patch is stricter.
    expect(monitor.cols * monitor.rows).toBeLessThan(laptop.cols * laptop.rows)
  })

  it('refuses calibrated mode without a screen width', () => {
    expect(() => areaWindow('calibrated', GRID_COLS, GRID_ROWS)).toThrow()
  })
})

describe('summed-area table', () => {
  it('sums any window like a brute-force count', () => {
    const cols = 13
    const rows = 7
    const mask = randomMask(cols * rows, 42)
    const table = new SummedAreaTable(cols, rows)
    table.buildFromMask(mask)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        for (let h = 1; y + h <= rows; h++) {
          for (let w = 1; x + w <= cols; w++) {
            let brute = 0
            for (let yy = y; yy < y + h; yy++) {
              for (let xx = x; xx < x + w; xx++) brute += mask[yy * cols + xx]
            }
            expect(table.sum(x, y, w, h)).toBe(brute)
          }
        }
      }
    }
  })

  it('finds the best window position for a patch', () => {
    const table = new SummedAreaTable(GRID_COLS, GRID_ROWS)
    const mask = new Uint8Array(GRID_COLS * GRID_ROWS)
    // A 16x9 patch in the bottom-right corner: 144 cells, a quarter of a 32x18 window.
    for (let y = GRID_ROWS - 9; y < GRID_ROWS; y++) {
      for (let x = GRID_COLS - 16; x < GRID_COLS; x++) mask[y * GRID_COLS + x] = 1
    }
    table.buildFromMask(mask)
    expect(table.maxWindowFraction(32, 18)).toBe(0.25)
    expect(table.maxWindowFraction(GRID_COLS, GRID_ROWS)).toBeCloseTo(144 / 5184, 12)
  })

  it('rebuilds cleanly over a previous mask', () => {
    const table = new SummedAreaTable(4, 4)
    table.buildFromMask(new Uint8Array(16).fill(1))
    table.buildFromMask(new Uint8Array(16))
    expect(table.maxWindowFraction(2, 2)).toBe(0)
  })
})

describe('largest count over the area limit (Step 8 graph value)', () => {
  it('finds the k that a quarter of some window reaches', () => {
    const table = new SummedAreaTable(GRID_COLS, GRID_ROWS)
    const counts = new Uint16Array(GRID_COLS * GRID_ROWS)
    // A full window at count 8, with a smaller hotter spot of 20 inside it.
    for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) counts[y * GRID_COLS + x] = 8
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) counts[y * GRID_COLS + x] = 20
    expect(largestAreaCount(counts, 20, { cols: 32, rows: 18 }, table)).toBe(8)
  })

  it('is 0 when nothing reaches the limit', () => {
    const table = new SummedAreaTable(GRID_COLS, GRID_ROWS)
    const counts = new Uint16Array(GRID_COLS * GRID_ROWS)
    counts[0] = 30
    expect(largestAreaCount(counts, 30, { cols: 32, rows: 18 }, table)).toBe(0)
  })
})
