/**
 * The overlay's four states. docs/SPEC.md, "Mitigation math", "On fast, off slow".
 *
 * On within one frame, off only after a 1.5 s hold and a 0.75 s fade, so the overlay can
 * never switch in time with a strobe and become a hazard itself. Each step returns the
 * filter's alpha, the dim factor d and the overlay opacity for that frame.
 *
 * step() allocates nothing and returns the same output object every frame.
 */

import { ALPHA_MIN, ALPHA_WARM, DIM_MIN, FADE_MS, HOLD_MS } from '../shared/config'
import type { HazardType } from './detector'
import { filterParams, type FilterParams } from './filterMath'

export type OverlayStateName = 'safe' | 'active' | 'release' | 'disabled'

/** The parts of a DetectorResult the state machine reads. */
export interface Detection {
  hazard: boolean
  type: HazardType
  frequencyHz: number
  flashSize: number
}

export interface StateOutput {
  state: OverlayStateName
  /** Filter strength for Pass B. ALPHA_WARM whenever the overlay is not smoothing. */
  alpha: number
  /** Brightness scale for Pass C. */
  dim: number
  /** Overlay opacity, 0 (invisible) to 1. */
  opacity: number
  /** Apply the red desaturation in Pass C. */
  red: boolean
  /** True on the step where the state changed (for logging). */
  changed: boolean
}

export class OverlayStateMachine {
  private readonly out: StateOutput = {
    state: 'safe',
    alpha: ALPHA_WARM,
    dim: 1,
    opacity: 0,
    red: false,
    changed: false
  }
  private readonly params: FilterParams = { alpha: 0, dim: 0, residual: 0 }
  private lastHazardT = -Infinity
  private releaseStartT = 0
  /** Alpha and d at the moment the release began; the fade eases from these. */
  private releaseAlpha = ALPHA_WARM
  private releaseDim = 1

  get state(): OverlayStateName {
    return this.out.state
  }

  /**
   * Advance one frame.
   * @param tMs capture timestamp of the frame
   * @param detection this frame's detector result
   * @param captureFps measured capture rate, for the filter's frames per half-cycle
   */
  step(tMs: number, detection: Detection, captureFps: number): StateOutput {
    const out = this.out
    out.changed = false

    switch (out.state) {
      case 'disabled':
        return out

      case 'safe':
        if (detection.hazard) this.activate(tMs, detection, captureFps, ALPHA_WARM, 1, true)
        return out

      case 'active':
        if (detection.hazard) {
          this.lastHazardT = tMs
          this.strengthen(detection, captureFps)
        } else if (tMs - this.lastHazardT >= HOLD_MS) {
          // The hold ran out at lastHazardT + HOLD_MS; the fade is timed from then.
          this.releaseStartT = this.lastHazardT + HOLD_MS
          this.releaseAlpha = out.alpha
          this.releaseDim = out.dim
          this.enter('release')
          this.fade(tMs)
        }
        return out

      case 'release':
        if (detection.hazard) {
          // Straight back to Active, keeping whichever is stronger: the eased values or
          // what the new flash needs.
          this.activate(tMs, detection, captureFps, out.alpha, out.dim, false)
        } else {
          this.fade(tMs)
        }
        return out
    }
  }

  /** User switched protection off, or the watchdog fired. Hidden, filter kept warm. */
  disable(): void {
    if (this.out.state === 'disabled') return
    this.enter('disabled')
    this.toSafeValues()
  }

  /** User switched protection back on. */
  enable(): void {
    if (this.out.state !== 'disabled') return
    this.enter('safe')
    this.toSafeValues()
  }

  private activate(
    tMs: number,
    detection: Detection,
    captureFps: number,
    alpha: number,
    dim: number,
    fresh: boolean
  ): void {
    const out = this.out
    this.enter('active')
    this.lastHazardT = tMs
    out.opacity = 1
    if (fresh) {
      // Entering from Safe: start from what this flash needs, then only get stronger.
      this.target(detection, captureFps)
      out.alpha = this.params.alpha
      out.dim = this.params.dim
      out.red = detection.type === 'red'
    } else {
      out.alpha = alpha
      out.dim = dim
      this.strengthen(detection, captureFps)
    }
  }

  /** Re-evaluate alpha and d for this frame's flash; they may only get stronger. */
  private strengthen(detection: Detection, captureFps: number): void {
    const out = this.out
    this.target(detection, captureFps)
    if (this.params.alpha < out.alpha) out.alpha = this.params.alpha
    if (this.params.dim < out.dim) out.dim = this.params.dim
    if (detection.type === 'red') out.red = true
  }

  /** Alpha and d from the formulas. Without a usable frequency, assume the worst. */
  private target(detection: Detection, captureFps: number): void {
    const p = this.params
    if (
      detection.frequencyHz > 0 &&
      Number.isFinite(detection.frequencyHz) &&
      captureFps > 0 &&
      Number.isFinite(captureFps)
    ) {
      filterParams(detection.flashSize, detection.frequencyHz, captureFps, p)
    } else {
      p.alpha = ALPHA_MIN
      p.dim = DIM_MIN
    }
  }

  /** Opacity 1 -> 0 over FADE_MS while alpha eases to ALPHA_WARM and d to 1. */
  private fade(tMs: number): void {
    const out = this.out
    const p = (tMs - this.releaseStartT) / FADE_MS
    if (p >= 1) {
      this.enter('safe')
      this.toSafeValues()
      return
    }
    const k = p < 0 ? 0 : p
    out.opacity = 1 - k
    out.alpha = this.releaseAlpha + (ALPHA_WARM - this.releaseAlpha) * k
    out.dim = this.releaseDim + (1 - this.releaseDim) * k
  }

  private toSafeValues(): void {
    const out = this.out
    out.opacity = 0
    out.alpha = ALPHA_WARM
    out.dim = 1
    out.red = false
  }

  private enter(state: OverlayStateName): void {
    if (this.out.state !== state) {
      this.out.state = state
      this.out.changed = true
    }
  }
}
