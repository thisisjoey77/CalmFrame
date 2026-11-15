/**
 * Game mode's second way of calming a hazard: hold the usual look. Experimental, and so far
 * only in the offline render (tools/validate). docs/SPEC.md, "Game mode: hold the usual
 * look".
 *
 * The current frame is always what is drawn, so nothing smears. Each region's brightness is
 * corrected toward a target, as in regionCorrect.ts, with three differences:
 *
 * 1. The targets are attached to the scene (sceneGrid.ts), so a level that only scrolls has
 *    every cell on its target and is left exactly as it is.
 * 2. A target holds still against a flash and follows a real change (holdTarget.ts). The
 *    frames that look as the level usually does pass untouched; only the odd frames out are
 *    pulled back. Nothing is averaged, so nothing ends up hazy or dark for good.
 * 3. A cell is corrected only when the change is shared: when a sizeable part of the
 *    surrounding area window is off its target in the same direction on the same frame.
 *    That is what a flash is, and what the detector counts (Steps 5a and 6). A cell that
 *    changes on its own, such as the player, is left alone (but for the faint trace its
 *    path leaves in the targets under it). In a flash frame such a mover takes its
 *    surroundings' correction, so it is re-lit with the picture around it.
 *
 * Dimming uses one factor for red, green and blue, so a pixel keeps its hue. Lifting is per
 * channel, so a dark frame is lifted toward the remembered colour and not toward grey.
 *
 * What it gives up. sceneHold.test.ts pins the first two:
 * - In a frame that is corrected, the picture is re-lit in patches the size of a cell, so
 *   detail the flash frame itself lacks comes back only that coarsely.
 * - A real change of brightness reaches the viewer GAME_HOLD_MS late.
 * - It needs the scroll. When that is measured wrongly, cells are off their targets
 *   everywhere and the picture is corrected toward stale targets until they catch up.
 */

import {
  AREA_WINDOW_FRACTION,
  CORRECTION_EPSILON,
  GAME_HOLD_CELLS_ACROSS,
  GAME_HOLD_MOVER_MEMORY_MS,
  GAME_HOLD_MOVER_RADIUS,
  GAME_HOLD_OFF_FULL,
  GAME_HOLD_OFF_START,
  GAME_HOLD_SHARED_FULL,
  GAME_HOLD_SHARED_START,
  GAME_HOLD_TOLERANCE,
  LUMA_B,
  LUMA_G,
  LUMA_R
} from '../shared/config'
import { deviation, followTarget } from './holdTarget'
import { correctChannel } from './regionCorrect'
import { SceneGrid } from './sceneGrid'

/** The cell size, in pixels, for a picture this wide: GAME_HOLD_CELLS_ACROSS cells across,
 *  and never under 2 px. */
export function holdCellSize(width: number): number {
  return Math.max(2, Math.round(width / GAME_HOLD_CELLS_ACROSS))
}

export class SceneHold {
  readonly grid: SceneGrid
  /** Per slot of the scene grid: the target, and how long the cell has been off it. */
  private readonly target: Float32Array
  private readonly run: Float32Array
  /** Per slot: 1 while the target is a guess made in a flash frame. */
  private readonly guessed: Uint8Array
  /** Per visible cell, this frame. `cellTarget` is the target before this frame's update,
   *  which is what the frame is corrected toward. */
  private readonly cellTarget: Float32Array
  private readonly off: Float32Array
  private readonly above: Float32Array
  private readonly below: Float32Array
  private readonly shareAbove: Float32Array
  private readonly shareBelow: Float32Array
  /** How much of the correction each visible cell takes, 0 to 1. */
  private readonly strength: Float32Array
  private readonly mover: Float32Array
  private readonly aroundMean: Float32Array
  private readonly aroundTarget: Float32Array
  /** Cells on screen, and those of them whose stored target is already meaningful. */
  private readonly valid: Uint8Array
  private readonly known: Uint8Array
  private readonly calm: Uint8Array
  private readonly knownNear: Float32Array
  private readonly table: Float64Array
  private readonly tableCount: Float64Array
  /** Movers, remembered per cell of a lattice fixed to the screen: the player stays put
   *  there while the scene scrolls under it. */
  private readonly screenCols: number
  private readonly screenRows: number
  private readonly moverMemory: Float32Array
  private readonly windowHalfCols: number
  private readonly windowHalfRows: number
  private lastT: number | null = null

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    const cell = holdCellSize(width)
    const grid = (this.grid = new SceneGrid(width, height, cell))
    this.target = new Float32Array(grid.slots * 3)
    this.run = new Float32Array(grid.slots)
    this.guessed = new Uint8Array(grid.slots)
    this.cellTarget = new Float32Array(grid.cells * 3)
    this.off = new Float32Array(grid.cells)
    this.above = new Float32Array(grid.cells)
    this.below = new Float32Array(grid.cells)
    this.shareAbove = new Float32Array(grid.cells)
    this.shareBelow = new Float32Array(grid.cells)
    this.strength = new Float32Array(grid.cells)
    this.mover = new Float32Array(grid.cells)
    this.aroundMean = new Float32Array(grid.cells * 3)
    this.aroundTarget = new Float32Array(grid.cells * 3)
    this.valid = new Uint8Array(grid.cells)
    this.known = new Uint8Array(grid.cells)
    this.calm = new Uint8Array(grid.cells)
    this.knownNear = new Float32Array(grid.cells)
    this.table = new Float64Array((grid.cols + 1) * (grid.rows + 1))
    this.tableCount = new Float64Array((grid.cols + 1) * (grid.rows + 1))
    this.screenCols = Math.ceil(width / cell)
    this.screenRows = Math.ceil(height / cell)
    this.moverMemory = new Float32Array(this.screenCols * this.screenRows)
    // The detector's area window, as half sizes in cells of this grid.
    this.windowHalfCols = Math.max(1, Math.round((width * AREA_WINDOW_FRACTION) / cell / 2))
    this.windowHalfRows = Math.max(1, Math.round((height * AREA_WINDOW_FRACTION) / cell / 2))
  }

  /**
   * One frame: move with the scene, decide how much each cell is corrected, and update the
   * targets. Call draw() afterwards for the picture.
   * @param image linear R, G, B per pixel, row-major, row 0 at the top
   * @param dx, dy how far the content moved left and up since the last frame (scroll.ts)
   * @param tMs the frame's capture timestamp
   */
  step(image: ArrayLike<number>, dx: number, dy: number, tMs: number): void {
    const first = this.lastT === null
    const dtMs = this.lastT === null ? 0 : Math.max(0, tMs - this.lastT)
    this.lastT = tMs

    const { grid, target, run, guessed, cellTarget, off, above, below, valid, known } = this
    grid.step(image, dx, dy)
    const { mean, slotOf, settled, whole, cols, rows, cells } = grid

    // Cells whose slot already holds a target for them.
    for (let l = 0; l < cells; l++) {
      const slot = slotOf[l]
      valid[l] = slot >= 0 ? 1 : 0
      known[l] = slot >= 0 && !first && settled[l] ? 1 : 0
      if (known[l]) {
        for (let ch = 0; ch < 3; ch++) cellTarget[l * 3 + ch] = target[slot * 3 + ch]
      }
    }
    // A cell that is new on screen starts from its own mean, corrected as the known cells
    // around it are: on its mean in a calm frame, and not on the flash in a flash frame.
    const { aroundMean, aroundTarget, knownNear, windowHalfCols, windowHalfRows } = this
    if (!first) {
      this.boxMean(mean, 3, known, windowHalfCols, windowHalfRows, aroundMean, knownNear)
      this.boxMean(cellTarget, 3, known, windowHalfCols, windowHalfRows, aroundTarget, null)
    }
    const span = GAME_HOLD_OFF_FULL - GAME_HOLD_OFF_START
    for (let l = 0; l < cells; l++) {
      const slot = slotOf[l]
      if (slot < 0) {
        off[l] = above[l] = below[l] = 0
        continue
      }
      const m = l * 3
      const t = slot * 3
      // Whether the known cells around this one are off their targets: a flash frame.
      const guided = !first && knownNear[l] > 0
      const flash =
        guided && Math.abs(deviation(aroundMean, m, aroundTarget, m)) > GAME_HOLD_TOLERANCE
      if (!known[l]) {
        for (let ch = 0; ch < 3; ch++) {
          target[t + ch] = guided
            ? correctChannel(mean[m + ch], aroundMean[m + ch], aroundTarget[m + ch])
            : mean[m + ch]
          cellTarget[m + ch] = target[t + ch]
        }
        run[slot] = 0
        // A first target worked out in a flash frame is only a guess at the cell's usual
        // look: one factor for the whole neighbourhood.
        guessed[slot] = flash ? 1 : 0
      } else if (guessed[slot] && whole[l] && guided && !flash) {
        // The first calm frame shows the cell as it usually looks.
        for (let ch = 0; ch < 3; ch++) cellTarget[m + ch] = target[t + ch] = mean[m + ch]
        run[slot] = 0
        guessed[slot] = 0
      }
      const d = deviation(mean, m, cellTarget, m)
      off[l] = d
      above[l] = clamp01((d - GAME_HOLD_OFF_START) / span)
      below[l] = clamp01((-d - GAME_HOLD_OFF_START) / span)
      if (known[l] && whole[l]) followTarget(target, t, mean, m, run, slot, dtMs)
    }

    // Shared or alone: the share of the surrounding window that is off the same way.
    const { shareAbove, shareBelow, strength, mover } = this
    this.boxMean(above, 1, valid, windowHalfCols, windowHalfRows, shareAbove, null)
    this.boxMean(below, 1, valid, windowHalfCols, windowHalfRows, shareBelow, null)
    for (let l = 0; l < cells; l++) {
      if (!valid[l]) {
        strength[l] = 0
        mover[l] = 0
        continue
      }
      const shared = smoothstep(
        GAME_HOLD_SHARED_START,
        GAME_HOLD_SHARED_FULL,
        off[l] >= 0 ? shareAbove[l] : shareBelow[l]
      )
      strength[l] = shared
      // Off its target while little around it is: a mover.
      mover[l] = Math.max(above[l], below[l]) * (1 - shared)
    }
    this.rememberMovers(dtMs, cols, rows)
    // What a mover is re-lit by: the cells near it that are not movers themselves. In a
    // calm frame those are on their targets, so the mover is left exactly as it is.
    const { calm } = this
    for (let l = 0; l < cells; l++) calm[l] = valid[l] && mover[l] < 0.5 ? 1 : 0
    const r = GAME_HOLD_MOVER_RADIUS
    this.boxMean(mean, 3, calm, r, r, aroundMean, null)
    this.boxMean(cellTarget, 3, calm, r, r, aroundTarget, null)
  }

  /**
   * The corrected picture for the frame last given to step().
   * @param image the same frame, linear R, G, B per pixel
   * @param out linear R, G, B per pixel; may be `image` itself
   */
  draw(image: ArrayLike<number>, out: Float32Array | Float64Array): void {
    const { width, height, grid, cellTarget, strength, mover, aroundMean, aroundTarget } = this
    const { mean, cols, columnCell, columnWeight, rowCell, rowWeight } = grid
    for (let y = 0, q = 0; y < height; y++) {
      const fy = rowWeight[y]
      const row = rowCell[y] * cols
      for (let x = 0; x < width; x++, q += 3) {
        const fx = columnWeight[x]
        const c00 = row + columnCell[x]
        const c10 = c00 + 1
        const c01 = c00 + cols
        const c11 = c01 + 1
        const w00 = (1 - fx) * (1 - fy)
        const w10 = fx * (1 - fy)
        const w01 = (1 - fx) * fy
        const w11 = fx * fy
        const s =
          w00 * strength[c00] + w10 * strength[c10] + w01 * strength[c01] + w11 * strength[c11]
        const mv = w00 * mover[c00] + w10 * mover[c10] + w01 * mover[c01] + w11 * mover[c11]
        // A mover is corrected at least as much as it is a mover, by its surroundings'
        // factor: nothing in a calm frame, the flash's correction in a flash frame.
        const w = mv > s ? mv : s
        if (w <= 0) {
          out[q] = image[q]
          out[q + 1] = image[q + 1]
          out[q + 2] = image[q + 2]
          continue
        }
        let meanY = 0
        let targetY = 0
        for (let ch = 0; ch < 3; ch++) {
          const a = c00 * 3 + ch
          const b = c10 * 3 + ch
          const c = c01 * 3 + ch
          const d = c11 * 3 + ch
          let m = w00 * mean[a] + w10 * mean[b] + w01 * mean[c] + w11 * mean[d]
          let t =
            w00 * cellTarget[a] + w10 * cellTarget[b] + w01 * cellTarget[c] + w11 * cellTarget[d]
          if (mv > 0) {
            const nearMean =
              w00 * aroundMean[a] + w10 * aroundMean[b] + w01 * aroundMean[c] + w11 * aroundMean[d]
            const nearTarget =
              w00 * aroundTarget[a] +
              w10 * aroundTarget[b] +
              w01 * aroundTarget[c] +
              w11 * aroundTarget[d]
            m += mv * (nearMean - m)
            t += mv * (nearTarget - t)
          }
          PIXEL_MEAN[ch] = m
          PIXEL_TARGET[ch] = t
          const weight = ch === 0 ? LUMA_R : ch === 1 ? LUMA_G : LUMA_B
          meanY += weight * m
          targetY += weight * t
        }
        if (meanY >= targetY) {
          // Too bright: one factor for all three channels, so the hue stays.
          const k = meanY > CORRECTION_EPSILON ? 1 + w * (targetY / meanY - 1) : 1
          out[q] = image[q] * k
          out[q + 1] = image[q + 1] * k
          out[q + 2] = image[q + 2] * k
        } else {
          for (let ch = 0; ch < 3; ch++) {
            const v = image[q + ch]
            out[q + ch] = v + w * (correctChannel(v, PIXEL_MEAN[ch], PIXEL_TARGET[ch]) - v)
          }
        }
      }
    }
  }

  /** Keep this frame's movers for a while on the screen lattice, and bring what is
   *  remembered back to this frame's cells. */
  private rememberMovers(dtMs: number, cols: number, rows: number): void {
    const { grid, mover, moverMemory, screenCols, screenRows, valid } = this
    const cell = grid.cell
    const keep = Math.exp(-dtMs / GAME_HOLD_MOVER_MEMORY_MS)
    for (let k = 0; k < moverMemory.length; k++) moverMemory[k] *= keep
    for (let j = 0; j < rows; j++) {
      const sy = Math.floor(grid.centreY(j) / cell)
      if (sy < 0 || sy >= screenRows) continue
      for (let i = 0; i < cols; i++) {
        const sx = Math.floor(grid.centreX(i) / cell)
        if (sx < 0 || sx >= screenCols) continue
        const l = j * cols + i
        if (!valid[l]) continue
        const z = sy * screenCols + sx
        if (mover[l] > moverMemory[z]) moverMemory[z] = mover[l]
        mover[l] = moverMemory[z]
      }
    }
  }

  /**
   * Mean of a per-cell array (k values per cell) over the cells of `mask` within rx, ry
   * cells, through a summed-area table. 0 where the box holds no such cell.
   * @param counts if given, receives how many cells of the mask each box held
   */
  private boxMean(
    source: ArrayLike<number>,
    k: number,
    mask: Uint8Array,
    rx: number,
    ry: number,
    out: Float32Array,
    counts: Float32Array | null
  ): void {
    const { table, tableCount } = this
    const { cols, rows } = this.grid
    const w = cols + 1
    for (let ch = 0; ch < k; ch++) {
      for (let j = 0; j < rows; j++) {
        let line = 0
        let lineCount = 0
        for (let i = 0; i < cols; i++) {
          const l = j * cols + i
          if (mask[l]) {
            line += source[l * k + ch]
            lineCount++
          }
          table[(j + 1) * w + i + 1] = table[j * w + i + 1] + line
          tableCount[(j + 1) * w + i + 1] = tableCount[j * w + i + 1] + lineCount
        }
      }
      for (let j = 0; j < rows; j++) {
        const y0 = Math.max(0, j - ry)
        const y1 = Math.min(rows, j + ry + 1)
        for (let i = 0; i < cols; i++) {
          const x0 = Math.max(0, i - rx)
          const x1 = Math.min(cols, i + rx + 1)
          const a = y1 * w + x1
          const b = y0 * w + x1
          const c = y1 * w + x0
          const d = y0 * w + x0
          const n = tableCount[a] - tableCount[b] - tableCount[c] + tableCount[d]
          const l = j * cols + i
          out[l * k + ch] = n > 0 ? (table[a] - table[b] - table[c] + table[d]) / n : 0
          if (counts && ch === 0) counts[l] = n
        }
      }
    }
  }
}

/** Scratch space for one pixel's interpolated mean and target. */
const PIXEL_MEAN = new Float64Array(3)
const PIXEL_TARGET = new Float64Array(3)

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function smoothstep(lo: number, hi: number, x: number): number {
  const t = clamp01((x - lo) / (hi - lo))
  return t * t * (3 - 2 * t)
}
