/**
 * The area rule. docs/SPEC.md, "Detection math", Step 6.
 *
 * Hot cells only matter if they fill a quarter of some 10° visual field. A summed-area
 * table makes each window position cost four lookups, so sliding the window over the
 * whole grid stays cheap enough to run every frame.
 */

import {
  AREA_LIMIT,
  AREA_WINDOW_COLS,
  AREA_WINDOW_ROWS,
  DEFAULT_VIEWING_DISTANCE_CM,
  VISUAL_FIELD_DEGREES,
  type AreaMode
} from '../shared/config'

export interface AreaWindow {
  cols: number
  rows: number
}

export interface Calibration {
  /** Visible width of the screen. */
  screenWidthCm: number
  /** Eye to screen. Defaults to DEFAULT_VIEWING_DISTANCE_CM. */
  viewingDistanceCm?: number
}

/** Width of a 10° visual field at distance D: 2 D tan(5°). 10.5 cm at 60 cm. Step 6. */
export function visualFieldWidthCm(viewingDistanceCm: number): number {
  const halfAngle = ((VISUAL_FIELD_DEGREES / 2) * Math.PI) / 180
  return 2 * viewingDistanceCm * Math.tan(halfAngle)
}

/**
 * Window size in cells for an area mode. Step 6.
 * - wcag: one third of the grid each way (32x18), WCAG's 341x256 on 1024x768.
 * - calibrated: the share of the screen width a 10° field covers, applied to both
 *   directions, the way the WCAG window is one third in both.
 * - iris: the whole grid (hot cells >= 25% of all cells). For validation only.
 */
export function areaWindow(
  mode: AreaMode,
  gridCols: number,
  gridRows: number,
  calibration?: Calibration
): AreaWindow {
  if (mode === 'iris') return { cols: gridCols, rows: gridRows }
  if (mode === 'wcag') return { cols: AREA_WINDOW_COLS, rows: AREA_WINDOW_ROWS }
  if (!calibration || !(calibration.screenWidthCm > 0)) {
    throw new Error('Calibrated area mode needs the screen width in cm')
  }
  const distance = calibration.viewingDistanceCm ?? DEFAULT_VIEWING_DISTANCE_CM
  const share = Math.min(1, visualFieldWidthCm(distance) / calibration.screenWidthCm)
  return {
    cols: Math.max(1, Math.min(gridCols, Math.round(gridCols * share))),
    rows: Math.max(1, Math.min(gridRows, Math.round(gridRows * share)))
  }
}

/** Summed-area table over a cols x rows grid of 0/1 cells. Allocates once. */
export class SummedAreaTable {
  readonly cols: number
  readonly rows: number
  /** (cols + 1) x (rows + 1), with a zero first row and column. */
  private readonly sums: Int32Array

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.sums = new Int32Array((cols + 1) * (rows + 1))
  }

  /** Build from a mask: a cell counts when its value is non-zero. */
  buildFromMask(mask: ArrayLike<number>): void {
    this.build(mask, 1)
  }

  /** Build from per-cell values: a cell counts when its value is at least k. */
  build(values: ArrayLike<number>, k: number): void {
    const { cols, rows, sums } = this
    const stride = cols + 1
    for (let y = 0; y < rows; y++) {
      let rowSum = 0
      const src = y * cols
      const above = y * stride
      const here = above + stride
      for (let x = 0; x < cols; x++) {
        if (values[src + x] >= k) rowSum++
        sums[here + x + 1] = sums[above + x + 1] + rowSum
      }
    }
  }

  /** Number of counted cells in the w x h window with its top-left at (x, y). */
  sum(x: number, y: number, w: number, h: number): number {
    const stride = this.cols + 1
    const s = this.sums
    const top = y * stride
    const bottom = (y + h) * stride
    return s[bottom + x + w] - s[bottom + x] - s[top + x + w] + s[top + x]
  }

  /** Largest share of counted cells over every position of a w x h window. Step 6, A. */
  maxWindowFraction(w: number, h: number): number {
    const cw = Math.min(w, this.cols)
    const ch = Math.min(h, this.rows)
    let best = 0
    for (let y = 0; y + ch <= this.rows; y++) {
      for (let x = 0; x + cw <= this.cols; x++) {
        const n = this.sum(x, y, cw, ch)
        if (n > best) best = n
      }
    }
    return best / (cw * ch)
  }
}

/**
 * The largest k such that cells with count >= k fill AREA_LIMIT of some window. Step 8's
 * graph value is this divided by 2. Filling is monotone in k, so a binary search over
 * 0..maxCount needs about log2(maxCount) table builds.
 */
export function largestAreaCount(
  counts: ArrayLike<number>,
  maxCount: number,
  window: AreaWindow,
  table: SummedAreaTable
): number {
  let lo = 0
  let hi = maxCount
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    table.build(counts, mid)
    if (table.maxWindowFraction(window.cols, window.rows) >= AREA_LIMIT) lo = mid
    else hi = mid - 1
  }
  return lo
}
