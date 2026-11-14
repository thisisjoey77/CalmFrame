import { describe, expect, it } from 'vitest'
import { GRID_CELLS, GRID_COLS, GRID_ROWS } from '../shared/config'
import { averageToGrid } from './gridAverage'
import { SRGB8_TO_LINEAR, relativeLuminance } from './luminance'

/** RGBA image filled by fn(x, y) -> sRGB grey code. */
function image(width: number, height: number, fn: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y)
      const p = (y * width + x) * 4
      px[p] = v
      px[p + 1] = v
      px[p + 2] = v
      px[p + 3] = 255
    }
  }
  return px
}

const checkerboard = (x: number, y: number): number => ((x + y) % 2 === 0 ? 0 : 255)

function cellY(grid: Float32Array, cell: number): number {
  return relativeLuminance(grid[cell * 4], grid[cell * 4 + 1], grid[cell * 4 + 2])
}

function yRange(grid: Float32Array, cells: number): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (let c = 0; c < cells; c++) {
    const y = cellY(grid, c)
    min = Math.min(min, y)
    max = Math.max(max, y)
  }
  return { min, max }
}

describe('averageToGrid (Step 2)', () => {
  it('reads a 1-pixel checkerboard as Y = 0.5 in every cell, not 0.21', () => {
    // 960x540 gives 10x10 pixels per cell, so each cell holds equal black and white.
    const grid = averageToGrid(
      image(960, 540, checkerboard),
      960,
      540,
      new Float32Array(GRID_CELLS * 4)
    )
    const { min, max } = yRange(grid, GRID_CELLS)
    expect(min).toBeCloseTo(0.5, 6)
    expect(max).toBeCloseTo(0.5, 6)
  })

  it('stays within 0.0025 of 0.5 when cells hold a fractional number of pixels', () => {
    // 1366x768: 14.23 x 14.22 pixels per cell. A checkerboard over any rectangle is off by at
    // most half a pixel's worth of area, 0.5 / 202 = 0.0025.
    const grid = averageToGrid(
      image(1366, 768, checkerboard),
      1366,
      768,
      new Float32Array(GRID_CELLS * 4)
    )
    const { min, max } = yRange(grid, GRID_CELLS)
    expect(min).toBeGreaterThanOrEqual(0.5 - 0.0025)
    expect(max).toBeLessThanOrEqual(0.5 + 0.0025)
  })

  it('returns a flat image as its own linear level, with alpha 1', () => {
    const grid = averageToGrid(
      image(1000, 563, () => 149),
      1000,
      563,
      new Float32Array(GRID_CELLS * 4)
    )
    for (let c = 0; c < GRID_CELLS; c++) {
      expect(grid[c * 4]).toBeCloseTo(SRGB8_TO_LINEAR[149], 6)
      expect(grid[c * 4 + 3]).toBe(1)
    }
  })

  it('weights pixels that straddle a cell edge by the share inside the cell', () => {
    // 10 px over 4 cells is 2.5 px each. White at x < 3: cell 0 [0, 2.5) is all white, cell 1
    // [2.5, 5) is white for 0.5 of its 2.5 px, cells 2 and 3 are black.
    const grid = averageToGrid(
      image(10, 1, (x) => (x < 3 ? 255 : 0)),
      10,
      1,
      new Float32Array(16),
      4,
      1
    )
    expect(grid[0]).toBeCloseTo(1, 6)
    expect(grid[4]).toBeCloseTo(0.2, 6)
    expect(grid[8]).toBe(0)
    expect(grid[12]).toBe(0)
  })

  it('puts the top of the image in grid row 0', () => {
    const grid = averageToGrid(
      image(960, 540, (_x, y) => (y < 10 ? 255 : 0)),
      960,
      540,
      new Float32Array(GRID_CELLS * 4)
    )
    expect(cellY(grid, 0)).toBeCloseTo(1, 6)
    expect(cellY(grid, GRID_COLS)).toBe(0)
    expect(cellY(grid, (GRID_ROWS - 1) * GRID_COLS)).toBe(0)
  })

  it('keeps the mean linear level of a noisy image at a fractional size', () => {
    // Cells have equal area and tile the image, so their mean equals the pixel mean.
    let seed = 12345
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed >>> 24
    }
    const w = 1366
    const h = 771
    const px = image(w, h, () => rand())
    const grid = averageToGrid(px, w, h, new Float32Array(GRID_CELLS * 4))
    let pixelMean = 0
    for (let p = 0; p < w * h; p++) pixelMean += SRGB8_TO_LINEAR[px[p * 4]]
    pixelMean /= w * h
    let cellMean = 0
    for (let c = 0; c < GRID_CELLS; c++) cellMean += grid[c * 4]
    cellMean /= GRID_CELLS
    expect(cellMean).toBeCloseTo(pixelMean, 6)
  })

  it('rejects an image smaller than the grid or a short buffer', () => {
    const out = new Float32Array(GRID_CELLS * 4)
    expect(() => averageToGrid(new Uint8Array(4 * 50 * 50), 50, 50, out)).toThrow(/smaller/)
    expect(() => averageToGrid(new Uint8Array(8), 960, 540, out)).toThrow(/Expected/)
    expect(() =>
      averageToGrid(new Uint8Array(4 * 960 * 540), 960, 540, new Float32Array(4))
    ).toThrow(/Output/)
  })
})
