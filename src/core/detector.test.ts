import { describe, expect, it } from 'vitest'
import { AREA_WINDOW_COLS, AREA_WINDOW_ROWS, GRID_CELLS, GRID_COLS } from '../shared/config'
import { Detector, type DetectorOptions } from './detector'
import {
  centredRect,
  fadeLoop,
  patchOfGrid,
  patchOfWindow,
  pulses,
  runDetector,
  singleCut,
  squareWave,
  syntheticFrames,
  type Rect,
  type RunSummary,
  type SequenceOptions,
  type Waveform
} from './testing/synthetic'

const WCAG_WINDOW = { cols: AREA_WINDOW_COLS, rows: AREA_WINDOW_ROWS }
const FRAME_MS = 1000 / 60

/** Full-contrast strobe after a half-second steady lead-in. */
function strobe(frequencyHz: number, extra: Partial<SequenceOptions> = {}): SequenceOptions {
  return {
    waveform: squareWave(frequencyHz),
    low: 0,
    high: 1,
    leadInMs: 500,
    durationMs: 3000,
    ...extra
  }
}

function run(options: SequenceOptions, detectorOptions: DetectorOptions = {}): RunSummary {
  return runDetector(new Detector(detectorOptions), options)
}

const area = (r: Rect): number => r.w * r.h

describe('Phase 1 box 1: strobes and cuts on synthetic grids', () => {
  it('a 2 Hz full-screen strobe is safe, in early and strict mode', () => {
    expect(run(strobe(2, { durationMs: 6000 })).everHazard).toBe(false)
    expect(run(strobe(2, { durationMs: 6000 }), { trigger: 'strict' }).everHazard).toBe(false)
  })

  it('a 10 Hz full-screen strobe is a hazard', () => {
    const result = run(strobe(10))
    expect(result.everHazard).toBe(true)
    expect(result.firstHazard?.type).toBe('luminance')
  })

  it('a single cut is safe', () => {
    const result = run(strobe(10, { waveform: singleCut }))
    expect(result.luminanceTransitionFrames).toHaveLength(1)
    expect(result.everHazard).toBe(false)
  })

  it('a cut to white and back makes two transitions and is safe', () => {
    const result = run(strobe(10, { waveform: pulses(1, 4, 0) }))
    expect(result.luminanceTransitionFrames).toHaveLength(2)
    expect(result.everHazard).toBe(false)
  })

  it('hard cuts every 2 s are safe', () => {
    expect(run(strobe(0.25, { durationMs: 8000 })).everHazard).toBe(false)
  })

  it('3.75 Hz is a hazard in both trigger modes', () => {
    expect(run(strobe(3.75)).everHazard).toBe(true)
    expect(run(strobe(3.75), { trigger: 'strict' }).everHazard).toBe(true)
  })
})

describe('Step 7: the flash limit (3 by default; raised only for testing)', () => {
  const both = (frequencyHz: number, flashLimit: number): boolean[] => [
    run(strobe(frequencyHz), { flashLimit }).everHazard,
    run(strobe(frequencyHz), { flashLimit, trigger: 'strict' }).everHazard
  ]

  it('at 3 it is the detector as it always was', () => {
    for (const f of [2, 3.75, 10]) {
      expect(both(f, 3)).toEqual([
        run(strobe(f)).everHazard,
        run(strobe(f), { trigger: 'strict' }).everHazard
      ])
    }
  })

  it('at 5, a 3.75 Hz strobe is let through and 6 Hz and faster are hazards', () => {
    expect(both(3.75, 5)).toEqual([false, false])
    expect(both(6, 5)).toEqual([true, true])
    expect(both(10, 5)).toEqual([true, true])
  })

  it('at 7, a 6 Hz strobe is let through and 7.5 Hz and faster are hazards', () => {
    expect(both(6, 7)).toEqual([false, false])
    expect(both(7.5, 7)).toEqual([true, true])
    expect(both(10, 7)).toEqual([true, true])
  })

  it('still fires the early trigger on the third fast transition at a raised limit', () => {
    const result = run(strobe(10), { flashLimit: 7 })
    expect(result.firstHazard?.frame).toBe(result.luminanceTransitionFrames[2].frame)
  })

  it('rejects a limit that is not positive', () => {
    expect(() => new Detector({ flashLimit: 0 })).toThrow()
  })
})

describe('Phase 1 box 2: early mode fires on exactly the third fast transition', () => {
  it('from a dark lead-in', () => {
    const result = run(strobe(10))
    expect(result.firstHazard?.frame).toBe(result.luminanceTransitionFrames[2].frame)
  })

  it('from a bright lead-in', () => {
    const result = run(strobe(10, { low: 1, high: 0 }))
    expect(result.firstHazard?.frame).toBe(result.luminanceTransitionFrames[2].frame)
  })

  it('at 5 and 15 Hz too', () => {
    for (const f of [5, 15]) {
      const result = run(strobe(f))
      expect(result.firstHazard?.frame).toBe(result.luminanceTransitionFrames[2].frame)
    }
  })

  it('when the strobe starts by continuing the direction of an old change', () => {
    // Rise from 0.1 to 0.5, stay still for 1.5 s, then strobe 0.5 <-> 0.9 starting with a
    // rise. The idle state is what lets that first rise count (Step 4).
    const stillFrames = 90
    const waveform: Waveform = (frame) => {
      if (frame <= stillFrames) return 0.5
      return Math.floor((frame - stillFrames - 1) / 3) % 2 === 0 ? 1 : 0.5
    }
    const result = run({ waveform, low: 0.1, high: 0.9, leadInMs: 200, durationMs: 3000 })
    const strobeTransitions = result.luminanceTransitionFrames.filter(
      (r) => r.waveFrame > stillFrames
    )
    expect(result.firstHazard?.frame).toBe(strobeTransitions[2].frame)
  })

  it('the sensitivity slider moves the trigger to the Nth transition', () => {
    for (const n of [2, 4]) {
      const result = run(strobe(10), { streakN: n })
      expect(result.firstHazard?.frame).toBe(result.luminanceTransitionFrames[n - 1].frame)
    }
  })

  it('strict mode fires on the seventh transition within a second', () => {
    const result = run(strobe(10), { trigger: 'strict' })
    expect(result.firstHazard?.frame).toBe(result.luminanceTransitionFrames[6].frame)
  })

  it('two quick double flashes trigger early mode but not strict (the accepted false positive)', () => {
    const lightning = strobe(10, { waveform: pulses(2, 3, 3), durationMs: 2000 })
    expect(run(lightning).everHazard).toBe(true)
    expect(run(lightning, { trigger: 'strict' }).everHazard).toBe(false)
  })
})

describe('Phase 1 box 3: the area rule', () => {
  it('a 10 Hz strobe filling 20% of a window is safe and 30% is a hazard', () => {
    const small = patchOfWindow(0.2, WCAG_WINDOW)
    const large = patchOfWindow(0.3, WCAG_WINDOW)
    const windowCells = WCAG_WINDOW.cols * WCAG_WINDOW.rows
    expect(area(small) / windowCells).toBeCloseTo(0.2, 1)
    expect(area(large) / windowCells).toBeCloseTo(0.3, 1)
    expect(run(strobe(10, { region: small })).everHazard).toBe(false)
    expect(run(strobe(10, { region: large })).everHazard).toBe(true)
  })

  it('switches at exactly a quarter of the window: 143 cells safe, 144 a hazard', () => {
    expect(run(strobe(10, { region: centredRect(11, 13) })).everHazard).toBe(false)
    expect(run(strobe(10, { region: centredRect(16, 9) })).everHazard).toBe(true)
  })

  it('a patch over 15% of the frame is a hazard in WCAG mode but passes in IRIS mode', () => {
    // The spec's "interesting row": it fills a whole 10° window, but not a quarter of the
    // frame.
    const patch = patchOfGrid(0.15)
    expect(area(patch) / GRID_CELLS).toBeCloseTo(0.15, 2)
    expect(run(strobe(10, { region: patch })).everHazard).toBe(true)
    expect(run(strobe(10, { region: patch }), { areaMode: 'iris' }).everHazard).toBe(false)
  })

  it('a patch over 30% of the frame is a hazard in both modes', () => {
    const patch = patchOfGrid(0.3)
    expect(run(strobe(10, { region: patch })).everHazard).toBe(true)
    expect(run(strobe(10, { region: patch }), { areaMode: 'iris' }).everHazard).toBe(true)
  })

  it('calibrated mode is stricter on a big monitor', () => {
    // 20% of a WCAG window is safe there, but a 24-inch monitor at 60 cm has a smaller
    // 10° window, so the same patch fills more than a quarter of it.
    const patch = patchOfWindow(0.2, WCAG_WINDOW)
    const monitor = { screenWidthCm: (24 * 2.54 * 16) / Math.hypot(16, 9) }
    expect(run(strobe(10, { region: patch })).everHazard).toBe(false)
    const calibrated = run(strobe(10, { region: patch }), {
      areaMode: 'calibrated',
      calibration: monitor
    })
    expect(calibrated.everHazard).toBe(true)
  })

  it('reports a hot mask that covers the flashing patch and nothing else', () => {
    const patch = centredRect(20, 12)
    const detector = new Detector()
    let mask: Uint8Array | undefined
    for (const f of syntheticFrames(strobe(10, { region: patch, durationMs: 1000 }))) {
      const r = detector.step(f.rgb, f.tMs)
      if (r.hazard) mask = Uint8Array.from(r.hotMask)
    }
    expect(mask).toBeDefined()
    let inside = 0
    let outside = 0
    mask!.forEach((hot, i) => {
      const x = i % GRID_COLS
      const y = Math.floor(i / GRID_COLS)
      const within = x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h
      if (within) inside += hot
      else outside += hot
    })
    expect(inside).toBe(area(patch))
    expect(outside).toBe(0)
  })
})

describe('Phase 1 box 4: contrast rules', () => {
  it('a swing of 0.05 is safe', () => {
    expect(run(strobe(10, { low: 0.2, high: 0.25 })).everHazard).toBe(false)
  })

  it('a flash between two states both above 0.80 is safe', () => {
    const result = run(strobe(10, { low: 0.85, high: 1 }))
    expect(result.luminanceTransitionFrames).toHaveLength(0)
    expect(result.everHazard).toBe(false)
  })

  it('the same swing with its darker state below 0.80 is a hazard', () => {
    expect(run(strobe(10, { low: 0.75, high: 0.95 })).everHazard).toBe(true)
  })

  it('a swing of 0.2 between two greys is a hazard', () => {
    expect(run(strobe(10, { low: 0.2, high: 0.4 })).everHazard).toBe(true)
  })
})

interface ColourFrame {
  hazard: boolean
  type: string
  lum: boolean
  red: boolean
}

/** Alternates the whole grid between two linear RGB colours every 3 frames (10 Hz). */
function runColours(a: number[], b: number[], durationMs = 2000): ColourFrame[] {
  const detector = new Detector()
  const rgb = new Float32Array(GRID_CELLS * 3)
  const results: ColourFrame[] = []
  const frames = Math.round((durationMs * 60) / 1000)
  for (let k = 0; k < frames; k++) {
    const c = k < 30 || Math.floor((k - 30) / 3) % 2 === 1 ? a : b
    for (let i = 0; i < GRID_CELLS; i++) rgb.set(c, i * 3)
    const r = detector.step(rgb, k * FRAME_MS)
    results.push({ hazard: r.hazard, type: r.type, lum: r.luminanceHazard, red: r.redHazard })
  }
  return results
}

describe('Phase 1 box 5: red flashes and slow fades', () => {
  it('a red and black strobe raises a red hazard', () => {
    const result = run(strobe(10, { colour: 'red' }))
    expect(result.everHazard).toBe(true)
    expect(result.firstHazard?.type).toBe('red')
    expect(result.firstHazard?.redHazard).toBe(true)
    // Pure red is Y = 0.21, so it is a luminance flash as well, as IRIS also reports.
    expect(result.firstHazard?.luminanceHazard).toBe(true)
  })

  it('red against a grey of the same luminance is a red hazard only', () => {
    const results = runColours([0.2126, 0.2126, 0.2126], [1, 0, 0])
    expect(results.some((r) => r.red)).toBe(true)
    expect(results.some((r) => r.lum)).toBe(false)
    expect(results.find((r) => r.hazard)?.type).toBe('red')
  })

  it('orange is not saturated red, so it is a luminance hazard only', () => {
    const results = runColours([0, 0, 0], [1, 0.5, 0])
    expect(results.some((r) => r.red)).toBe(false)
    expect(results.find((r) => r.hazard)?.type).toBe('luminance')
  })

  it('a slow 2-second fade loop is safe', () => {
    const result = run({ waveform: fadeLoop(2000), low: 0, high: 1, durationMs: 8000 })
    expect(result.luminanceTransitionFrames.length).toBeGreaterThan(0)
    expect(result.everHazard).toBe(false)
  })
})

describe('Step 8 outputs', () => {
  it('estimates the strobe frequency', () => {
    for (const f of [5, 10, 15]) {
      const result = run(strobe(f))
      const last = result.frames[result.frames.length - 1]
      expect(last.frequencyHz).toBeCloseTo(f, 6)
    }
  })

  it('measures the flash size as the luminance swing', () => {
    const full = run(strobe(10)).frames.at(-1)!
    const grey = run(strobe(10, { low: 0.2, high: 0.4 })).frames.at(-1)!
    expect(full.flashSize).toBeCloseTo(1, 6)
    expect(grey.flashSize).toBeCloseTo(0.2, 6)
  })

  it('plots flashes per second over a hazardous area against the limit at 3', () => {
    const graph = (f: number): number =>
      run(strobe(f, { durationMs: 2000 })).frames.at(-1)!.graphValue
    expect(graph(2)).toBe(2)
    expect(graph(10)).toBe(10)
    expect(graph(15)).toBe(15)
  })

  it('keeps the graph at 0 for a patch below the area limit', () => {
    const result = run(strobe(10, { region: centredRect(4, 4) }))
    expect(Math.max(...result.frames.map((r) => r.graphValue))).toBe(0)
  })

  it('reports the largest hot fraction of a window', () => {
    expect(run(strobe(10)).frames.at(-1)!.areaFraction).toBe(1)
  })

  it('clears the hazard within 167 ms of the strobe stopping', () => {
    const options = strobe(10, { waveform: pulses(15, 3, 3), durationMs: 2000 })
    const result = run(options)
    const lastTransition = result.luminanceTransitionFrames.at(-1)!
    const lastHazard = result.frames.filter((r) => r.hazard).at(-1)!
    expect(lastHazard.tMs - lastTransition.tMs).toBeLessThanOrEqual(167)
    expect(result.frames.at(-1)!.hazard).toBe(false)
  })
})

describe('IRIS extended failure (validator option)', () => {
  it('flags a sustained 2 Hz strobe after about 4 s, only when switched on', () => {
    const options = strobe(2, { durationMs: 6000 })
    const plain = run(options)
    expect(plain.frames.some((r) => r.extendedFailure)).toBe(false)

    const extended = run(options, { extendedFailure: true, areaMode: 'iris' })
    const first = extended.frames.find((r) => r.extendedFailure)!
    // The count reaches 4 at the fourth transition (0.75 s in), then 4 s must accumulate.
    const strobeStart = 500
    expect(first.tMs - strobeStart).toBeGreaterThan(4700)
    expect(first.tMs - strobeStart).toBeLessThan(4800)
    expect(first.hazard).toBe(true)
    expect(first.type).toBe('luminance')
  })

  it('does not fire on a strobe that only lasts 3 s', () => {
    const result = run(strobe(2, { durationMs: 3000 }), { extendedFailure: true })
    expect(result.everHazard).toBe(false)
  })
})

describe('detector contract', () => {
  it('reuses one result object, so it allocates nothing per frame', () => {
    const detector = new Detector()
    const rgb = new Float32Array(GRID_CELLS * 3)
    expect(detector.step(rgb, 0)).toBe(detector.step(rgb, 16))
  })

  it('ignores a frame that is not newer than the last', () => {
    const detector = new Detector()
    const dark = new Float32Array(GRID_CELLS * 3)
    const bright = new Float32Array(GRID_CELLS * 3).fill(1)
    detector.step(dark, 100)
    expect(detector.step(bright, 100).luminanceTransitions).toBe(0)
    expect(detector.step(bright, 50).luminanceTransitions).toBe(0)
    expect(detector.step(bright, 116).luminanceTransitions).toBe(GRID_CELLS)
  })

  it('accepts RGBA input from a GPU read-back', () => {
    const detector = new Detector({ inputChannels: 4 })
    const rgba = new Float32Array(GRID_CELLS * 4)
    let hazard = false
    for (let k = 0; k < 30; k++) {
      const level = Math.floor(k / 3) % 2
      for (let i = 0; i < GRID_CELLS; i++) rgba.set([level, level, level, 1], i * 4)
      hazard ||= detector.step(rgba, k * FRAME_MS).hazard
    }
    expect(hazard).toBe(true)
  })

  it('rejects an input of the wrong size', () => {
    expect(() => new Detector().step(new Float32Array(10), 0)).toThrow()
  })

  it('starts over after reset', () => {
    const detector = new Detector()
    runDetector(detector, strobe(10, { durationMs: 1000 }))
    detector.reset()
    expect(detector.step(new Float32Array(GRID_CELLS * 3), 5000).hazard).toBe(false)
  })
})
