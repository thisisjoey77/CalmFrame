import { describe, expect, it } from 'vitest'
import { SceneGrid } from './sceneGrid'

const W = 96
const H = 60
const CELL = 8

/** A level that is one flat grey per 8x8 block of the scene, wherever it is on screen. */
function blockLevel(sceneCol: number, sceneRow: number): number {
  const h = Math.sin(sceneCol * 12.9898 + sceneRow * 78.233) * 43758.5453
  return 0.1 + 0.8 * (h - Math.floor(h))
}

/** The screen when the scene has scrolled by (ox, oy) whole pixels. */
function screen(ox: number, oy: number): Float32Array {
  const image = new Float32Array(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = blockLevel(Math.floor((x + ox) / CELL), Math.floor((y + oy) / CELL))
      image.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3)
    }
  }
  return image
}

describe('scene grid: cells attached to the scrolling scene (experimental)', () => {
  it('refuses a cell size it cannot use', () => {
    expect(() => new SceneGrid(W, H, 0)).toThrow()
    expect(() => new SceneGrid(W, H, 2.5)).toThrow()
    expect(() => new SceneGrid(10, 10, 8)).toThrow()
  })

  it('keeps one slot on one piece of the scene while it scrolls', () => {
    const grid = new SceneGrid(W, H, CELL)
    const remembered = new Float32Array(grid.slots)
    let ox = 0
    let oy = 0
    let checked = 0
    for (let n = 0; n < 80; n++) {
      const dx = n === 0 ? 0 : 3
      const dy = n === 0 ? 0 : n % 4 === 0 ? 1 : 0
      ox += dx
      oy += dy
      grid.step(screen(ox, oy), dx, dy)
      for (let l = 0; l < grid.cells; l++) {
        const slot = grid.slotOf[l]
        if (slot < 0) continue
        if (!grid.settled[l]) {
          remembered[slot] = grid.mean[l * 3]
        } else if (grid.whole[l]) {
          // The cell lies on one block of the scene, so its mean never changes.
          expect(grid.mean[l * 3]).toBeCloseTo(remembered[slot], 5)
          checked++
        }
      }
    }
    expect(grid.offsetX).toBe(ox)
    expect(checked).toBeGreaterThan(1000)
  })

  it('reads the mean of exactly the part of a cell that is on screen', () => {
    const grid = new SceneGrid(W, H, CELL)
    grid.step(screen(0, 0), 0, 0)
    // Scroll by 3 px: the first visible column of cells is 5 px wide, and still flat.
    grid.step(screen(3, 0), 3, 0)
    expect(grid.whole[0]).toBe(0)
    expect(grid.mean[0]).toBeCloseTo(blockLevel(0, 0), 5)
    expect(grid.whole[1]).toBe(1)
    expect(grid.mean[3]).toBeCloseTo(blockLevel(1, 0), 5)
    expect(grid.centreX(1)).toBeCloseTo(1.5 * CELL - 3, 9)
  })

  it('takes a scroll of a fraction of a pixel: a flat picture stays flat', () => {
    const grid = new SceneGrid(W, H, CELL)
    const flat = new Float32Array(W * H * 3).fill(0.37)
    for (let n = 0; n < 20; n++) {
      grid.step(flat, 2.3, -0.7)
      for (let l = 0; l < grid.cells; l++) {
        if (grid.slotOf[l] >= 0) expect(grid.mean[l * 3 + 1]).toBeCloseTo(0.37, 5)
      }
    }
  })

  it('marks a cell as new until it has been seen whole', () => {
    const grid = new SceneGrid(W, H, CELL)
    grid.step(screen(0, 0), 0, 0)
    // On the first frame nothing has been seen before.
    expect(grid.settled[0]).toBe(0)
    grid.step(screen(0, 0), 0, 0)
    expect(grid.settled[0]).toBe(1)
    // Scroll 4 px: a new column is half on screen at the right edge.
    grid.step(screen(4, 0), 4, 0)
    const last = W / CELL
    expect(grid.slotOf[last]).toBeGreaterThanOrEqual(0)
    expect(grid.whole[last]).toBe(0)
    expect(grid.settled[last]).toBe(0)
    grid.step(screen(8, 0), 4, 0)
    // Now whole for the first time, so still not settled on this frame.
    const col = W / CELL - 1
    expect(grid.whole[col]).toBe(1)
    expect(grid.settled[col]).toBe(0)
    grid.step(screen(8, 0), 0, 0)
    expect(grid.settled[col]).toBe(1)
  })

  it('interpolates between cells that are at least half on screen', () => {
    const grid = new SceneGrid(W, H, CELL)
    grid.step(screen(0, 0), 0, 0)
    grid.step(screen(6, 0), 6, 0)
    // The first column of cells is 2 px wide now, so pixels there use the second.
    expect(grid.columnCell[0]).toBe(1)
    expect(grid.columnWeight[0]).toBe(0)
    for (let x = 0; x < W; x++) {
      expect(grid.columnCell[x] + 1).toBeLessThan(grid.cols)
      expect(grid.columnWeight[x]).toBeGreaterThanOrEqual(0)
      expect(grid.columnWeight[x]).toBeLessThanOrEqual(1)
    }
  })
})
