import { describe, expect, it } from 'vitest'
import {
  COUNT_WINDOW_MS,
  GRID_CELLS,
  LUMINANCE_THRESHOLD,
  RESIDUAL_BLOCKS,
  TARGET_RESIDUAL
} from '../shared/config'
import { Detector } from './detector'
import { filterParams } from './filterMath'
import { OverlayStateMachine } from './stateMachine'
import { squareWave, syntheticFrames } from './testing/synthetic'
import { ViewerCheck, type ViewerCheckResult, type ViewerFrame } from './viewerCheck'

const FPS = 60

interface Sample extends ViewerCheckResult {
  tMs: number
}

/** A full-contrast strobe at f Hz, shown through a fixed overlay setting. */
function runFixed(f: number, frame: ViewerFrame, durationMs = 3000): Sample[] {
  const detector = new Detector()
  const check = new ViewerCheck()
  const out: Sample[] = []
  for (const s of syntheticFrames({ waveform: squareWave(f), low: 0, high: 1, durationMs })) {
    const d = detector.step(s.rgb, s.tMs)
    out.push({ tMs: s.tMs, ...check.step(s.rgb, s.tMs, frame, d.hotMask) })
  }
  return out
}

const residualsFrom = (samples: Sample[], tMs: number): number[] =>
  samples.filter((s) => s.tMs >= tMs && s.residual !== null).map((s) => s.residual as number)

describe('viewer check: the detector on what the viewer sees (Phase 4)', () => {
  it('flags an unsmoothed copy, and measures its residual as the whole flash', () => {
    // Alpha 1 copies the screen: the check must see exactly what the detector saw.
    const samples = runFixed(10, { alpha: 1, dim: 1, opacity: 1, red: false })
    expect(samples.some((s) => s.hazard)).toBe(true)
    const late = residualsFrom(samples, 1500)
    expect(late.length).toBeGreaterThan(0)
    for (const r of late) expect(r).toBeCloseTo(1, 6)
  })

  it('passes the copy smoothed with the solved alpha and d, and its residual is the target', () => {
    const { alpha, dim, residual } = filterParams(1, 10, FPS)
    expect(residual).toBeCloseTo(TARGET_RESIDUAL, 6)
    const samples = runFixed(10, { alpha, dim, opacity: 1, red: false }, 4000)
    expect(samples.some((s) => s.hazard)).toBe(false)
    // Once the filter has settled from its first frame, the measured swing is the
    // formula's. At alpha 0.046 the drift from a white first frame is still 0.02 at 1 s,
    // and the meter honestly counts it, so look at a window that starts at 2 s.
    const late = residualsFrom(samples, 3000)
    expect(late.length).toBeGreaterThan(0)
    for (const r of late) expect(r).toBeCloseTo(TARGET_RESIDUAL, 2)
  })

  it('is idle while the overlay is not drawn', () => {
    const samples = runFixed(10, { alpha: 0.25, dim: 1, opacity: 0, red: false }, 1500)
    for (const s of samples) {
      expect(s.checking).toBe(false)
      expect(s.residual).toBeNull()
    }
  })

  it('waits for a whole window of drawn frames before reporting a residual', () => {
    const samples = runFixed(10, { alpha: 1, dim: 1, opacity: 1, red: false }, 2000)
    const first = samples.find((s) => s.residual !== null)
    expect(first).toBeDefined()
    const blockMs = COUNT_WINDOW_MS / RESIDUAL_BLOCKS
    expect((first as Sample).tMs).toBeGreaterThanOrEqual(RESIDUAL_BLOCKS * blockMs)
    expect(samples.filter((s) => s.tMs < COUNT_WINDOW_MS).every((s) => s.residual === null)).toBe(
      true
    )
  })

  it('exposes what the viewer saw, for the protected preview', () => {
    const check = new ViewerCheck(3)
    const mask = new Uint8Array(GRID_CELLS)
    const grid = new Float32Array(GRID_CELLS * 3).fill(0.6)
    // Alpha 1 copies the frame into S, so the smoothed copy is d * X.
    check.step(grid, 0, { alpha: 1, dim: 0.5, opacity: 1, red: false }, mask)
    expect(check.seenGrid[0]).toBeCloseTo(0.3, 6)
    expect(check.seenGrid[GRID_CELLS * 3 - 1]).toBeCloseTo(0.3, 6)
    // Half opacity blends the copy over the raw screen: 0.5 * 0.3 + 0.5 * 0.6.
    check.step(grid, 20, { alpha: 1, dim: 0.5, opacity: 0.5, red: false }, mask)
    expect(check.seenGrid[0]).toBeCloseTo(0.45, 6)
  })

  it('reads RGBA grids as the GPU returns them', () => {
    const detector = new Detector()
    const rgbCheck = new ViewerCheck(3)
    const rgbaCheck = new ViewerCheck(4)
    const rgba = new Float32Array(GRID_CELLS * 4)
    const frame = { alpha: 0.1, dim: 0.8, opacity: 1, red: false }
    let compared = 0
    for (const s of syntheticFrames({
      waveform: squareWave(10),
      low: 0,
      high: 1,
      durationMs: 2000
    })) {
      for (let i = 0; i < GRID_CELLS; i++) {
        rgba[i * 4] = s.rgb[i * 3]
        rgba[i * 4 + 1] = s.rgb[i * 3 + 1]
        rgba[i * 4 + 2] = s.rgb[i * 3 + 2]
        rgba[i * 4 + 3] = 1
      }
      const d = detector.step(s.rgb, s.tMs)
      const a = { ...rgbCheck.step(s.rgb, s.tMs, frame, d.hotMask) }
      const b = rgbaCheck.step(rgba, s.tMs, frame, d.hotMask)
      expect(b).toEqual(a)
      if (a.residual !== null) compared++
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('stays under the threshold through the live loop, where each frame is filtered with the previous decision', () => {
    // The overlay applies Pass B in the frame callback, before that frame's own decision
    // is back from the GPU, so each frame is filtered with the alpha of the decision
    // before it. That one-frame lag must not let a flash through.
    const detector = new Detector()
    const sm = new OverlayStateMachine()
    const check = new ViewerCheck()
    let alphaForNext = sm.step(
      0,
      { hazard: false, type: 'none', frequencyHz: 0, flashSize: 0 },
      FPS
    ).alpha
    let onAt = -1
    let worst = 0
    let hazardSeen = false
    for (const s of syntheticFrames({
      waveform: squareWave(10),
      low: 0,
      high: 1,
      leadInMs: 500,
      durationMs: 4000
    })) {
      const alpha = alphaForNext
      const d = detector.step(s.rgb, s.tMs)
      const out = sm.step(s.tMs, d, FPS)
      alphaForNext = out.alpha
      const v = check.step(
        s.rgb,
        s.tMs,
        { alpha, dim: out.dim, opacity: out.opacity, red: out.red },
        d.hotMask
      )
      if (onAt < 0 && out.opacity === 1) onAt = s.tMs
      hazardSeen ||= v.hazard
      if (onAt >= 0 && s.tMs >= onAt + 2 * COUNT_WINDOW_MS && v.residual !== null) {
        worst = Math.max(worst, v.residual)
      }
    }
    expect(onAt).toBeGreaterThan(0)
    expect(hazardSeen).toBe(false)
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeLessThan(LUMINANCE_THRESHOLD)
  })
})
