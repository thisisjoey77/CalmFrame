/**
 * CPU reference for the smoothing filter, on the analysis grid. For tests only: the app
 * runs the same arithmetic on the GPU in Passes B and C (Phase 4).
 * docs/SPEC.md, "Mitigation math".
 */

import { RED_DESATURATION } from '../shared/config'
import { relativeLuminance } from './luminance'

export class ReferenceFilter {
  /** Smoothed linear RGB per cell, S. */
  readonly state: Float64Array
  private primed = false

  constructor(readonly cells: number) {
    this.state = new Float64Array(cells * 3)
  }

  /** S += alpha (X - S), per cell and channel, in linear light. The first frame primes S. */
  step(input: ArrayLike<number>, alpha: number): void {
    const s = this.state
    if (!this.primed) {
      for (let i = 0; i < s.length; i++) s[i] = input[i]
      this.primed = true
      return
    }
    for (let i = 0; i < s.length; i++) s[i] += alpha * (input[i] - s[i])
  }

  /**
   * What the overlay shows: d * S, and for a red hazard each cell blended
   * RED_DESATURATION of the way toward its own grey level ("Red flashes").
   */
  render(dim: number, red: boolean, out: Float32Array | Float64Array): void {
    const s = this.state
    for (let j = 0; j < s.length; j += 3) {
      let r = dim * s[j]
      let g = dim * s[j + 1]
      let b = dim * s[j + 2]
      if (red) {
        const y = relativeLuminance(r, g, b)
        r += RED_DESATURATION * (y - r)
        g += RED_DESATURATION * (y - g)
        b += RED_DESATURATION * (y - b)
      }
      out[j] = r
      out[j + 1] = g
      out[j + 2] = b
    }
  }
}
