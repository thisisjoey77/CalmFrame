/**
 * What the viewer sees, checked by the detector: the live twin of "Check the filter against
 * the detector" (docs/SPEC.md, "Validation and measurement").
 *
 * The overlay's smoothed copy is a per-pixel filter in linear light, and area averaging is
 * linear. So running the same filter on the 96x54 grid, with the same alpha on the same
 * frames, gives the grid of the smoothed copy, up to the GPU's half-float rounding.
 * Blending that over the raw grid at the overlay's opacity gives the grid of what reaches
 * the viewer. While the overlay is drawn, a second detector checks that picture by the
 * same rule that flagged the original. A meter measures its residual swing over the cells
 * that flashed, which is the spec's slide number "residual swing after smoothing, against
 * the 0.10 threshold".
 *
 * Allocates in the constructor and once when the overlay appears (a fresh detector for
 * each episode), never per frame.
 */

import {
  COUNT_WINDOW_MS,
  FLASH_SIZE_PERCENTILE,
  GRID_CELLS,
  RESIDUAL_BLOCKS
} from '../shared/config'
import { Detector } from './detector'
import { relativeLuminance } from './luminance'
import { ReferenceFilter } from './referenceFilter'
import { percentile } from './select'

const CELLS = GRID_CELLS
const BLOCK_MS = COUNT_WINDOW_MS / RESIDUAL_BLOCKS
/** The current, partly filled block plus RESIDUAL_BLOCKS full ones, so the window always
 *  covers at least COUNT_WINDOW_MS once it is full. */
const SLOTS = RESIDUAL_BLOCKS + 1

/** What the overlay did with one frame. */
export interface ViewerFrame {
  /** The filter step Pass B applied to this frame. */
  alpha: number
  /** The dim factor, opacity and red desaturation Pass C drew with. */
  dim: number
  opacity: number
  red: boolean
}

export interface ViewerCheckResult {
  /** The overlay was drawn on this frame, so the fields below are live. */
  checking: boolean
  /** The detector's verdict on what the viewer saw since the overlay appeared. */
  hazard: boolean
  graphValue: number
  luminanceTransitions: number
  /** Peak-to-peak luminance of each cell over the last COUNT_WINDOW_MS, taken at the
   *  FLASH_SIZE_PERCENTILE over the cells that flashed this episode (the same statistic as
   *  the flash size dL, applied to what is left). Null until the overlay has been drawn
   *  for a whole window, or while no cell has flashed. */
  residual: number | null
}

export class ViewerCheck {
  private filter = new ReferenceFilter(CELLS)
  private checker: Detector | null = null
  private readonly rgb = new Float32Array(CELLS * 3)
  private readonly smoothed = new Float32Array(CELLS * 3)
  private readonly seen = new Float32Array(CELLS * 3)
  /** Per slot, then per cell: the lowest and highest luminance seen in that block. */
  private readonly blockMin = new Float32Array(SLOTS * CELLS)
  private readonly blockMax = new Float32Array(SLOTS * CELLS)
  /** Cells the detector found hot at any point since the overlay appeared. */
  private readonly flashed = new Uint8Array(CELLS)
  private readonly scratch = new Float64Array(CELLS)
  private slot = 0
  private slotStart = 0
  private fullBlocks = 0
  private readonly result: ViewerCheckResult = {
    checking: false,
    hazard: false,
    graphValue: 0,
    luminanceTransitions: 0,
    residual: null
  }

  /** @param channels values per cell in the input grid: 3 (RGB) or 4 (RGBA read-back) */
  constructor(private readonly channels: 3 | 4 = 3) {}

  /**
   * One frame. Call it on every analysed frame, drawn or not, so the twin filter sees the
   * same frames as Pass B.
   * @param grid linear RGB(A) per cell, the detector's input for this frame
   * @param hotMask the detector's hot cells for this frame
   */
  step(
    grid: ArrayLike<number>,
    tMs: number,
    frame: ViewerFrame,
    hotMask: Uint8Array
  ): ViewerCheckResult {
    const ch = this.channels
    const rgb = this.rgb
    for (let i = 0, j = 0, k = 0; i < CELLS; i++, j += 3, k += ch) {
      rgb[j] = grid[k]
      rgb[j + 1] = grid[k + 1]
      rgb[j + 2] = grid[k + 2]
    }
    this.filter.step(rgb, frame.alpha)

    const r = this.result
    if (frame.opacity <= 0) {
      this.checker = null
      r.checking = false
      r.hazard = false
      r.graphValue = 0
      r.luminanceTransitions = 0
      r.residual = null
      return r
    }
    if (this.checker === null) this.beginEpisode(tMs)
    const checker = this.checker as Detector

    this.filter.render(frame.dim, frame.red, this.smoothed)
    const o = frame.opacity
    const smoothed = this.smoothed
    const seen = this.seen
    for (let j = 0; j < seen.length; j++) seen[j] = o * smoothed[j] + (1 - o) * rgb[j]

    const d = checker.step(seen, tMs)
    r.checking = true
    r.hazard = d.hazard
    r.graphValue = d.graphValue
    r.luminanceTransitions = d.luminanceTransitions
    r.residual = this.meter(tMs, hotMask)
    return r
  }

  /** What the viewer saw on the latest frame, linear R, G, B per cell. Only meaningful
   *  while the latest result says checking (the overlay was drawn). The dashboard's
   *  protected preview (Phase 5). Overwritten by the next step. */
  get seenGrid(): Float32Array {
    return this.seen
  }

  /** Forget everything, e.g. when the capture restarts. */
  reset(): void {
    this.filter = new ReferenceFilter(CELLS)
    this.checker = null
  }

  private beginEpisode(tMs: number): void {
    this.checker = new Detector()
    this.flashed.fill(0)
    this.blockMin.fill(Infinity)
    this.blockMax.fill(-Infinity)
    this.slot = 0
    this.slotStart = tMs
    this.fullBlocks = 0
  }

  /** Record this frame's luminance per cell and return the residual swing, or null. */
  private meter(tMs: number, hotMask: Uint8Array): number | null {
    const steps = Math.floor((tMs - this.slotStart) / BLOCK_MS)
    if (steps > 0) {
      this.slotStart += steps * BLOCK_MS
      this.fullBlocks += steps
      for (let s = 0; s < Math.min(steps, SLOTS); s++) {
        this.slot = (this.slot + 1) % SLOTS
        const base = this.slot * CELLS
        this.blockMin.fill(Infinity, base, base + CELLS)
        this.blockMax.fill(-Infinity, base, base + CELLS)
      }
    }

    const seen = this.seen
    const lo = this.blockMin
    const hi = this.blockMax
    const flashed = this.flashed
    const base = this.slot * CELLS
    for (let i = 0, j = 0; i < CELLS; i++, j += 3) {
      const y = relativeLuminance(seen[j], seen[j + 1], seen[j + 2])
      if (y < lo[base + i]) lo[base + i] = y
      if (y > hi[base + i]) hi[base + i] = y
      if (hotMask[i]) flashed[i] = 1
    }

    if (this.fullBlocks < RESIDUAL_BLOCKS) return null
    let n = 0
    for (let i = 0; i < CELLS; i++) {
      if (!flashed[i]) continue
      let min = Infinity
      let max = -Infinity
      for (let s = 0; s < SLOTS; s++) {
        const k = s * CELLS + i
        if (lo[k] < min) min = lo[k]
        if (hi[k] > max) max = hi[k]
      }
      this.scratch[n++] = max - min
    }
    return n > 0 ? percentile(this.scratch, n, FLASH_SIZE_PERCENTILE) : null
  }
}
