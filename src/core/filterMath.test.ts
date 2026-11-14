import { describe, expect, it } from 'vitest'
import { ALPHA_MAX, ALPHA_MIN, DIM_MIN, RED_RATIO, TARGET_RESIDUAL } from '../shared/config'
import {
  dimFactor,
  filterParams,
  halfCycleFrames,
  residualSwing,
  solveAlpha,
  solveAlphaUnclamped
} from './filterMath'
import { redRatio, relativeLuminance } from './luminance'
import { ReferenceFilter } from './referenceFilter'

const FPS = 60

/**
 * Runs a square strobe of size dL with n frames per half-cycle through the reference
 * filter and returns the steady-state peak-to-peak swing of S.
 */
function simulatedSwing(flashSize: number, alpha: number, n: number): number {
  const filter = new ReferenceFilter(1)
  const halfCycles = 400
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < halfCycles * n; k++) {
    const level = Math.floor(k / n) % 2 === 0 ? 0 : flashSize
    filter.step([level, level, level], alpha)
    if (k >= (halfCycles - 4) * n) {
      lo = Math.min(lo, filter.state[0])
      hi = Math.max(hi, filter.state[0])
    }
  }
  return hi - lo
}

describe('Phase 1 box 6: the residual formula ("How much flicker survives")', () => {
  // Residual swing for a full black-to-white strobe at 60 fps. Rows are alpha, columns
  // 3, 5, 10 and 15 Hz. The alpha = 0.10, 15 Hz cell is 0.105 to three decimals, so 0.10
  // to two; the spec's first draft printed 0.11, a double-rounding slip, corrected there.
  const frequencies = [3, 5, 10, 15]
  const table: [number, number[]][] = [
    [0.15, [0.67, 0.45, 0.24, 0.16]],
    [0.1, [0.48, 0.31, 0.16, 0.1]],
    [0.05, [0.25, 0.15, 0.08, 0.05]],
    [0.03, [0.15, 0.09, 0.05, 0.03]]
  ]

  it('reproduces the spec table to two decimals', () => {
    for (const [alpha, row] of table) {
      row.forEach((expected, c) => {
        const n = halfCycleFrames(FPS, frequencies[c])
        expect(residualSwing(1, alpha, n)).toBeCloseTo(expected, 2)
      })
    }
  })

  it('matches a frame-by-frame simulated filter to three decimals', () => {
    for (const [alpha] of table) {
      for (const f of frequencies) {
        const n = halfCycleFrames(FPS, f)
        for (const flashSize of [1, 0.5, 0.2]) {
          expect(simulatedSwing(flashSize, alpha, n)).toBeCloseTo(
            residualSwing(flashSize, alpha, n),
            3
          )
        }
      }
    }
  })

  it('shows a fixed alpha of 0.15 fails at every frequency in the table', () => {
    for (const f of frequencies) {
      expect(residualSwing(1, 0.15, halfCycleFrames(FPS, f))).toBeGreaterThan(0.1)
    }
  })
})

describe('Phase 1 box 6: the alpha solver ("Choosing alpha from the detection")', () => {
  // [dL, f, required alpha, decimals the spec gives]
  const table: [number, number, number, number][] = [
    [1.0, 10, 0.052, 3],
    [0.5, 10, 0.1, 2],
    [0.3, 10, 0.17, 2],
    [1.0, 15, 0.077, 3],
    [1.0, 3, 0.016, 3]
  ]

  it('reproduces the spec table', () => {
    for (const [flashSize, f, expected, decimals] of table) {
      const alpha = solveAlphaUnclamped(flashSize, halfCycleFrames(FPS, f))
      expect(alpha).toBeCloseTo(expected, decimals)
    }
  })

  it('leaves exactly the target residual when it is not clamped', () => {
    for (const [flashSize, f] of table) {
      const n = halfCycleFrames(FPS, f)
      expect(residualSwing(flashSize, solveAlphaUnclamped(flashSize, n), n)).toBeCloseTo(
        TARGET_RESIDUAL,
        12
      )
    }
  })

  it('clamps alpha to 0.03..0.30', () => {
    expect(solveAlpha(1, halfCycleFrames(FPS, 3))).toBe(ALPHA_MIN)
    expect(solveAlpha(0.12, halfCycleFrames(FPS, 15))).toBe(ALPHA_MAX)
  })

  it('does not smooth a flash already under the target', () => {
    expect(solveAlphaUnclamped(0.05, 3)).toBe(1)
    const params = filterParams(0.05, 10, FPS)
    expect(params.alpha).toBe(ALPHA_MAX)
    expect(params.dim).toBe(1)
  })
})

describe('dimming ("Dimming covers what smoothing cannot")', () => {
  it('handles the worst case: full contrast at 3 Hz smooths at 0.03 and dims to 0.53', () => {
    const n = halfCycleFrames(FPS, 3)
    expect(residualSwing(1, ALPHA_MIN, n)).toBeCloseTo(0.15, 2)
    expect(dimFactor(1, ALPHA_MIN, n)).toBeCloseTo(0.53, 2)
  })

  it('leaves full brightness when smoothing alone is enough', () => {
    const n = halfCycleFrames(FPS, 10)
    // Unclamped alpha lands r on the target to within rounding, so d is 1 to 12 places.
    expect(dimFactor(1, solveAlpha(1, n), n)).toBeCloseTo(1, 12)
  })

  it('never dims below 0.4', () => {
    expect(dimFactor(1, ALPHA_MIN, 100)).toBe(DIM_MIN)
  })

  it('brings every hazardous strobe at 45 to 60 fps to the 0.08 target or under', () => {
    for (const fps of [45, 54, 60]) {
      for (const f of [3, 3.75, 5, 7.5, 10, 15, 30]) {
        for (const flashSize of [0.1, 0.2, 0.5, 0.8, 1]) {
          expect(filterParams(flashSize, f, fps).residual).toBeLessThanOrEqual(
            TARGET_RESIDUAL + 1e-12
          )
        }
      }
    }
  })
})

describe('reference filter output ("Red flashes")', () => {
  it('scales the state by d', () => {
    const filter = new ReferenceFilter(1)
    filter.step([0.5, 0.5, 0.5], 1)
    const out = new Float64Array(3)
    filter.render(0.5, false, out)
    expect(Array.from(out)).toEqual([0.25, 0.25, 0.25])
  })

  it('takes pure red from ratio 1.0 to 0.74, under the 0.8 line, keeping its luminance', () => {
    const filter = new ReferenceFilter(1)
    filter.step([1, 0, 0], 1)
    const out = new Float64Array(3)
    filter.render(1, true, out)
    expect(redRatio(out[0], out[1], out[2])).toBeCloseTo(0.74, 2)
    expect(redRatio(out[0], out[1], out[2])).toBeLessThan(RED_RATIO)
    expect(relativeLuminance(out[0], out[1], out[2])).toBeCloseTo(relativeLuminance(1, 0, 0), 12)
  })
})
