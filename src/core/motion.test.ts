/**
 * Step 5a against movement: scrolling and dragging must not count as flashing, and every
 * strobe must still be caught on the same frame as before. Each case runs with the rule
 * on and with it off, so the tests also pin down what the fallback ('off') does.
 */

import { describe, expect, it } from 'vitest'
import { GRAPH_LIMIT_FLASHES_PER_SEC, GRID_COLS, GRID_ROWS } from '../shared/config'
import { Detector } from './detector'
import {
  centredRect,
  runFrames,
  sceneFrames,
  unevenTimes,
  type Rect,
  type RunSummary,
  type Scene
} from './testing/synthetic'

const DISPLAY_MS = 1000 / 60
/** Everything starts after a steady half second and lasts a second and a half. */
const ONSET_MS = 500
const ACTIVE_MS = 1500
const TOTAL_MS = 2200
/** 20 px per cell on a 1920x1080 screen. */
const cellsPerSec = (pxPerSec: number): number => pxPerSec / 20

/** Seconds since the onset, held at 0 before it and at the end after it. The screen only
 *  changes on its own 60 Hz frames, whenever the capture samples it. */
function activeS(tMs: number): number {
  const shown = Math.floor(tMs / DISPLAY_MS + 1e-6) * DISPLAY_MS
  return Math.min(ACTIVE_MS, Math.max(0, shown - ONSET_MS)) / 1000
}

/** A page of video thumbnails: four columns, a row every 340 px, on a plain background. */
function thumbnails(background: number): Scene {
  return (x, y) => {
    const row = Math.floor(y / 17)
    const inRow = y - row * 17
    const col = Math.floor((x - 13.5) / 20.5)
    const inCol = x - 13.5 - col * 20.5
    if (col < 0 || col > 3 || inCol > 19.75 || inRow < 4 || inRow > 15) return background
    // A different grey per thumbnail and per third of it, from 0.05 to 0.85.
    const part = Math.floor((inCol / 19.75) * 3)
    return 0.05 + (((row * 7 + col * 3 + part * 5) % 9) / 8) * 0.8
  }
}

const scroll =
  (page: Scene, pxPerSec: number): Scene =>
  (x, y, tMs) =>
    page(x, y + cellsPerSec(pxPerSec) * activeS(tMs), tMs)

/** 10 Hz square wave on display frames while active: true in the bright half. */
function strobeBright(tMs: number, hz = 10): boolean {
  const n = Math.floor(tMs / DISPLAY_MS + 1e-6) - Math.round(ONSET_MS / DISPLAY_MS)
  if (n < 0 || n >= Math.round(ACTIVE_MS / DISPLAY_MS)) return false
  return Math.floor(n / (30 / hz)) % 2 === 0
}

const inside = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

type Capture = 'even 60 fps' | 'uneven 40 fps'
const CAPTURES: Capture[] = ['even 60 fps', 'uneven 40 fps']

function run(scene: Scene, concurrency: 'one-way' | 'off', capture: Capture): RunSummary {
  const times = capture === 'uneven 40 fps' ? unevenTimes(TOTAL_MS) : undefined
  return runFrames(
    new Detector({ concurrency }),
    sceneFrames({ scene, durationMs: TOTAL_MS, times, subSamples: 3 })
  )
}

describe('Step 5a: movement is not flashing', () => {
  const dark = thumbnails(0.008)
  const light = thumbnails(1)

  it.each(CAPTURES)('scrolling a dark page of thumbnails at 2000 px/s, %s', (capture) => {
    const scene = scroll(dark, 2000)
    expect(run(scene, 'off', capture).everHazard).toBe(true)
    expect(run(scene, 'one-way', capture).everHazard).toBe(false)
  })

  it.each(CAPTURES)('scrolling a light page of thumbnails at 2000 px/s, %s', (capture) => {
    const scene = scroll(light, 2000)
    expect(run(scene, 'off', capture).everHazard).toBe(true)
    expect(run(scene, 'one-way', capture).everHazard).toBe(false)
  })

  it.each(CAPTURES)('dragging a light window around a dark desktop, %s', (capture) => {
    const scene: Scene = (x, y, tMs) => {
      const a = activeS(tMs)
      const left = 10 + 20 * (1 - Math.cos((2 * Math.PI * a) / 1.5))
      const top = 7 + 6 * Math.sin((2 * Math.PI * a) / 1.1)
      if (!inside({ x: left, y: top, w: 50, h: 32 }, x, y)) return 0.05
      return light(x - left + 13, y - top + 3, tMs)
    }
    expect(run(scene, 'off', capture).everHazard).toBe(true)
    expect(run(scene, 'one-way', capture).everHazard).toBe(false)
  })

  it('reports the reversals it set aside, and none when the rule is off', () => {
    const scene = scroll(dark, 2000)
    const ignored = (r: RunSummary): number =>
      r.frames.reduce((sum, f) => sum + f.ignoredReversals, 0)
    expect(ignored(run(scene, 'one-way', 'even 60 fps'))).toBeGreaterThan(1000)
    expect(ignored(run(scene, 'off', 'even 60 fps'))).toBe(0)
  })

  it('keeps the graph under the limit line while scrolling', () => {
    const peak = (r: RunSummary): number => Math.max(...r.frames.map((f) => f.graphValue))
    const scene = scroll(dark, 2000)
    expect(peak(run(scene, 'off', 'even 60 fps'))).toBeGreaterThan(GRAPH_LIMIT_FLASHES_PER_SEC)
    expect(peak(run(scene, 'one-way', 'even 60 fps'))).toBeLessThan(GRAPH_LIMIT_FLASHES_PER_SEC)
  })
})

describe('Step 5a: strobes are caught on the same frame as before', () => {
  const sameFirstHazard = (scene: Scene): void => {
    for (const capture of CAPTURES) {
      const before = run(scene, 'off', capture).firstHazard
      const after = run(scene, 'one-way', capture).firstHazard
      expect(before, capture).toBeDefined()
      expect(after?.frame, capture).toBe(before?.frame)
    }
  }
  const strobe =
    (region: Rect, hz: number, low: number, high: number, background: number): Scene =>
    (x, y, tMs) =>
      inside(region, x, y) ? (strobeBright(tMs, hz) ? high : low) : background
  const full = { x: 0, y: 0, w: GRID_COLS, h: GRID_ROWS }

  it.each([3.75, 5, 10, 15])('a full-screen %d Hz strobe', (hz) => {
    sameFirstHazard(strobe(full, hz, 0, 1, 0))
  })

  it('the low-contrast test-page patch', () => {
    sameFirstHazard(strobe({ x: 12, y: 13, w: 24, h: 27 }, 10, 0.1, 0.3, 0.2))
  })

  it('a patch just over the area limit', () => {
    sameFirstHazard(strobe(centredRect(18, 10), 10, 0.1, 0.3, 0.2))
  })

  it('a flash that ramps over three frames on a picture of mixed brightness', () => {
    // Cells of different brightness cross the 0.10 threshold on different frames of the ramp.
    const page = thumbnails(0.008)
    const ramp = [0, 0.5, 1, 1, 0.5, 0]
    sameFirstHazard((x, y, tMs) => {
      const base = page(x, y, tMs)
      const n = Math.floor(tMs / DISPLAY_MS + 1e-6) - Math.round(ONSET_MS / DISPLAY_MS)
      const on = n >= 0 && n < Math.round(ACTIVE_MS / DISPLAY_MS)
      return on ? base + (1 - base) * 0.8 * ramp[n % 6] : base
    })
  })

  it('a flashing video that moves with a slowly scrolling page', () => {
    const page = scroll(thumbnails(1), 300)
    sameFirstHazard((x, y, tMs) => {
      const top = 37.5 - cellsPerSec(300) * activeS(tMs)
      return inside({ x: 32, y: top, w: 32, h: 18 }, x, y)
        ? strobeBright(tMs)
          ? 0.7
          : 0.1
        : page(x, y, tMs)
    })
  })

  it('halves that flash in turn, left bright while right is dark', () => {
    sameFirstHazard((x, _y, tMs) => {
      const n = Math.floor(tMs / DISPLAY_MS + 1e-6) - Math.round(ONSET_MS / DISPLAY_MS)
      if (n < 0 || n >= Math.round(ACTIVE_MS / DISPLAY_MS)) return 0.2
      return strobeBright(tMs) === x < GRID_COLS / 2 ? 1 : 0
    })
  })
})

describe('Step 5a: what it does not fix, and what it gives up', () => {
  it.each(CAPTURES)(
    'a small flashing patch on a fast-scrolling page is caught at most one transition late, %s',
    (capture) => {
      // The scrolling around the patch reverses cells both ways inside the same window, so
      // on some frames the patch's own reversal is not one-way enough to count.
      const page = scroll(thumbnails(0.008), 2000)
      const patch = centredRect(18, 10)
      const scene: Scene = (x, y, tMs) =>
        inside(patch, x, y) ? (strobeBright(tMs) ? 0.3 : 0.1) : page(x, y, tMs)
      const before = run(scene, 'off', capture).firstHazard
      const after = run(scene, 'one-way', capture).firstHazard
      expect(before).toBeDefined()
      expect(after).toBeDefined()
      // One transition of a 10 Hz strobe is 50 ms.
      expect((after?.tMs ?? Infinity) - (before?.tMs ?? 0)).toBeLessThanOrEqual(50.001)
    }
  )

  it('a tab switch that repaints the window three times still triggers', () => {
    // Dark page, white blank, dark again, then the light page: every cell reverses together,
    // exactly like the first three transitions of a strobe.
    const win = centredRect(80, 45)
    const scene: Scene = (x, y, tMs) => {
      const a = Math.floor(tMs / DISPLAY_MS + 1e-6) * DISPLAY_MS - ONSET_MS
      if (a < 0 || !inside(win, x, y)) return 0.02
      return a < 50 ? 1 : a < 133 ? 0.02 : 0.85
    }
    expect(run(scene, 'one-way', 'even 60 fps').everHazard).toBe(true)
    expect(run(scene, 'off', 'even 60 fps').everHazard).toBe(true)
  })

  it('an inverting checkerboard of 60 px squares is no longer caught', () => {
    // Half the cells get brighter as the other half get darker, so neither way is one-way.
    const scene: Scene = (x, y, tMs) => {
      const square = (Math.floor(x / 3) + Math.floor(y / 3)) % 2
      const n = Math.floor(tMs / DISPLAY_MS + 1e-6) - Math.round(ONSET_MS / DISPLAY_MS)
      if (n < 0 || n >= Math.round(ACTIVE_MS / DISPLAY_MS)) return square
      return square === (strobeBright(tMs) ? 1 : 0) ? 1 : 0
    }
    expect(run(scene, 'off', 'even 60 fps').everHazard).toBe(true)
    expect(run(scene, 'one-way', 'even 60 fps').everHazard).toBe(false)
  })

  it('a scroll so fast that one edge sweeps a quarter-window per frame still counts', () => {
    // 6000 px/s is 5 rows per 60 Hz frame: one edge of a wide block alone changes 160 of
    // a window's 576 cells in a frame, all the same way.
    const bands: Scene = (_x, y) => (Math.floor(y / 12) % 2 === 0 ? 0.02 : 0.9)
    expect(run(scroll(bands, 6000), 'one-way', 'even 60 fps').everHazard).toBe(true)
  })
})
