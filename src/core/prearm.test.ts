/**
 * Pre-arm. docs/SPEC.md, "Detection math", Step 7a.
 *
 * The four cases that decide whether the feature is worth having: it must help on a real
 * strobe, cost nothing when it is off, and refuse to leave the screen softened on content
 * that flashes without ever breaking the threshold.
 */

import { describe, expect, it } from 'vitest'
import {
  ALPHA_WARM,
  CAPTURE_FPS,
  PREARM_ALPHA,
  PREARM_FADE_MS,
  PREARM_MAX_MS,
  PREARM_OPACITY
} from '../shared/config'
import { Detector } from './detector'
import { OverlayStateMachine, type OverlayStateName, type StateOutput } from './stateMachine'
import { pulses, squareWave, syntheticFrames, type SequenceOptions } from './testing/synthetic'

const FPS = CAPTURE_FPS

interface Step {
  tMs: number
  waveFrame: number
  state: OverlayStateName
  changed: boolean
  hazard: boolean
  arm: boolean
  /** The overlay's own values: what a Phase 3 renderer reads. */
  opacity: number
  alpha: number
  dim: number
  red: boolean
  /** Pre-arm's request: what Phase 4 may read. */
  prearmOpacity: number
  prearmAlpha: number
}

/** Detector and state machine over one synthetic sequence, with pre-arm on or off. */
function run(options: SequenceOptions, prearm: boolean): Step[] {
  const detector = new Detector({ prearm })
  const machine = new OverlayStateMachine({ prearm })
  const steps: Step[] = []
  for (const f of syntheticFrames(options)) {
    const d = detector.step(f.rgb, f.tMs)
    const o: StateOutput = machine.step(f.tMs, d, FPS)
    steps.push({
      tMs: f.tMs,
      waveFrame: f.waveFrame,
      state: o.state,
      changed: o.changed,
      hazard: d.hazard,
      arm: d.arm,
      opacity: o.opacity,
      alpha: o.alpha,
      dim: o.dim,
      red: o.red,
      prearmOpacity: o.prearmOpacity,
      prearmAlpha: o.prearmAlpha
    })
  }
  return steps
}

/** Any smoothing asked for this frame, by either path. */
const smoothing = (s: Step): boolean => s.opacity > 0 || s.prearmOpacity > 0
/** Time from the first frame that asks for smoothing to the last, inclusive of the frame. */
const softenedMs = (steps: Step[]): number => steps.filter(smoothing).length * (1000 / FPS)
/** Frames on which the machine entered `state`. */
const entries = (steps: Step[], state: OverlayStateName): Step[] =>
  steps.filter((s) => s.changed && s.state === state)

/** A single bright flash over the whole screen: two quick opposing transitions. */
const explosion: SequenceOptions = {
  waveform: pulses(1, 3, 57),
  low: 0,
  high: 1,
  leadInMs: 500,
  durationMs: 1500
}

/** 10 Hz full-contrast strobe: transitions every 50 ms, trigger on the third at 100 ms. */
const strobe10Hz: SequenceOptions = {
  waveform: squareWave(10),
  low: 0,
  high: 1,
  leadInMs: 500,
  durationMs: 2000
}

/** 2 Hz: transitions 250 ms apart, so no cell's streak ever passes 1. Under the line. */
const flashing2Hz: SequenceOptions = {
  waveform: squareWave(2),
  low: 0,
  high: 1,
  leadInMs: 500,
  durationMs: 10000
}

describe('Step 7a: pre-arm on a single explosion', () => {
  const steps = run(explosion, true)

  it('arms on the first transition', () => {
    const armed = entries(steps, 'armed')
    expect(armed).toHaveLength(1)
    expect(armed[0].waveFrame).toBe(0)
    expect(armed[0].prearmOpacity).toBe(PREARM_OPACITY)
    expect(armed[0].prearmAlpha).toBe(PREARM_ALPHA)
  })

  it('never fully protects: two quick transitions are not a strobe', () => {
    expect(steps.some((s) => s.hazard)).toBe(false)
    expect(steps.some((s) => s.state === 'active')).toBe(false)
    expect(steps.every((s) => s.opacity === 0)).toBe(true)
  })

  it('disarms once nothing follows, and ends back in Safe', () => {
    expect(entries(steps, 'disarming')).toHaveLength(1)
    const last = steps[steps.length - 1]
    expect(last.state).toBe('safe')
    expect(last.prearmOpacity).toBe(0)
    expect(last.prearmAlpha).toBe(ALPHA_WARM)
  })

  it('softens the screen for about half a second, well inside the armed cap', () => {
    // Streak dies 167 ms after the second transition, then the 300 ms fade.
    expect(softenedMs(steps)).toBeGreaterThan(400)
    expect(softenedMs(steps)).toBeLessThan(PREARM_MAX_MS - PREARM_FADE_MS)
  })

  it('fades the request out rather than dropping it', () => {
    const fading = steps.filter((s) => s.state === 'disarming')
    expect(fading.length).toBeGreaterThan(10)
    for (let i = 1; i < fading.length; i++) {
      expect(fading[i].prearmOpacity).toBeLessThan(fading[i - 1].prearmOpacity)
      expect(fading[i].prearmAlpha).toBeGreaterThan(fading[i - 1].prearmAlpha)
    }
    expect(fading[fading.length - 1].prearmAlpha).toBeLessThan(ALPHA_WARM)
  })
})

describe('Step 7a: pre-arm on a 10 Hz strobe', () => {
  const on = run(strobe10Hz, true)
  const off = run(strobe10Hz, false)

  it('starts smoothing earlier than with pre-arm off', () => {
    const firstOn = on.find(smoothing)
    const firstOff = off.find(smoothing)
    expect(firstOn).toBeDefined()
    expect(firstOff).toBeDefined()
    expect(firstOn!.tMs).toBeLessThan(firstOff!.tMs)
    // Pre-arm goes on the first transition, the trigger on the third: two 50 ms gaps.
    expect(firstOff!.tMs - firstOn!.tMs).toBeCloseTo(100, 0)
    expect(firstOn!.waveFrame).toBe(0)
  })

  it('leaves the trigger alone: Active lands on the same frame either way', () => {
    const activeOn = on.find((s) => s.state === 'active')
    const activeOff = off.find((s) => s.state === 'active')
    expect(activeOn).toBeDefined()
    expect(activeOn!.tMs).toBe(activeOff!.tMs)
    expect(activeOn!.waveFrame).toBe(6)
    expect(activeOn!.alpha).toBe(activeOff!.alpha)
    expect(activeOn!.dim).toBe(activeOff!.dim)
  })

  it('hands over to Active and drops its own request', () => {
    const active = on.filter((s) => s.state === 'active')
    expect(active.length).toBeGreaterThan(0)
    for (const s of active) {
      expect(s.prearmOpacity).toBe(0)
      expect(s.prearmAlpha).toBe(ALPHA_WARM)
      expect(s.opacity).toBe(1)
    }
  })

  it('arms exactly once, because the strobe takes over from there', () => {
    expect(entries(on, 'armed')).toHaveLength(1)
    expect(on.some((s) => s.state === 'disarming')).toBe(false)
  })
})

describe('Step 7a: pre-arm on 2 Hz flashing, under the WCAG line', () => {
  const steps = run(flashing2Hz, true)

  it('never fully protects', () => {
    expect(steps.some((s) => s.hazard)).toBe(false)
    expect(steps.some((s) => s.state === 'active')).toBe(false)
  })

  it('arms once at the leading edge and never re-arms', () => {
    const armed = entries(steps, 'armed')
    expect(armed).toHaveLength(1)
    expect(armed[0].waveFrame).toBe(0)
    // The area rule keeps being met all the way through; the quiet gate is what stops it.
    expect(steps.filter((s) => s.arm).length).toBeGreaterThan(steps.length / 2)
  })

  it('leaves the screen alone for the rest of the run', () => {
    const total = steps.length * (1000 / FPS)
    expect(total).toBeGreaterThan(10000)
    expect(softenedMs(steps)).toBeLessThan(PREARM_MAX_MS)
    expect(softenedMs(steps) / total).toBeLessThan(0.1)
    // And it is one contiguous episode at the start, not a scatter of them.
    const last = steps.findLast(smoothing)
    expect(last!.tMs).toBeLessThan(1500)
  })
})

describe('Step 7a: pre-arm off behaves exactly as before', () => {
  const cases: [string, SequenceOptions][] = [
    ['a single explosion', explosion],
    ['a 10 Hz strobe', strobe10Hz],
    ['2 Hz flashing', flashing2Hz]
  ]

  for (const [name, options] of cases) {
    describe(name, () => {
      const off = run(options, false)

      it('never reaches the pre-arm states and never reports arm', () => {
        for (const s of off) {
          expect(s.state).not.toBe('armed')
          expect(s.state).not.toBe('disarming')
          expect(s.arm).toBe(false)
        }
      })

      it('leaves the pre-arm outputs neutral on every frame', () => {
        expect(off.every((s) => s.prearmOpacity === 0)).toBe(true)
        expect(off.every((s) => s.prearmAlpha === ALPHA_WARM)).toBe(true)
      })

      it('drives the overlay identically to a run with pre-arm on', () => {
        const on = run(options, true)
        expect(on).toHaveLength(off.length)
        for (let i = 0; i < off.length; i++) {
          // Pre-arm never writes these, so they must match frame for frame. The state name
          // is the only difference: Armed and Disarming stand where Safe stood.
          expect([on[i].opacity, on[i].alpha, on[i].dim, on[i].red]).toEqual([
            off[i].opacity,
            off[i].alpha,
            off[i].dim,
            off[i].red
          ])
          const armedHere = on[i].state === 'armed' || on[i].state === 'disarming'
          expect(armedHere ? 'safe' : on[i].state).toBe(off[i].state)
        }
      })
    })
  }
})

describe('Step 7a: the detector side on its own', () => {
  it('reports no arm and no arm area when the option is off', () => {
    const detector = new Detector()
    let sawTransition = false
    for (const f of syntheticFrames(strobe10Hz)) {
      const r = detector.step(f.rgb, f.tMs)
      sawTransition = sawTransition || r.luminanceTransitions > 0
      expect(r.arm).toBe(false)
      expect(r.armAreaFraction).toBe(0)
    }
    expect(sawTransition).toBe(true)
  })

  it('arms on the first transition, a full window ahead of the hazard', () => {
    const detector = new Detector({ prearm: true })
    // Stepped inside the loop: syntheticFrames reuses one buffer, so the frames cannot be
    // collected first and analysed afterwards.
    let firstArm: { waveFrame: number; armAreaFraction: number } | undefined
    let firstHazardFrame: number | undefined
    for (const f of syntheticFrames(strobe10Hz)) {
      const r = detector.step(f.rgb, f.tMs)
      if (r.arm && !firstArm) {
        firstArm = { waveFrame: f.waveFrame, armAreaFraction: r.armAreaFraction }
      }
      if (r.hazard && firstHazardFrame === undefined) firstHazardFrame = f.waveFrame
    }
    expect(firstArm).toEqual({ waveFrame: 0, armAreaFraction: 1 })
    expect(firstHazardFrame).toBe(6)
  })

  it('a hazard always implies arm', () => {
    const detector = new Detector({ prearm: true })
    for (const f of syntheticFrames(strobe10Hz)) {
      const r = detector.step(f.rgb, f.tMs)
      if (r.hazard) expect(r.arm).toBe(true)
    }
  })
})
