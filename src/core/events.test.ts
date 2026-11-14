import { describe, expect, it } from 'vitest'
import { FADE_MS, FLASH_EVENT_MERGE_MS, HOLD_MS } from '../shared/config'
import type { HazardType } from './detector'
import { Detector } from './detector'
import { FlashEventTracker, type FlashEvent } from './events'
import { OverlayStateMachine } from './stateMachine'
import { squareWave, syntheticFrames } from './testing/synthetic'

const FRAME_MS = 1000 / 60

interface Frame {
  hazard: boolean
  type?: HazardType
  f?: number
  smoothed?: boolean
}

/** Feed frames at 60 fps from t = 0 and collect a copy of every report. */
function run(tracker: FlashEventTracker, frames: Frame[]): FlashEvent[] {
  const out: FlashEvent[] = []
  frames.forEach((fr, i) => {
    const e = tracker.step(
      i * FRAME_MS,
      fr.hazard,
      fr.type ?? (fr.hazard ? 'luminance' : 'none'),
      fr.f ?? 0,
      fr.smoothed ?? fr.hazard
    )
    if (e) out.push({ ...e })
  })
  return out
}

const repeat = (n: number, frame: Frame): Frame[] => Array.from({ length: n }, () => frame)
const quietFrames = (ms: number): Frame[] => repeat(Math.ceil(ms / FRAME_MS) + 1, { hazard: false })

describe('flash events (Phase 5 event log)', () => {
  it('merges hazards as long as the overlay would stay up: the hold plus the fade', () => {
    expect(FLASH_EVENT_MERGE_MS).toBe(HOLD_MS + FADE_MS)
  })

  it('starts on the first hazard frame and ends once the hazard has been gone for the merge time', () => {
    const t = new FlashEventTracker()
    const events = run(t, [
      ...repeat(10, { hazard: false }),
      ...repeat(120, { hazard: true, f: 10 }),
      ...quietFrames(FLASH_EVENT_MERGE_MS)
    ])
    expect(events.map((e) => e.kind)).toEqual(['start', 'end'])
    const [start, end] = events
    expect(start.id).toBe(1)
    expect(start.startT).toBeCloseTo(10 * FRAME_MS, 6)
    expect(start.durationMs).toBeNull()
    expect(start.frequencyHz).toBe(10)
    expect(end.id).toBe(1)
    expect(end.durationMs).toBeCloseTo(119 * FRAME_MS, 6)
    expect(end.frequencyHz).toBe(10)
    expect(end.smoothed).toBe(true)
    expect(t.active).toBe(false)
  })

  it('does not end before the merge time has passed', () => {
    const t = new FlashEventTracker()
    const events = run(t, [
      ...repeat(30, { hazard: true, f: 10 }),
      ...repeat(Math.floor(FLASH_EVENT_MERGE_MS / FRAME_MS) - 1, { hazard: false })
    ])
    expect(events.map((e) => e.kind)).toEqual(['start'])
    expect(t.active).toBe(true)
  })

  it('keeps flashing that stops and starts within the merge time as one event', () => {
    const t = new FlashEventTracker()
    const gap = repeat(Math.floor(1000 / FRAME_MS), { hazard: false }) // 1 s
    const events = run(t, [
      ...repeat(30, { hazard: true, f: 12 }),
      ...gap,
      ...repeat(30, { hazard: true, f: 12 }),
      ...gap,
      ...repeat(30, { hazard: true, f: 12 }),
      ...quietFrames(FLASH_EVENT_MERGE_MS)
    ])
    expect(events.map((e) => `${e.kind} ${e.id}`)).toEqual(['start 1', 'end 1'])
  })

  it('makes separate events of flashing further apart than the merge time', () => {
    const t = new FlashEventTracker()
    const events = run(t, [
      ...repeat(30, { hazard: true, f: 10 }),
      ...quietFrames(FLASH_EVENT_MERGE_MS),
      ...repeat(30, { hazard: true, f: 5 }),
      ...quietFrames(FLASH_EVENT_MERGE_MS)
    ])
    expect(events.map((e) => `${e.kind} ${e.id}`)).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
    expect(events[3].frequencyHz).toBe(5)
  })

  it('reports the median frequency, so the inflated estimates at the edges do not show', () => {
    const t = new FlashEventTracker()
    const events = run(t, [
      { hazard: true, f: 23.5 },
      ...repeat(40, { hazard: true, f: 10 }),
      { hazard: true, f: 0 }, // no usable estimate on this frame
      { hazard: true, f: 21 },
      ...quietFrames(FLASH_EVENT_MERGE_MS)
    ])
    expect(events[0].frequencyHz).toBe(23.5)
    expect(events[1].frequencyHz).toBe(10)
  })

  it('is red if any of its frames was a red hazard', () => {
    const t = new FlashEventTracker()
    const events = run(t, [
      ...repeat(10, { hazard: true, f: 10 }),
      { hazard: true, type: 'red', f: 10 },
      ...repeat(10, { hazard: true, f: 10 }),
      ...quietFrames(FLASH_EVENT_MERGE_MS)
    ])
    expect(events[0].type).toBe('luminance')
    expect(events[1].type).toBe('red')
  })

  it('says whether the overlay was drawn: not smoothed while protection is off', () => {
    const off = run(new FlashEventTracker(), [
      ...repeat(30, { hazard: true, f: 10, smoothed: false }),
      ...quietFrames(FLASH_EVENT_MERGE_MS)
    ])
    expect(off.map((e) => e.smoothed)).toEqual([false, false])
    // Protection switched on part way through: the end says smoothed.
    const later = run(new FlashEventTracker(), [
      ...repeat(30, { hazard: true, f: 10, smoothed: false }),
      ...repeat(30, { hazard: true, f: 10, smoothed: true }),
      ...quietFrames(FLASH_EVENT_MERGE_MS)
    ])
    expect(later.map((e) => e.smoothed)).toEqual([false, true])
  })

  it('ends an open event on flush, and flushes nothing when none is open', () => {
    const t = new FlashEventTracker()
    expect(t.flush()).toBeNull()
    run(t, repeat(30, { hazard: true, f: 10 }))
    const e = t.flush()
    expect(e?.kind).toBe('end')
    expect(e?.durationMs).toBeCloseTo(29 * FRAME_MS, 6)
    expect(t.flush()).toBeNull()
  })

  it('is one smoothed event per burst of the real detector and state machine', () => {
    // Two 2 s bursts of a 10 Hz full-contrast strobe, 4 s apart, through the detector and
    // the state machine as the overlay runs them.
    const detector = new Detector()
    const machine = new OverlayStateMachine()
    const t = new FlashEventTracker()
    const events: FlashEvent[] = []
    const burst = squareWave(10)
    const waveform = (frame: number, ms: number): number =>
      (ms >= 500 && ms < 2500) || (ms >= 6500 && ms < 8500) ? burst(frame, ms) : 0
    for (const s of syntheticFrames({ waveform, low: 0, high: 1, durationMs: 12000 })) {
      const d = detector.step(s.rgb, s.tMs)
      const o = machine.step(s.tMs, d, 60)
      const e = t.step(s.tMs, d.hazard, d.type, d.frequencyHz, o.opacity > 0)
      if (e) events.push({ ...e })
    }
    expect(events.map((e) => `${e.kind} ${e.id}`)).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
    for (const e of events) expect(e.smoothed).toBe(true)
    expect(events[1].frequencyHz).toBeGreaterThan(8)
    expect(events[1].frequencyHz).toBeLessThan(12)
    expect(events[1].durationMs).toBeGreaterThan(1500)
    expect(events[1].durationMs).toBeLessThan(2200)
  })
})
