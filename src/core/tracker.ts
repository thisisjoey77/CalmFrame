/**
 * Per-cell transition tracker. docs/SPEC.md, "Detection math", Steps 4 and 5.
 *
 * Each cell follows a running extremum and records a transition when its value has
 * reversed by the threshold from that extremum, however many frames the reversal took.
 * The same class runs on luminance Y (threshold 0.10, dark limit 0.80) and on the red
 * value v (threshold 20, saturated-red ratio 0.8).
 *
 * A frame is fed in two halves so the concurrency rule (Step 5a) can sit between them:
 * observe() runs Step 4 and reports which cells reversed, commit() does the Step 5
 * bookkeeping for the reversals that count. update() is both, counting every reversal.
 *
 * All state lives in typed arrays allocated once. Feeding a frame allocates nothing.
 * Times are capture timestamps in milliseconds, never frame counts.
 */

import {
  COUNT_WINDOW_MS,
  DARK_LIMIT,
  FAST_TRANSITION_INTERVAL_MS,
  FRAME_GAP_RESET_MS,
  RED_RATIO,
  TRACKER_IDLE_RESET_MS,
  TRACKER_RING_CAPACITY
} from '../shared/config'

/** Direction of a cell. Step 4. */
export const IDLE = 0
export const RISING = 1
export const FALLING = -1

export interface TrackerOptions {
  cells: number
  /** Minimum reversal that counts: 0.10 for luminance, 20 for red. */
  threshold: number
  /**
   * 'luminance': a reversal counts if it is at least the threshold and the darker of its
   * two states is below the dark limit (WCAG: "10% or more", "darker image below 0.80").
   * 'red': it counts if it is more than the threshold and at least one of its two states
   * has R / (R + G + B) at or above the red ratio (WCAG: "> 20", "R/(R+G+B) >= 0.8").
   */
  kind: 'luminance' | 'red'
  /** Max gap between transitions for them to extend a streak. Default
   *  FAST_TRANSITION_INTERVAL_MS, the standard's three flashes a second (Step 5). */
  fastIntervalMs?: number
}

export class TransitionTracker {
  readonly cells: number
  private readonly threshold: number
  private readonly isRed: boolean
  private readonly fastMs: number
  private readonly darkLimit = DARK_LIMIT
  private readonly redRatioLimit = RED_RATIO

  // Step 4: the extremum tracker.
  /** IDLE, RISING or FALLING. */
  readonly dir: Int8Array
  /** Running extremum e while rising or falling. */
  private readonly ext: Float64Array
  /** Running low and high while idle. */
  private readonly low: Float64Array
  private readonly high: Float64Array
  /** Red only: the red ratio of the state each of ext, low and high came from. */
  private readonly extRatio: Float64Array
  private readonly lowRatio: Float64Array
  private readonly highRatio: Float64Array
  /** The extremum the latest reversal started from. */
  private readonly anchor: Float64Array
  /** The reversal each cell made on the latest frame: RISING, FALLING or 0 for none.
   *  Filled by observe(), before the concurrency rule decides which of them count. */
  readonly flip: Int8Array
  /** Time of the latest reversal, counted or not. Rule 6 uses it, so a cell that keeps
   *  reversing stays out of idle whether or not its reversals count. */
  private readonly lastFlipT: Float64Array

  // Step 5: per-cell bookkeeping, over the transitions that count.
  /** Time of the latest transition, -Infinity before the first. */
  readonly lastT: Float64Array
  /** Time between the latest two transitions, Infinity until there are two. */
  readonly interval: Float64Array
  /**
   * Size of the latest reversal: distance from the extremum it started at to the furthest
   * point reached since. It keeps growing while the reversal continues, so a flash that
   * ramps over several frames reports its full size, not just the threshold crossing.
   */
  readonly swing: Float64Array
  /** Consecutive transitions each within the fast interval of the one before. */
  readonly streak: Uint32Array
  /** Transitions in the last COUNT_WINDOW_MS, the window open at its old end. */
  readonly count: Uint16Array
  /** Ring of recent transition times per cell, TRACKER_RING_CAPACITY slots each. */
  private readonly ring: Float64Array
  private readonly ringHead: Uint16Array

  private started = false
  private prevT = 0
  private gapReset = false
  /** Cells that reversed on the latest frame, counted or not. */
  flipsThisFrame = 0
  /** Cells whose reversal on the latest frame was counted as a transition. */
  transitionsThisFrame = 0

  constructor(options: TrackerOptions) {
    const n = options.cells
    this.cells = n
    this.threshold = options.threshold
    this.isRed = options.kind === 'red'
    this.fastMs = options.fastIntervalMs ?? FAST_TRANSITION_INTERVAL_MS
    this.dir = new Int8Array(n)
    this.ext = new Float64Array(n)
    this.low = new Float64Array(n)
    this.high = new Float64Array(n)
    this.extRatio = new Float64Array(n)
    this.lowRatio = new Float64Array(n)
    this.highRatio = new Float64Array(n)
    this.anchor = new Float64Array(n)
    this.flip = new Int8Array(n)
    this.lastFlipT = new Float64Array(n)
    this.lastT = new Float64Array(n)
    this.interval = new Float64Array(n)
    this.swing = new Float64Array(n)
    this.streak = new Uint32Array(n)
    this.count = new Uint16Array(n)
    this.ring = new Float64Array(n * TRACKER_RING_CAPACITY)
    this.ringHead = new Uint16Array(n)
    this.reset()
  }

  /** Forget everything. The next update starts every cell idle at its current value. */
  reset(): void {
    this.dir.fill(IDLE)
    this.flip.fill(0)
    this.lastFlipT.fill(-Infinity)
    this.lastT.fill(-Infinity)
    this.interval.fill(Infinity)
    this.swing.fill(0)
    this.streak.fill(0)
    this.count.fill(0)
    this.ringHead.fill(0)
    this.started = false
    this.gapReset = false
    this.flipsThisFrame = 0
    this.transitionsThisFrame = 0
  }

  /**
   * Feed one frame, counting every reversal as a transition.
   * @param values per-cell Y (luminance) or v (red)
   * @param ratios per-cell red ratio; required for a red tracker, ignored otherwise
   * @param t capture timestamp in ms, strictly increasing
   */
  update(values: ArrayLike<number>, ratios: ArrayLike<number> | null, t: number): void {
    this.observe(values, ratios, t)
    this.commit(t, null)
  }

  /**
   * First half of a frame, Step 4: follow each cell's extremum and note its reversal, if
   * any, in `flip`. Follow it with commit() for the same frame.
   * @returns how many cells reversed
   */
  observe(values: ArrayLike<number>, ratios: ArrayLike<number> | null, t: number): number {
    const n = this.cells
    const red = this.isRed
    if (red && ratios === null) throw new Error('A red tracker needs red ratios')

    if (!this.started) {
      // Step 4, rule 1: start idle, running low and high both at the first value.
      for (let i = 0; i < n; i++) {
        const y = values[i]
        const rho = red ? (ratios as ArrayLike<number>)[i] : 0
        this.low[i] = this.high[i] = this.ext[i] = this.anchor[i] = y
        this.lowRatio[i] = this.highRatio[i] = this.extRatio[i] = rho
      }
      this.flip.fill(0)
      this.started = true
      this.prevT = t
      this.gapReset = false
      this.flipsThisFrame = 0
      return 0
    }

    // "Known behaviour at the edges": a frame gap over 250 ms resets all streaks. The
    // 167 ms streak rule below already implies it; it stays explicit because the spec
    // lists it as its own guarantee.
    this.gapReset = t - this.prevT > FRAME_GAP_RESET_MS
    this.prevT = t

    const { dir, ext, low, high, extRatio, lowRatio, highRatio, anchor } = this
    const { flip, lastFlipT, swing } = this
    // Constants copied to locals: this loop runs once per cell per frame, and some module
    // loaders (Vitest's among them) turn every read of an import into a property lookup.
    const idleMs = TRACKER_IDLE_RESET_MS
    let flips = 0

    for (let i = 0; i < n; i++) {
      const y = values[i]
      const rho = red ? (ratios as ArrayLike<number>)[i] : 0

      const d = dir[i]
      let size = -1 // size of the reversal recorded this frame, or -1 for none

      if (d === IDLE) {
        // Rule 2: keep the running low and high up to date, then look for a reversal.
        if (y < low[i]) {
          low[i] = y
          lowRatio[i] = rho
        }
        if (y > high[i]) {
          high[i] = y
          highRatio[i] = rho
        }
        const rise = y - low[i]
        const fall = high[i] - y
        if (this.exceeds(rise) && this.qualifies(low[i], lowRatio[i], y, rho)) {
          size = rise
          dir[i] = RISING
          anchor[i] = low[i]
        } else if (this.exceeds(fall) && this.qualifies(y, rho, high[i], highRatio[i])) {
          size = fall
          dir[i] = FALLING
          anchor[i] = high[i]
        }
      } else if (d === RISING) {
        // Rule 3: follow the peak; a drop of the threshold from it is a falling transition.
        if (y > ext[i]) {
          ext[i] = y
          extRatio[i] = rho
        } else {
          const fall = ext[i] - y
          if (this.exceeds(fall) && this.qualifies(y, rho, ext[i], extRatio[i])) {
            size = fall
            dir[i] = FALLING
            anchor[i] = ext[i]
          }
        }
      } else {
        // Rule 4: the mirror image.
        if (y < ext[i]) {
          ext[i] = y
          extRatio[i] = rho
        } else {
          const rise = y - ext[i]
          if (this.exceeds(rise) && this.qualifies(ext[i], extRatio[i], y, rho)) {
            size = rise
            dir[i] = RISING
            anchor[i] = ext[i]
          }
        }
      }

      if (size >= 0) {
        // A reversal: e = Y in the new direction.
        ext[i] = y
        extRatio[i] = rho
        flip[i] = dir[i]
        lastFlipT[i] = t
        flips++
      } else {
        flip[i] = 0
        if (d !== IDLE && t - lastFlipT[i] >= idleMs) {
          // Rule 6: no reversal for 1 s returns the cell to idle at the current value.
          dir[i] = IDLE
          low[i] = high[i] = y
          lowRatio[i] = highRatio[i] = rho
        }
      }

      if (dir[i] !== IDLE) swing[i] = Math.abs(ext[i] - anchor[i])
    }

    this.flipsThisFrame = flips
    return flips
  }

  /**
   * Second half of a frame, Step 5: the bookkeeping for the reversals observe() found.
   * @param counted per cell, non-zero where this frame's reversal counts as a transition
   *                (Step 5a), or null to count them all
   */
  commit(t: number, counted: ArrayLike<number> | null): void {
    const n = this.cells
    const gapReset = this.gapReset
    const { flip, lastT, interval, streak, count, ring, ringHead } = this
    const cap = TRACKER_RING_CAPACITY
    const fastMs = this.fastMs
    const windowMs = COUNT_WINDOW_MS
    let transitions = 0

    for (let i = 0; i < n; i++) {
      if (gapReset) streak[i] = 0

      if (flip[i] !== 0 && (counted === null || counted[i])) {
        const gap = t - lastT[i]
        streak[i] = gap <= fastMs ? streak[i] + 1 : 1
        interval[i] = gap
        lastT[i] = t
        const base = i * cap
        let c = count[i]
        if (c === cap) {
          ringHead[i] = (ringHead[i] + 1) % cap
          c--
        }
        ring[base + ((ringHead[i] + c) % cap)] = t
        count[i] = c + 1
        transitions++
      }

      // Count c: drop transitions that have left the 1 s window.
      let c = count[i]
      if (c > 0) {
        const base = i * cap
        let head = ringHead[i]
        while (c > 0 && t - ring[base + head] >= windowMs) {
          head = (head + 1) % cap
          c--
        }
        ringHead[i] = head
        count[i] = c
      }

      // Streak s: reset when the fast interval passes with no transition.
      if (streak[i] > 0 && t - lastT[i] > fastMs) streak[i] = 0
    }

    this.transitionsThisFrame = transitions
  }

  /** Whether a reversal is big enough: at least 0.10 for luminance, more than 20 for red. */
  private exceeds(delta: number): boolean {
    return this.isRed ? delta > this.threshold : delta >= this.threshold
  }

  /**
   * Whether a reversal between a darker state (value a) and a brighter one (value b) is a
   * flash at all. A reversal that fails is ignored outright: the cell keeps its direction
   * and extremum, so a flash that ramps from 0.98 down to 0.5 still counts once it passes
   * below 0.80, instead of being spent at the first frame below 0.88.
   */
  private qualifies(a: number, aRatio: number, b: number, bRatio: number): boolean {
    if (this.isRed) return aRatio >= this.redRatioLimit || bRatio >= this.redRatioLimit
    return Math.min(a, b) < this.darkLimit
  }
}
