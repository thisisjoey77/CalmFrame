/**
 * The flash detector. docs/SPEC.md, "Detection math", Steps 1 to 8.
 *
 * A pure function of (grid of linear RGB per cell, capture timestamp), with state. The
 * overlay renderer (Phase 3) and the validator CLI (Phase 6) run the same code.
 *
 * Everything is allocated in the constructor. step() allocates nothing and returns the
 * same result object every frame, so read it before the next call.
 */

import {
  AREA_LIMIT,
  DEFAULT_AREA_MODE,
  DEFAULT_TRIGGER_MODE,
  EARLY_TRIGGER_STREAK,
  EXTENDED_FAIL_MAX_TRANSITIONS,
  EXTENDED_FAIL_MIN_TRANSITIONS,
  EXTENDED_FAIL_MS,
  EXTENDED_FAIL_RING_CAPACITY,
  EXTENDED_FAIL_WINDOW_MS,
  FLASH_SIZE_PERCENTILE,
  FRAME_GAP_RESET_MS,
  GRID_CELLS,
  GRID_COLS,
  GRID_ROWS,
  LUMINANCE_THRESHOLD,
  PREARM_ENABLED,
  PREARM_TRIGGER_STREAK,
  RED_THRESHOLD,
  STRICT_TRIGGER_COUNT,
  type AreaMode,
  type TriggerMode
} from '../shared/config'
import {
  SummedAreaTable,
  areaWindow,
  largestAreaCount,
  type AreaWindow,
  type Calibration
} from './area'
import { redRatio, redValue, relativeLuminance } from './luminance'
import { percentile } from './select'
import { TransitionTracker } from './tracker'

/** Hot loops read this module-local copy rather than the import, which some module
 *  loaders (Vitest's among them) turn into a property lookup on every iteration. */
const CELLS = GRID_CELLS

export type HazardType = 'none' | 'luminance' | 'red'

export interface DetectorOptions {
  /** 'early' (streak >= N, the default) or 'strict' (1 s count >= 7). Step 7. */
  trigger?: TriggerMode
  /** N for the early trigger; the sensitivity slider's 2, 3 or 4. Step 7. */
  streakN?: number
  /** Window for the area rule. Step 6. */
  areaMode?: AreaMode
  /** Required for the calibrated area mode. */
  calibration?: Calibration
  /** IRIS extended-failure rule. For the validator's like-for-like comparison only. */
  extendedFailure?: boolean
  /** Pre-arm (Step 7a): also report whether cells with a transition in the last
   *  fast-transition interval already fill the area limit, one or two reversals before the
   *  trigger could fire. Off by default; it does not change the hazard. */
  prearm?: boolean
  /** Values per cell in the input: 3 (RGB, the default) or 4 (RGBA, as read back from
   *  the GPU). Alpha is ignored. */
  inputChannels?: 3 | 4
}

/** Step 8: what the detector hands to the filter and the dashboard. */
export interface DetectorResult {
  hazard: boolean
  /** 'red' whenever a red hazard is present, since red needs the extra desaturation. */
  type: HazardType
  luminanceHazard: boolean
  redHazard: boolean
  /** IRIS extended failure. Always false unless the option is on. */
  extendedFailure: boolean
  /** f: 1 / (2 x median interval between transitions) over hot cells, in Hz. 0 if none. */
  frequencyHz: number
  /** dL: 90th percentile of luminance swing over hot cells. 0 if none. */
  flashSize: number
  /** A: the largest hot fraction of any window, luminance or red. */
  areaFraction: number
  /** Largest k such that cells with count >= k fill 25% of some window, divided by 2:
   *  flashes per second over a hazardous area, plotted against the limit at 3. */
  graphValue: number
  /** Pre-arm (Step 7a): armed cells (luminance streak >= 1) fill at least the area limit of
   *  some window. Always false unless the option is on. A hazard implies it. */
  arm: boolean
  /** The largest armed fraction of any window. 0 unless the option is on. */
  armAreaFraction: number
  /** 1 where a cell is hot for luminance or red. For regional smoothing later. */
  hotMask: Uint8Array
  hotCells: number
  /** Cells that recorded a transition on this frame. */
  luminanceTransitions: number
  redTransitions: number
}

export class Detector {
  /** The area-rule window in cells. */
  readonly window: AreaWindow
  private readonly trigger: TriggerMode
  private readonly streakN: number
  private readonly extendedEnabled: boolean
  private readonly prearmEnabled: boolean
  private readonly channels: number

  private readonly lum = new TransitionTracker({
    cells: GRID_CELLS,
    threshold: LUMINANCE_THRESHOLD,
    kind: 'luminance'
  })
  private readonly red = new TransitionTracker({
    cells: GRID_CELLS,
    threshold: RED_THRESHOLD,
    kind: 'red'
  })

  private readonly lumY = new Float64Array(GRID_CELLS)
  private readonly redV = new Float64Array(GRID_CELLS)
  private readonly redRho = new Float64Array(GRID_CELLS)
  private readonly lumHot = new Uint8Array(GRID_CELLS)
  private readonly redHot = new Uint8Array(GRID_CELLS)
  private readonly armHot = new Uint8Array(GRID_CELLS)
  private readonly table = new SummedAreaTable(GRID_COLS, GRID_ROWS)
  private readonly scratch = new Float64Array(GRID_CELLS)
  private readonly lumExtended = new FlaggedDuration()
  private readonly redExtended = new FlaggedDuration()
  private readonly result: DetectorResult

  private started = false
  private prevT = 0

  constructor(options: DetectorOptions = {}) {
    this.trigger = options.trigger ?? DEFAULT_TRIGGER_MODE
    this.streakN = options.streakN ?? EARLY_TRIGGER_STREAK
    this.extendedEnabled = options.extendedFailure ?? false
    this.prearmEnabled = options.prearm ?? PREARM_ENABLED
    this.channels = options.inputChannels ?? 3
    this.window = areaWindow(
      options.areaMode ?? DEFAULT_AREA_MODE,
      GRID_COLS,
      GRID_ROWS,
      options.calibration
    )
    this.result = {
      hazard: false,
      type: 'none',
      luminanceHazard: false,
      redHazard: false,
      extendedFailure: false,
      frequencyHz: 0,
      flashSize: 0,
      areaFraction: 0,
      graphValue: 0,
      arm: false,
      armAreaFraction: 0,
      hotMask: new Uint8Array(GRID_CELLS),
      hotCells: 0,
      luminanceTransitions: 0,
      redTransitions: 0
    }
  }

  /** Forget all history, as if the detector had just been created. */
  reset(): void {
    this.lum.reset()
    this.red.reset()
    this.lumExtended.reset()
    this.redExtended.reset()
    this.started = false
  }

  /**
   * Process one frame.
   * @param rgb linear R, G, B (and A if inputChannels is 4) per cell, row-major 96x54
   * @param tMs capture timestamp in ms. A frame that is not newer than the last is ignored
   *            and the previous result is returned.
   */
  step(rgb: ArrayLike<number>, tMs: number): DetectorResult {
    const out = this.result
    if (rgb.length < GRID_CELLS * this.channels) {
      throw new Error(`Expected ${GRID_CELLS * this.channels} values, got ${rgb.length}`)
    }
    if (this.started && !(tMs > this.prevT)) return out
    const dt = this.started ? Math.min(tMs - this.prevT, FRAME_GAP_RESET_MS) : 0
    this.started = true
    this.prevT = tMs

    // Steps 1 and 3: luminance, red value and red ratio per cell.
    const ch = this.channels
    const { lumY, redV, redRho } = this
    const luminanceOf = relativeLuminance
    const redValueOf = redValue
    const redRatioOf = redRatio
    for (let i = 0, j = 0; i < CELLS; i++, j += ch) {
      const r = rgb[j]
      const g = rgb[j + 1]
      const b = rgb[j + 2]
      lumY[i] = luminanceOf(r, g, b)
      redV[i] = redValueOf(r, g, b)
      redRho[i] = redRatioOf(r, g, b)
    }

    // Steps 4 and 5.
    this.lum.update(this.lumY, null, tMs)
    this.red.update(this.redV, this.redRho, tMs)

    // Steps 6 and 7: hot cells, then the area rule.
    const lumHotCells = this.markHot(this.lum, this.lumHot)
    const redHotCells = this.markHot(this.red, this.redHot)
    const lumArea = lumHotCells > 0 ? this.windowFraction(this.lumHot) : 0
    const redArea = redHotCells > 0 ? this.windowFraction(this.redHot) : 0
    const luminanceHazard = lumArea >= AREA_LIMIT
    const redHazard = redArea >= AREA_LIMIT

    // Step 7a: the same area rule over cells that have reversed at all, not three times.
    const armArea = this.prearmEnabled ? this.windowFraction(this.markArmed()) : 0

    // Step 8 graph value. Reuses the summed-area table, so it runs after the area rule.
    const lumK = this.graphCount(this.lum)
    const redK = this.graphCount(this.red)

    let lumExtended = false
    let redExtended = false
    if (this.extendedEnabled) {
      lumExtended = this.lumExtended.push(tMs, dt, inExtendedBand(lumK))
      redExtended = this.redExtended.push(tMs, dt, inExtendedBand(redK))
    }
    const extended = lumExtended || redExtended

    out.luminanceHazard = luminanceHazard
    out.redHazard = redHazard
    out.extendedFailure = extended
    out.hazard = luminanceHazard || redHazard || extended
    out.type =
      redHazard || redExtended ? 'red' : luminanceHazard || lumExtended ? 'luminance' : 'none'
    out.areaFraction = Math.max(lumArea, redArea)
    out.arm = armArea >= AREA_LIMIT
    out.armAreaFraction = armArea
    out.graphValue = Math.max(lumK, redK) / 2
    out.luminanceTransitions = this.lum.transitionsThisFrame
    out.redTransitions = this.red.transitionsThisFrame

    let hotCells = 0
    const mask = out.hotMask
    for (let i = 0; i < CELLS; i++) {
      const hot = this.lumHot[i] | this.redHot[i]
      mask[i] = hot
      hotCells += hot
    }
    out.hotCells = hotCells

    // Step 8 f and dL, over the hot cells of whichever rule raised the hazard. Below a
    // hazard they describe the hottest activity there is, for the dashboard.
    const useRed = !luminanceHazard && (redHazard || lumHotCells === 0)
    this.measureFlash(useRed ? this.red : this.lum, useRed ? this.redHot : this.lumHot)

    return out
  }

  /** Marks cells that meet the trigger (Step 7) and returns how many do. */
  private markHot(tracker: TransitionTracker, hot: Uint8Array): number {
    let n = 0
    if (this.trigger === 'strict') {
      const count = tracker.count
      for (let i = 0; i < CELLS; i++) {
        const h = count[i] >= STRICT_TRIGGER_COUNT ? 1 : 0
        hot[i] = h
        n += h
      }
    } else {
      const streak = tracker.streak
      const needed = this.streakN
      for (let i = 0; i < CELLS; i++) {
        const h = streak[i] >= needed ? 1 : 0
        hot[i] = h
        n += h
      }
    }
    return n
  }

  /**
   * Step 7a: cells whose luminance streak has reached PREARM_TRIGGER_STREAK, which at 1 is
   * every cell that recorded a transition within the fast-transition interval. Independent
   * of the trigger mode, since pre-arm is defined on the streak either way.
   */
  private markArmed(): Uint8Array {
    const armed = this.armHot
    const streak = this.lum.streak
    const needed = PREARM_TRIGGER_STREAK
    for (let i = 0; i < CELLS; i++) armed[i] = streak[i] >= needed ? 1 : 0
    return armed
  }

  private windowFraction(hot: Uint8Array): number {
    this.table.buildFromMask(hot)
    return this.table.maxWindowFraction(this.window.cols, this.window.rows)
  }

  private graphCount(tracker: TransitionTracker): number {
    const count = tracker.count
    let max = 0
    for (let i = 0; i < CELLS; i++) if (count[i] > max) max = count[i]
    return max === 0 ? 0 : largestAreaCount(count, max, this.window, this.table)
  }

  /**
   * f from the median of the latest interval of each hot cell; dL as the 90th percentile of
   * luminance swing over the same cells, counting a cell with no luminance transition in
   * the last second as 0 (a red flash between equal luminances has no luminance swing).
   */
  private measureFlash(source: TransitionTracker, hot: Uint8Array): void {
    const out = this.result
    const s = this.scratch
    let n = 0
    const interval = source.interval
    for (let i = 0; i < CELLS; i++) {
      if (hot[i] && Number.isFinite(interval[i])) s[n++] = interval[i]
    }
    const medianInterval = percentile(s, n, 0.5)
    out.frequencyHz = n > 0 && medianInterval > 0 ? 1000 / (2 * medianInterval) : 0

    n = 0
    const swing = this.lum.swing
    const lumCount = this.lum.count
    for (let i = 0; i < CELLS; i++) {
      if (hot[i]) s[n++] = lumCount[i] > 0 ? swing[i] : 0
    }
    out.flashSize = percentile(s, n, FLASH_SIZE_PERCENTILE)
  }
}

/** IRIS counts a frame toward extended failure when its count is in the warning band. */
function inExtendedBand(k: number): boolean {
  return k >= EXTENDED_FAIL_MIN_TRANSITIONS && k <= EXTENDED_FAIL_MAX_TRANSITIONS
}

/**
 * Total duration of flagged frames within the last EXTENDED_FAIL_WINDOW_MS, from capture
 * timestamps. Each frame contributes the time since the frame before it.
 */
class FlaggedDuration {
  private readonly times = new Float64Array(EXTENDED_FAIL_RING_CAPACITY)
  private readonly durations = new Float64Array(EXTENDED_FAIL_RING_CAPACITY)
  private head = 0
  private length = 0
  private total = 0

  reset(): void {
    this.head = 0
    this.length = 0
    this.total = 0
  }

  /** Adds a frame; returns whether flagged time in the window reaches EXTENDED_FAIL_MS. */
  push(t: number, duration: number, flagged: boolean): boolean {
    const cap = EXTENDED_FAIL_RING_CAPACITY
    if (flagged) {
      if (this.length === cap) this.dropOldest()
      const slot = (this.head + this.length) % cap
      this.times[slot] = t
      this.durations[slot] = duration
      this.length++
      this.total += duration
    }
    while (this.length > 0 && t - this.times[this.head] >= EXTENDED_FAIL_WINDOW_MS) {
      this.dropOldest()
    }
    return this.total >= EXTENDED_FAIL_MS
  }

  private dropOldest(): void {
    this.total -= this.durations[this.head]
    this.head = (this.head + 1) % EXTENDED_FAIL_RING_CAPACITY
    this.length--
    if (this.length === 0) this.total = 0
  }
}
