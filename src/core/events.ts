/**
 * Flash events: what the dashboard's event log and "events smoothed" counter show
 * (docs/SPEC.md, Phase 5, "0:42, 8 Hz, 2.1 s, smoothed").
 *
 * The detector's hazard flag can drop out for a few frames in the middle of real flashing
 * (Phase 4: a clip that kept stopping and starting held the overlay on for 11.7 s). The
 * user sees one smoothing episode there, not twenty hazards. So hazards closer together
 * than FLASH_EVENT_MERGE_MS, the hold plus the fade, are one event: with protection on,
 * one event is exactly one stretch of the overlay being up.
 *
 * Pure and driven by capture timestamps. step() allocates nothing and returns the same
 * object each time it reports, so read it before the next call.
 */

import { FLASH_EVENT_FREQUENCY_SAMPLES, FLASH_EVENT_MERGE_MS } from '../shared/config'
import type { HazardType } from './detector'
import { percentile } from './select'

export interface FlashEvent {
  kind: 'start' | 'end'
  /** 1 for the first event, then counting up. */
  id: number
  /** Capture timestamp of the event's first hazard frame. */
  startT: number
  /** Capture timestamp of its latest hazard frame. */
  lastT: number
  /** How long it flashed, from the first hazard frame to the last. Null at the start. */
  durationMs: number | null
  /** 'red' if it was a red hazard at any point. */
  type: HazardType
  /** The median of the per-frame frequency estimates so far, in Hz. At the start, the
   *  start frame's estimate. 0 if none was usable. */
  frequencyHz: number
  /** The overlay was drawn on at least one of its hazard frames. */
  smoothed: boolean
}

export class FlashEventTracker {
  private open = false
  private nextId = 1
  private readonly freqs: Float64Array
  private readonly scratch: Float64Array
  private freqNext = 0
  private freqCount = 0
  private readonly out: FlashEvent = {
    kind: 'start',
    id: 0,
    startT: 0,
    lastT: 0,
    durationMs: null,
    type: 'none',
    frequencyHz: 0,
    smoothed: false
  }

  /**
   * @param mergeMs hazards closer together than this are one event
   * @param frequencySamples per-frame estimates kept for the median (the most recent ones)
   */
  constructor(
    private readonly mergeMs = FLASH_EVENT_MERGE_MS,
    frequencySamples = FLASH_EVENT_FREQUENCY_SAMPLES
  ) {
    this.freqs = new Float64Array(frequencySamples)
    this.scratch = new Float64Array(frequencySamples)
  }

  /** An event is open: it started and has not been reported as ended yet. */
  get active(): boolean {
    return this.open
  }

  /**
   * One analysed frame.
   * @param hazard the detector's hazard flag on this frame
   * @param type the detector's hazard type on this frame
   * @param frequencyHz the detector's frequency estimate on this frame
   * @param smoothed the overlay is drawn on this frame (protection on, opacity above 0)
   * @returns the event that started or ended on this frame, or null
   */
  step(
    tMs: number,
    hazard: boolean,
    type: HazardType,
    frequencyHz: number,
    smoothed: boolean
  ): FlashEvent | null {
    const out = this.out
    if (hazard) {
      const starting = !this.open
      if (starting) {
        this.open = true
        this.freqNext = 0
        this.freqCount = 0
        out.id = this.nextId++
        out.startT = tMs
        out.type = type
        out.smoothed = false
      }
      out.lastT = tMs
      if (type === 'red') out.type = 'red'
      if (smoothed) out.smoothed = true
      this.record(frequencyHz)
      if (starting) {
        out.kind = 'start'
        out.durationMs = null
        out.frequencyHz = this.median()
        return out
      }
      return null
    }
    if (this.open && tMs - out.lastT >= this.mergeMs) return this.finish()
    return null
  }

  /** End the open event now, e.g. when the capture restarts. Null if none is open. */
  flush(): FlashEvent | null {
    return this.open ? this.finish() : null
  }

  private finish(): FlashEvent {
    const out = this.out
    this.open = false
    out.kind = 'end'
    out.durationMs = out.lastT - out.startT
    out.frequencyHz = this.median()
    return out
  }

  private record(frequencyHz: number): void {
    if (!(frequencyHz > 0) || !Number.isFinite(frequencyHz)) return
    this.freqs[this.freqNext] = frequencyHz
    this.freqNext = (this.freqNext + 1) % this.freqs.length
    if (this.freqCount < this.freqs.length) this.freqCount++
  }

  private median(): number {
    if (this.freqCount === 0) return 0
    this.scratch.set(this.freqs.subarray(0, this.freqCount))
    return percentile(this.scratch, this.freqCount, 0.5)
  }
}
