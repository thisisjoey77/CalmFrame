import { describe, expect, it } from 'vitest'
import {
  FAST_TRANSITION_INTERVAL_MS,
  LUMINANCE_THRESHOLD,
  RED_THRESHOLD,
  TRACKER_IDLE_RESET_MS
} from '../shared/config'
import { FALLING, IDLE, RISING, TransitionTracker } from './tracker'

const FRAME_MS = 1000 / 60

function luminanceTracker(cells = 1): TransitionTracker {
  return new TransitionTracker({ cells, threshold: LUMINANCE_THRESHOLD, kind: 'luminance' })
}

/** Feeds one value per frame to cell 0 at 60 fps and returns the frames that recorded a
 *  transition. */
function feed(tracker: TransitionTracker, values: number[], startFrame = 0): number[] {
  const hits: number[] = []
  values.forEach((y, k) => {
    tracker.update([y], null, (startFrame + k) * FRAME_MS)
    if (tracker.transitionsThisFrame > 0) hits.push(startFrame + k)
  })
  return hits
}

const repeat = (value: number, frames: number): number[] => new Array(frames).fill(value)

describe('transition tracker: Step 4 reversals', () => {
  it('records the first rise out of idle, and the fall after it', () => {
    const tr = luminanceTracker()
    const hits = feed(tr, [0.2, 0.2, 0.5, 0.5, 0.2])
    expect(hits).toEqual([2, 4])
    expect(tr.dir[0]).toBe(FALLING)
  })

  it('records a fall out of idle', () => {
    const tr = luminanceTracker()
    expect(feed(tr, [0.6, 0.6, 0.3])).toEqual([2])
    expect(tr.dir[0]).toBe(FALLING)
  })

  it('ignores changes under the 0.10 threshold', () => {
    const tr = luminanceTracker()
    expect(feed(tr, [0.3, 0.38, 0.3, 0.38, 0.3, 0.38])).toEqual([])
  })

  it('counts a flash that ramps over three frames once, with its full size', () => {
    const tr = luminanceTracker()
    // 0 -> 1 over three frames, hold, then back down over three frames.
    const hits = feed(tr, [0, 0, 0.15, 0.6, 1, 1, 0.7, 0.3, 0])
    expect(hits).toEqual([2, 6])
    expect(tr.swing[0]).toBeCloseTo(1, 12)
  })

  it('counts a 30 fps strobe sampled at 60 fps once per change', () => {
    const tr = luminanceTracker()
    expect(feed(tr, [0, 0, 1, 1, 0, 0, 1, 1])).toEqual([2, 4, 6])
  })

  it('catches the first change after a static scene even if it continues the old direction', () => {
    // The spec's reason for the idle state: the cell last rose, sits still for over a
    // second, then rises again. Without idle the second rise would be read as part of
    // the first and missed.
    const tr = luminanceTracker()
    const firstRise = feed(tr, [0.1, 0.1, 0.5])
    expect(firstRise).toEqual([2])
    const still = Math.ceil(TRACKER_IDLE_RESET_MS / FRAME_MS) + 2
    feed(tr, repeat(0.5, still), 3)
    expect(tr.dir[0]).toBe(IDLE)
    expect(feed(tr, [0.65], 3 + still)).toEqual([3 + still])
    expect(tr.dir[0]).toBe(RISING)
  })
})

describe('transition tracker: the dark limit (Step 4, rule 5)', () => {
  it('ignores a flash between two states both above 0.80', () => {
    const tr = luminanceTracker()
    const values = [0.85, 0.98, 0.85, 0.98, 0.85, 0.98, 0.85]
    expect(feed(tr, values)).toEqual([])
  })

  it('counts the same flash once its darker state drops below 0.80', () => {
    const tr = luminanceTracker()
    expect(feed(tr, [0.98, 0.85, 0.98, 0.5])).toEqual([3])
  })

  it('still counts a fall that ramps down from above the limit', () => {
    // A reversal that fails the dark limit is ignored outright, so the cell keeps its
    // peak of 0.98 and records the fall when it passes 0.70, with the full swing.
    const tr = luminanceTracker()
    feed(tr, [0.4, 0.98]) // rising transition, peak 0.98
    const hits = feed(tr, [0.85, 0.7, 0.4], 2)
    expect(hits).toEqual([3])
    expect(tr.swing[0]).toBeCloseTo(0.58, 12)
  })
})

describe('transition tracker: Step 5 bookkeeping', () => {
  it('starts a streak at 1 and extends it while transitions are under 167 ms apart', () => {
    const tr = luminanceTracker()
    // 10 Hz square wave: a change every 3 frames (50 ms).
    const values = [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0]
    const streaks: number[] = []
    values.forEach((y, k) => {
      tr.update([y], null, k * FRAME_MS)
      if (tr.transitionsThisFrame > 0) streaks.push(tr.streak[0])
    })
    expect(streaks).toEqual([1, 2, 3, 4])
    expect(tr.interval[0]).toBeCloseTo(50, 9)
  })

  it('restarts the streak at 1 when transitions are slower than 167 ms', () => {
    const tr = luminanceTracker()
    // 2 Hz: a change every 15 frames (250 ms).
    const values = [...repeat(0, 15), ...repeat(1, 15), ...repeat(0, 15), ...repeat(1, 15)]
    const streaks: number[] = []
    values.forEach((y, k) => {
      tr.update([y], null, k * FRAME_MS)
      if (tr.transitionsThisFrame > 0) streaks.push(tr.streak[0])
    })
    expect(streaks).toEqual([1, 1, 1])
  })

  it('resets the streak to 0 once 167 ms pass with no transition', () => {
    const tr = luminanceTracker()
    tr.update([0], null, 0)
    tr.update([1], null, 50)
    tr.update([0], null, 100)
    expect(tr.streak[0]).toBe(2)
    tr.update([0], null, 100 + FAST_TRANSITION_INTERVAL_MS)
    expect(tr.streak[0]).toBe(2)
    tr.update([0], null, 100 + FAST_TRANSITION_INTERVAL_MS + 1)
    expect(tr.streak[0]).toBe(0)
  })

  it('counts transitions in the last second, with the window open at its old end', () => {
    // Transitions at 0, 200, ..., 1000. At t = 1000 the window (0, 1000] holds five of
    // them. An evenly spaced 3 Hz strobe therefore holds 6 (3 flashes, which WCAG allows)
    // and the strict trigger at 7 means more than 3 flashes per second.
    const tr = luminanceTracker()
    tr.update([0], null, -100)
    ;[0, 200, 400, 600, 800, 1000].forEach((t, k) => tr.update([(k + 1) % 2], null, t))
    expect(tr.count[0]).toBe(5)
  })

  it('drops old transitions from the count', () => {
    const tr = luminanceTracker()
    tr.update([0], null, 0)
    tr.update([1], null, 100)
    tr.update([0], null, 200)
    expect(tr.count[0]).toBe(2)
    tr.update([0], null, 1099)
    expect(tr.count[0]).toBe(2)
    tr.update([0], null, 1100)
    expect(tr.count[0]).toBe(1)
    tr.update([0], null, 1200)
    expect(tr.count[0]).toBe(0)
  })

  it('resets all streaks after a frame gap over 250 ms', () => {
    // With timestamp-based streaks the 167 ms rule already implies this; the spec lists
    // it separately, so it is kept and tested explicitly.
    const tr = luminanceTracker(2)
    tr.update([0, 0], null, 0)
    tr.update([1, 1], null, 50)
    tr.update([0, 0], null, 100)
    expect(Array.from(tr.streak)).toEqual([2, 2])
    tr.update([0, 0], null, 400)
    expect(Array.from(tr.streak)).toEqual([0, 0])
  })

  it('returns a cell to idle after a second without transitions', () => {
    const tr = luminanceTracker()
    tr.update([0], null, 0)
    tr.update([1], null, 100)
    expect(tr.dir[0]).toBe(RISING)
    tr.update([1], null, 100 + TRACKER_IDLE_RESET_MS - 1)
    expect(tr.dir[0]).toBe(RISING)
    tr.update([1], null, 100 + TRACKER_IDLE_RESET_MS)
    expect(tr.dir[0]).toBe(IDLE)
  })

  it('tracks every cell independently', () => {
    const tr = luminanceTracker(3)
    tr.update([0, 0.5, 1], null, 0)
    tr.update([1, 0.5, 0], null, 50)
    expect(tr.transitionsThisFrame).toBe(2)
    expect(Array.from(tr.dir)).toEqual([RISING, IDLE, FALLING])
  })
})

describe('transition tracker: reversals that do not count (Step 5a)', () => {
  it('follows a reversal that is not counted, without adding to the streak or the count', () => {
    const tr = luminanceTracker()
    tr.update([0], null, 0)
    expect(tr.observe([1], null, 50)).toBe(1)
    expect(tr.flip[0]).toBe(RISING)
    tr.commit(50, [0])
    expect(tr.dir[0]).toBe(RISING)
    expect(tr.flipsThisFrame).toBe(1)
    expect(tr.transitionsThisFrame).toBe(0)
    expect([tr.streak[0], tr.count[0], tr.lastT[0]]).toEqual([0, 0, -Infinity])

    // The next reversal is found from where the uncounted one left the cell, and counts.
    expect(tr.observe([0], null, 100)).toBe(1)
    expect(tr.flip[0]).toBe(FALLING)
    tr.commit(100, [1])
    expect([tr.streak[0], tr.count[0], tr.lastT[0]]).toEqual([1, 1, 100])
  })

  it('counts every reversal when no mask is given, exactly as update() does', () => {
    const a = luminanceTracker()
    const b = luminanceTracker()
    const values = [0, 1, 1, 0, 1, 0, 0, 1]
    values.forEach((y, k) => {
      a.update([y], null, k * FRAME_MS)
      b.observe([y], null, k * FRAME_MS)
      b.commit(k * FRAME_MS, null)
    })
    expect([b.streak[0], b.count[0], b.lastT[0]]).toEqual([a.streak[0], a.count[0], a.lastT[0]])
    expect(a.count[0]).toBe(5)
  })

  it('keeps a cell out of idle while it keeps reversing, counted or not', () => {
    const tr = luminanceTracker()
    tr.update([0], null, 0)
    for (let k = 1; k <= 30; k++) {
      tr.observe([k % 2], null, k * 50)
      tr.commit(k * 50, [0])
      expect(tr.dir[0]).not.toBe(IDLE)
    }
    expect(tr.count[0]).toBe(0)
  })
})

describe('transition tracker: red (Step 3, Step 4 rule 7)', () => {
  function redTracker(): TransitionTracker {
    return new TransitionTracker({ cells: 1, threshold: RED_THRESHOLD, kind: 'red' })
  }

  it('records a red and black flash', () => {
    const tr = redTracker()
    const v = [0, 320, 0, 320]
    const rho = [0, 1, 0, 1]
    let total = 0
    v.forEach((value, k) => {
      tr.update([value], [rho[k]], k * 50)
      total += tr.transitionsThisFrame
    })
    expect(total).toBe(3)
  })

  it('needs a saturated state on at least one side', () => {
    // Large change in v, but neither state reaches R / (R + G + B) = 0.8.
    const tr = redTracker()
    const v = [0, 160, 0, 160]
    const rho = [0, 0.67, 0, 0.67]
    let total = 0
    v.forEach((value, k) => {
      tr.update([value], [rho[k]], k * 50)
      total += tr.transitionsThisFrame
    })
    expect(total).toBe(0)
  })

  it('needs a change of more than 20, not exactly 20', () => {
    const tr = redTracker()
    tr.update([100], [1], 0)
    tr.update([120], [1], 50)
    expect(tr.transitionsThisFrame).toBe(0)
    tr.update([121], [1], 100)
    expect(tr.transitionsThisFrame).toBe(1)
  })

  it('refuses to run without red ratios', () => {
    expect(() => redTracker().update([0], null, 0)).toThrow()
  })
})
