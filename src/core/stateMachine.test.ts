import { describe, expect, it } from 'vitest'
import { ALPHA_MIN, ALPHA_WARM, DIM_MIN, FADE_MS, HOLD_MS } from '../shared/config'
import { Detector } from './detector'
import { filterParams } from './filterMath'
import { OverlayStateMachine, type Detection, type StateOutput } from './stateMachine'
import { squareWave, syntheticFrames } from './testing/synthetic'

const FPS = 60
const FRAME_MS = 1000 / FPS

const none: Detection = { hazard: false, type: 'none', frequencyHz: 0, flashSize: 0 }
const strobe10: Detection = { hazard: true, type: 'luminance', frequencyHz: 10, flashSize: 1 }
const mild10: Detection = { hazard: true, type: 'luminance', frequencyHz: 10, flashSize: 0.3 }
const red10: Detection = { hazard: true, type: 'red', frequencyHz: 10, flashSize: 0.2 }

/** Copies the output, since the state machine reuses one object. */
const snap = (o: StateOutput): StateOutput => ({ ...o })

describe('Phase 1 box 7: state machine', () => {
  it('starts Safe: invisible, filter warm, full brightness', () => {
    const sm = new OverlayStateMachine()
    const out = snap(sm.step(0, none, FPS))
    expect(out).toMatchObject({ state: 'safe', opacity: 0, alpha: ALPHA_WARM, dim: 1 })
  })

  it('turns fully on within one frame of a hazard', () => {
    const sm = new OverlayStateMachine()
    for (let k = 0; k < 10; k++) sm.step(k * FRAME_MS, none, FPS)
    const out = snap(sm.step(10 * FRAME_MS, strobe10, FPS))
    expect(out.state).toBe('active')
    expect(out.opacity).toBe(1)
    expect(out.changed).toBe(true)
    expect(out.alpha).toBeCloseTo(filterParams(1, 10, FPS).alpha, 12)
    expect(out.alpha).toBeCloseTo(0.052, 3)
  })

  it('holds for 1.5 s after the last hazard frame', () => {
    const sm = new OverlayStateMachine()
    const t0 = 1000
    sm.step(t0, strobe10, FPS)
    for (let t = t0 + FRAME_MS; t < t0 + HOLD_MS - 1; t += FRAME_MS) {
      const out = sm.step(t, none, FPS)
      expect(out.state).toBe('active')
      expect(out.opacity).toBe(1)
    }
    expect(sm.step(t0 + HOLD_MS - 0.5, none, FPS).state).toBe('active')
    const out = snap(sm.step(t0 + HOLD_MS, none, FPS))
    expect(out.state).toBe('release')
    expect(out.changed).toBe(true)
    expect(out.opacity).toBe(1)
  })

  it('fades opacity 1 to 0 over 0.75 s while alpha eases to warm and d to 1', () => {
    const sm = new OverlayStateMachine()
    const t0 = 0
    // Full contrast at 3 Hz: alpha clamps at 0.03 and d is 0.53.
    sm.step(t0, { hazard: true, type: 'luminance', frequencyHz: 3, flashSize: 1 }, FPS)
    const active = snap(sm.step(t0 + FRAME_MS, none, FPS))
    expect(active.alpha).toBe(ALPHA_MIN)
    expect(active.dim).toBeCloseTo(0.53, 2)

    const start = t0 + HOLD_MS
    const half = snap(sm.step(start + FADE_MS / 2, none, FPS))
    expect(half.state).toBe('release')
    expect(half.opacity).toBeCloseTo(0.5, 12)
    expect(half.alpha).toBeCloseTo((ALPHA_MIN + ALPHA_WARM) / 2, 12)
    expect(half.dim).toBeCloseTo((active.dim + 1) / 2, 12)

    const done = snap(sm.step(start + FADE_MS, none, FPS))
    expect(done).toMatchObject({ state: 'safe', opacity: 0, alpha: ALPHA_WARM, dim: 1 })
    expect(done.changed).toBe(true)
  })

  it('fades smoothly, never stepping back up', () => {
    const sm = new OverlayStateMachine()
    sm.step(0, strobe10, FPS)
    let prev = 1
    for (let t = FRAME_MS; t < HOLD_MS + FADE_MS + 100; t += FRAME_MS) {
      const o = sm.step(t, none, FPS).opacity
      expect(o).toBeLessThanOrEqual(prev)
      prev = o
    }
    expect(prev).toBe(0)
  })

  it('returns to Active at once when a hazard arrives mid-fade', () => {
    const sm = new OverlayStateMachine()
    sm.step(0, strobe10, FPS)
    const midFade = HOLD_MS + 0.4 * FADE_MS
    expect(sm.step(midFade, none, FPS).opacity).toBeCloseTo(0.6, 12)
    const back = snap(sm.step(midFade + FRAME_MS, strobe10, FPS))
    expect(back.state).toBe('active')
    expect(back.opacity).toBe(1)
    expect(back.changed).toBe(true)
    // Alpha goes straight back to what the flash needs, not the half-eased value.
    expect(back.alpha).toBeCloseTo(filterParams(1, 10, FPS).alpha, 12)
    // And the hold restarts from the new hazard.
    expect(sm.step(midFade + FRAME_MS + HOLD_MS - 1, none, FPS).state).toBe('active')
  })

  it('only lets alpha and d get stronger while Active', () => {
    const sm = new OverlayStateMachine()
    const mild = snap(sm.step(0, mild10, FPS))
    const strong = snap(sm.step(FRAME_MS, strobe10, FPS))
    const again = snap(sm.step(2 * FRAME_MS, mild10, FPS))
    expect(strong.alpha).toBeLessThan(mild.alpha)
    expect(again.alpha).toBe(strong.alpha)
  })

  it('keeps the red desaturation on for the whole episode once a red hazard is seen', () => {
    const sm = new OverlayStateMachine()
    expect(sm.step(0, strobe10, FPS).red).toBe(false)
    expect(sm.step(FRAME_MS, red10, FPS).red).toBe(true)
    expect(sm.step(2 * FRAME_MS, strobe10, FPS).red).toBe(true)
    expect(sm.step(2 * FRAME_MS + HOLD_MS + 1, none, FPS).red).toBe(true)
    expect(sm.step(2 * FRAME_MS + HOLD_MS + FADE_MS + 1, none, FPS).red).toBe(false)
  })

  it('assumes the worst when the frequency is unusable', () => {
    const sm = new OverlayStateMachine()
    const out = sm.step(0, { hazard: true, type: 'luminance', frequencyHz: 0, flashSize: 1 }, FPS)
    expect(out.alpha).toBe(ALPHA_MIN)
    expect(out.dim).toBe(DIM_MIN)
  })

  it('times the hold from capture timestamps, not frame counts', () => {
    // At 30 fps the hold is still 1.5 s, which is 45 frames rather than 90.
    const sm = new OverlayStateMachine()
    sm.step(0, strobe10, 30)
    let frames = 0
    while (sm.state === 'active') {
      frames++
      sm.step(frames * (1000 / 30), none, 30)
    }
    expect(frames).toBe(45)
  })

  it('stays hidden while Disabled, keeps the filter warm, and resumes when enabled', () => {
    const sm = new OverlayStateMachine()
    sm.step(0, strobe10, FPS)
    sm.disable()
    const off = snap(sm.step(FRAME_MS, strobe10, FPS))
    expect(off).toMatchObject({ state: 'disabled', opacity: 0, alpha: ALPHA_WARM, dim: 1 })
    sm.enable()
    expect(sm.state).toBe('safe')
    expect(sm.step(2 * FRAME_MS, strobe10, FPS).opacity).toBe(1)
  })
})

describe('state machine driven by the detector', () => {
  it('never toggles during a continuous 10 Hz strobe, then releases after hold and fade', () => {
    const detector = new Detector()
    const sm = new OverlayStateMachine()
    const strobeEnd = 500 + 3000
    const states: { t: number; state: string; opacity: number }[] = []
    const frames = syntheticFrames({
      waveform: (frame, tMs) => (tMs < 3000 ? squareWave(10)(frame, tMs) : 0),
      low: 0,
      high: 1,
      leadInMs: 500,
      durationMs: 6000
    })
    for (const f of frames) {
      const out = sm.step(f.tMs, detector.step(f.rgb, f.tMs), FPS)
      states.push({ t: f.tMs, state: out.state, opacity: out.opacity })
    }
    const firstOn = states.findIndex((s) => s.state === 'active')
    expect(firstOn).toBeGreaterThan(0)
    // From the first Active frame to the end of the strobe: opaque on every frame.
    const during = states.slice(firstOn).filter((s) => s.t < strobeEnd)
    expect(during.every((s) => s.state === 'active' && s.opacity === 1)).toBe(true)
    // Exactly one switch on and one release over the whole run.
    const changes = states.filter((s, i) => i > 0 && s.state !== states[i - 1].state)
    expect(changes.map((s) => s.state)).toEqual(['active', 'release', 'safe'])
    expect(states.at(-1)!.state).toBe('safe')
  })
})
