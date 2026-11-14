/**
 * The concurrency rule. docs/SPEC.md, "Detection math", Step 5a.
 *
 * WCAG's area rule is about flashes "occurring concurrently". A strobe makes a whole
 * region brighter in one frame and darker in another. A scrolling page or a dragged window
 * makes cells reverse one after another, and in any one frame some get brighter while
 * their neighbours get darker. So a cell's reversal only counts as a transition when at
 * least AREA_LIMIT of some area window reverses the same way in the same captured frame,
 * and reversals the other way in that window are at most CONCURRENCY_MAX_OPPOSING of them.
 *
 * Three summed-area tables make this a few lookups per window position and per cell.
 * Everything is allocated in the constructor.
 */

import { AREA_LIMIT, CONCURRENCY_MAX_OPPOSING } from '../shared/config'
import type { AreaWindow } from './area'

export class ConcurrencyGate {
  private readonly cols: number
  private readonly rows: number
  /** The area window, clipped to the grid. */
  private readonly w: number
  private readonly h: number
  /** Window positions across and down. */
  private readonly px: number
  private readonly py: number
  /** Fewest same-way reversals a window needs. */
  private readonly needed: number
  /** Summed-area tables of rising and of falling cells, (cols + 1) x (rows + 1). */
  private readonly rising: Int32Array
  private readonly falling: Int32Array
  /** Summed-area table over window positions that qualify, (px + 1) x (py + 1). */
  private readonly qualifying: Int32Array

  constructor(cols: number, rows: number, window: AreaWindow) {
    this.cols = cols
    this.rows = rows
    this.w = Math.min(window.cols, cols)
    this.h = Math.min(window.rows, rows)
    this.px = cols - this.w + 1
    this.py = rows - this.h + 1
    this.needed = AREA_LIMIT * this.w * this.h
    this.rising = new Int32Array((cols + 1) * (rows + 1))
    this.falling = new Int32Array((cols + 1) * (rows + 1))
    this.qualifying = new Int32Array((this.px + 1) * (this.py + 1))
  }

  /**
   * Decide which of a frame's reversals count.
   * @param flip per cell: 1 rising, -1 falling, 0 none (TransitionTracker.flip)
   * @param counted set to 1 where the cell's reversal counts, 0 elsewhere
   * @returns how many count
   */
  apply(flip: ArrayLike<number>, counted: Uint8Array): number {
    const { cols, rows, rising, falling } = this
    const stride = cols + 1
    let ups = 0
    let downs = 0
    for (let y = 0; y < rows; y++) {
      let upRow = 0
      let downRow = 0
      const src = y * cols
      const above = y * stride
      const here = above + stride
      for (let x = 0; x < cols; x++) {
        const f = flip[src + x]
        if (f > 0) upRow++
        else if (f < 0) downRow++
        rising[here + x + 1] = rising[above + x + 1] + upRow
        falling[here + x + 1] = falling[above + x + 1] + downRow
      }
      ups += upRow
      downs += downRow
    }

    counted.fill(0)
    let n = 0
    if (ups >= this.needed) n += this.mark(flip, 1, rising, falling, counted)
    if (downs >= this.needed) n += this.mark(flip, -1, falling, rising, counted)
    return n
  }

  /** Marks the cells reversing in `direction` that lie in a qualifying window. */
  private mark(
    flip: ArrayLike<number>,
    direction: number,
    same: Int32Array,
    opposing: Int32Array,
    counted: Uint8Array
  ): number {
    const { cols, rows, w, h, px, py, needed, qualifying } = this
    const stride = cols + 1
    const qStride = px + 1
    const maxOpposing = CONCURRENCY_MAX_OPPOSING

    // Which window positions qualify, as a summed-area table over positions.
    let any = false
    for (let y = 0; y < py; y++) {
      let rowSum = 0
      const top = y * stride
      const bottom = (y + h) * stride
      const above = y * qStride
      const here = above + qStride
      for (let x = 0; x < px; x++) {
        const s = same[bottom + x + w] - same[bottom + x] - same[top + x + w] + same[top + x]
        if (s >= needed) {
          const o =
            opposing[bottom + x + w] -
            opposing[bottom + x] -
            opposing[top + x + w] +
            opposing[top + x]
          if (o <= maxOpposing * s) {
            rowSum++
            any = true
          }
        }
        qualifying[here + x + 1] = qualifying[above + x + 1] + rowSum
      }
    }
    if (!any) return 0

    // A cell counts if any window that contains it qualifies. Those windows have their
    // top-left corner in a rectangle of positions, so it is one more table lookup.
    let n = 0
    for (let y = 0; y < rows; y++) {
      const y0 = Math.max(0, y - h + 1)
      const y1 = Math.min(y, py - 1) + 1
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        if (flip[i] !== direction) continue
        const x0 = Math.max(0, x - w + 1)
        const x1 = Math.min(x, px - 1) + 1
        const q =
          qualifying[y1 * qStride + x1] -
          qualifying[y1 * qStride + x0] -
          qualifying[y0 * qStride + x1] +
          qualifying[y0 * qStride + x0]
        if (q > 0) {
          counted[i] = 1
          n++
        }
      }
    }
    return n
  }
}
