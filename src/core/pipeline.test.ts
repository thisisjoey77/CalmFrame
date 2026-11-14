/**
 * "Check the filter against the detector" (docs/SPEC.md, "Validation and measurement"):
 * run the detector on the filter's own output. If the smoothed picture produces no
 * transitions, it is under the threshold by the same rule that flagged the original.
 */

import { describe, expect, it } from 'vitest'
import { GRID_CELLS } from '../shared/config'
import { Detector } from './detector'
import { filterParams } from './filterMath'
import { ReferenceFilter } from './referenceFilter'
import { OverlayStateMachine } from './stateMachine'
import { squareWave, syntheticFrames } from './testing/synthetic'

const FPS = 60
const SETTLE_MS = 500

interface CheckedFrame {
  tMs: number
  transitions: number
  hazard: boolean
  graphValue: number
}

/** A full-contrast strobe at f Hz through the reference filter with the solved alpha and
 *  d, and the detector's verdict on every smoothed frame. */
function smoothAndCheck(f: number): CheckedFrame[] {
  const { alpha, dim } = filterParams(1, f, FPS)
  const filter = new ReferenceFilter(GRID_CELLS)
  const checker = new Detector()
  const shown = new Float32Array(GRID_CELLS * 3)
  const frames: CheckedFrame[] = []
  for (const frame of syntheticFrames({
    waveform: squareWave(f),
    low: 0,
    high: 1,
    durationMs: 4000
  })) {
    filter.step(frame.rgb, alpha)
    filter.render(dim, false, shown)
    const r = checker.step(shown, frame.tMs)
    frames.push({
      tMs: frame.tMs,
      transitions: r.luminanceTransitions,
      hazard: r.hazard,
      graphValue: r.graphValue
    })
  }
  return frames
}

const transitionsFrom = (frames: CheckedFrame[], tMs: number): number =>
  frames.filter((r) => r.tMs >= tMs).reduce((sum, r) => sum + r.transitions, 0)

describe('the filter checked by the detector', () => {
  it('a 10 Hz full-contrast strobe, smoothed with the solved alpha and d, has no transitions after 0.5 s', () => {
    // The test exactly as the spec states it.
    const frames = smoothAndCheck(10)
    expect(transitionsFrom(frames, SETTLE_MS)).toBe(0)
    expect(frames.some((r) => r.hazard)).toBe(false)
  })

  for (const f of [3, 5, 15]) {
    it(`a ${f} Hz full-contrast strobe, smoothed the same way, never flashes`, () => {
      // At 3 to 5 Hz alpha is clamped at 0.03, so the smoothed copy takes a couple of
      // seconds to settle from its white first frame. That slow drift can register an
      // isolated transition (at 5 Hz, one at 0.17 s and one at 2.18 s), never two within a
      // second, so not even one flash. Once settled there are none.
      const frames = smoothAndCheck(f)
      expect(frames.some((r) => r.hazard)).toBe(false)
      const late = frames.filter((r) => r.tMs >= SETTLE_MS)
      expect(Math.max(...late.map((r) => r.graphValue))).toBeLessThanOrEqual(0.5)
      expect(transitionsFrom(frames, 3000)).toBe(0)
    })
  }
})

describe('the whole pipeline: detector, state machine, filter, overlay', () => {
  it('shows the viewer no transitions from 0.5 s after the overlay turns on', () => {
    // What the viewer sees each frame: the raw screen, with the overlay drawn over it at
    // the state machine's opacity. The filter runs every frame, warm until the hazard.
    const detector = new Detector()
    const sm = new OverlayStateMachine()
    const filter = new ReferenceFilter(GRID_CELLS)
    const checker = new Detector()
    const smoothed = new Float32Array(GRID_CELLS * 3)
    const seen = new Float32Array(GRID_CELLS * 3)
    let onAt = -1
    let lateTransitions = 0
    let checkerHazardLate = false

    for (const frame of syntheticFrames({
      waveform: squareWave(10),
      low: 0,
      high: 1,
      leadInMs: 500,
      durationMs: 4000
    })) {
      const detection = detector.step(frame.rgb, frame.tMs)
      const out = sm.step(frame.tMs, detection, FPS)
      filter.step(frame.rgb, out.alpha)
      filter.render(out.dim, out.red, smoothed)
      for (let j = 0; j < seen.length; j++) {
        seen[j] = out.opacity * smoothed[j] + (1 - out.opacity) * frame.rgb[j]
      }
      if (onAt < 0 && out.opacity === 1) onAt = frame.tMs
      const r = checker.step(seen, frame.tMs)
      if (onAt >= 0 && frame.tMs >= onAt + SETTLE_MS) {
        lateTransitions += r.luminanceTransitions
        checkerHazardLate ||= r.hazard
        expect(out.state).toBe('active')
      }
    }

    expect(onAt).toBeGreaterThan(0)
    expect(lateTransitions).toBe(0)
    expect(checkerHazardLate).toBe(false)
  })
})
