/**
 * Tests for the strobe page's pure logic (tools/strobe/strobe.js).
 *
 * strobe.js is a classic browser script, because the page must stay one static page with
 * no build step and no dependencies. So it is loaded here into a vm context rather than
 * imported, and the API is read off that context's global.
 *
 * Two jobs:
 *  1. Pin the page's numbers to docs/SPEC.md and to src/shared/config.ts, which the page
 *     cannot import.
 *  2. Pin the page's luminance math to the spec's Step 1, through a reference
 *     implementation that stands in for src/core/luminance.ts until Phase 1 merges.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

import {
  DARK_LIMIT,
  LUMINANCE_THRESHOLD,
  RED_RATIO,
  RED_SCALE,
  RED_THRESHOLD
} from '../../src/shared/config'

interface GreyFlash {
  yLow: number
  yHigh: number
  swing: number
  meetsThreshold: boolean
  darkerUnderLimit: boolean
  countsAsFlash: boolean
}

interface RedFlash {
  ratioA: number
  ratioB: number
  vA: number
  vB: number
  deltaV: number
  saturated: boolean
  meetsThreshold: boolean
  countsAsRedFlash: boolean
}

interface FrequencyOption {
  framesPerHalfCycle: number
  hz: number
}

interface BurstStatus {
  phase: 'idle' | 'leadIn' | 'burst'
  leadInRemainingMs: number
  elapsedMs: number
  burstFrame: number
  half: 0 | 1 | null
  halfCycles: number
  measuredMs: number
  changed: boolean
  stopped: boolean
  reason: string | null
}

interface BurstRunner {
  readonly phase: 'idle' | 'leadIn' | 'burst'
  readonly burstMs: number
  start(now: number): void
  stop(): BurstStatus
  tick(now: number): BurstStatus
}

interface StrobeApi {
  LUMINANCE_THRESHOLD: number
  DARK_LIMIT: number
  RED_THRESHOLD: number
  RED_RATIO: number
  RED_SCALE: number
  FREQ_MIN_HZ: number
  FREQ_MAX_HZ: number
  DEFAULT_FREQ_HZ: number
  STANDARD_FREQS_HZ: number[]
  DEFAULT_SWING: number
  DEFAULT_AREA_SHARE: number
  DEFAULT_BURST_MS: number
  HARD_STOP_MS: number
  LEAD_IN_MS: number
  MAX_SWING_WITHOUT_FULL_CONTRAST: number
  srgbToLinear(channel: number): number
  linearToSrgb(linear: number): number
  byteToLinear(byte: number): number
  relativeLuminance(r: number, g: number, b: number): number
  greyLuminance(byte: number): number
  greyByteForLuminance(y: number): number
  defaultGreyBytes(): { dark: number; light: number }
  clampGreysToSwing(dark: number, light: number, maxSwing: number): { dark: number; light: number }
  redRatio(r: number, g: number, b: number): number
  redValue(r: number, g: number, b: number): number
  classifyGreyFlash(dark: number, light: number): GreyFlash
  classifyRedFlash(a: number[], b: number[]): RedFlash
  achievableFrequencies(refreshHz: number, minHz?: number, maxHz?: number): FrequencyOption[]
  snapFrequency(
    requestedHz: number,
    refreshHz: number,
    minHz?: number,
    maxHz?: number
  ): FrequencyOption | null
  estimateRefreshHz(timestamps: number[]): number | null
  achievedHz(halfCycles: number, elapsedMs: number): number | null
  rectForShare(
    share: number,
    windowWidth: number,
    windowHeight: number
  ): { width: number; height: number }
  createBurstRunner(options: {
    leadInMs?: number
    burstMs: number
    framesPerHalfCycle: number
  }): BurstRunner
}

function loadStrobe(): StrobeApi {
  const source = readFileSync(new URL('./strobe.js', import.meta.url), 'utf8')
  const sandbox: { CalmFrameStrobe?: StrobeApi } = {}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  if (!sandbox.CalmFrameStrobe) throw new Error('strobe.js did not define CalmFrameStrobe')
  return sandbox.CalmFrameStrobe
}

const S = loadStrobe()

const RED = [255, 0, 0]
const BLACK = [0, 0, 0]

describe('thresholds stay in step with src/shared/config.ts', () => {
  // The page hard-codes these because a dependency-free static page cannot import the
  // config module. CLAUDE.md's rule is that config.ts is the only source of truth, so
  // these assertions stand in for the import it cannot make.
  it('copies the five detection thresholds exactly', () => {
    expect(S.LUMINANCE_THRESHOLD).toBe(LUMINANCE_THRESHOLD)
    expect(S.DARK_LIMIT).toBe(DARK_LIMIT)
    expect(S.RED_THRESHOLD).toBe(RED_THRESHOLD)
    expect(S.RED_RATIO).toBe(RED_RATIO)
    expect(S.RED_SCALE).toBe(RED_SCALE)
  })
})

describe('page defaults match the Phase 2 checklist', () => {
  it('defaults to low contrast, 25% area and a 3 s burst, with a 5 s hard stop', () => {
    expect(S.DEFAULT_SWING).toBe(0.2)
    expect(S.DEFAULT_AREA_SHARE).toBe(0.25)
    expect(S.DEFAULT_BURST_MS).toBe(3000)
    expect(S.HARD_STOP_MS).toBe(5000)
    expect(S.LEAD_IN_MS).toBe(2000)
  })

  it('offers the spec frequency range and the three standard test frequencies', () => {
    expect(S.FREQ_MIN_HZ).toBe(1)
    expect(S.FREQ_MAX_HZ).toBe(30)
    expect(S.STANDARD_FREQS_HZ).toEqual([5, 10, 15])
  })

  it('opens on two greys a 0.2 swing apart, both under the dark limit', () => {
    const { dark, light } = S.defaultGreyBytes()
    expect(dark).toBe(89)
    expect(light).toBe(149)
    const flash = S.classifyGreyFlash(dark, light)
    expect(flash.swing).toBeCloseTo(S.DEFAULT_SWING, 2)
    expect(flash.yLow).toBeLessThan(DARK_LIMIT)
    expect(flash.yHigh).toBeLessThan(DARK_LIMIT)
    expect(flash.countsAsFlash).toBe(true)
  })

  it('keeps the swing under the cap until full contrast is turned on', () => {
    const limited = S.clampGreysToSwing(89, 255, S.MAX_SWING_WITHOUT_FULL_CONTRAST)
    expect(limited.dark).toBe(89)
    const flash = S.classifyGreyFlash(limited.dark, limited.light)
    expect(flash.swing).toBeLessThanOrEqual(S.MAX_SWING_WITHOUT_FULL_CONTRAST)
    // A pair already inside the cap is left alone.
    expect(S.clampGreysToSwing(89, 149, S.MAX_SWING_WITHOUT_FULL_CONTRAST)).toEqual({
      dark: 89,
      light: 149
    })
  })
})

describe('Step 1: linear light', () => {
  it('matches the two spec landmarks', () => {
    // "Mid-grey sRGB 128 is only Y = 0.22, and the 0.80 dark limit is sRGB 231."
    expect(S.greyLuminance(128)).toBeCloseTo(0.21586, 5)
    expect(S.greyByteForLuminance(DARK_LIMIT)).toBe(231)
  })

  it('maps the ends of the range exactly', () => {
    expect(S.srgbToLinear(0)).toBe(0)
    expect(S.srgbToLinear(1)).toBeCloseTo(1, 12)
    expect(S.greyLuminance(0)).toBe(0)
    expect(S.greyLuminance(255)).toBeCloseTo(1, 12)
  })

  it('round-trips through the inverse', () => {
    for (let byte = 0; byte <= 255; byte++) {
      expect(S.greyByteForLuminance(S.greyLuminance(byte))).toBe(byte)
    }
  })

  it('weights the channels as the spec does', () => {
    expect(S.relativeLuminance(255, 0, 0)).toBeCloseTo(0.2126, 6)
    expect(S.relativeLuminance(0, 255, 0)).toBeCloseTo(0.7152, 6)
    expect(S.relativeLuminance(0, 0, 255)).toBeCloseTo(0.0722, 6)
  })
})

describe('does a pair of states count as a flash?', () => {
  it('a 0.05 swing is under the threshold', () => {
    const flash = S.classifyGreyFlash(89, 108)
    expect(flash.swing).toBeLessThan(LUMINANCE_THRESHOLD)
    expect(flash.countsAsFlash).toBe(false)
  })

  it('two states both above 0.80 do not count, however big the swing', () => {
    const flash = S.classifyGreyFlash(232, 255)
    expect(flash.yLow).toBeGreaterThan(DARK_LIMIT)
    expect(flash.meetsThreshold).toBe(true)
    expect(flash.darkerUnderLimit).toBe(false)
    expect(flash.countsAsFlash).toBe(false)
  })

  it('reads the pair in either order', () => {
    expect(S.classifyGreyFlash(149, 89)).toEqual(S.classifyGreyFlash(89, 149))
  })
})

describe('Step 3: red and black', () => {
  it('is saturated red and clears the red threshold', () => {
    const red = S.classifyRedFlash(RED, BLACK)
    expect(red.ratioA).toBeCloseTo(1, 12)
    expect(red.vA).toBeCloseTo(RED_SCALE, 9)
    expect(red.vB).toBe(0)
    expect(red.deltaV).toBeGreaterThan(RED_THRESHOLD)
    expect(red.saturated).toBe(true)
    expect(red.countsAsRedFlash).toBe(true)
  })

  it('treats a grey pair as neither saturated nor a red transition', () => {
    const notRed = S.classifyRedFlash([89, 89, 89], [149, 149, 149])
    expect(notRed.ratioA).toBeLessThan(RED_RATIO)
    expect(notRed.vA).toBe(0)
    expect(notRed.countsAsRedFlash).toBe(false)
  })
})

describe('frequency snapped to what the display can show', () => {
  it('gives a 60 Hz display the set the spec names', () => {
    const options = S.achievableFrequencies(60, 1, 30)
    expect(options.slice(0, 6).map((option) => option.hz)).toEqual([30, 15, 10, 7.5, 6, 5])
    expect(options[0].framesPerHalfCycle).toBe(1)
    expect(options.every((option) => option.hz >= 1 && option.hz <= 30)).toBe(true)
    // f = 60 / (2n) stays at or above 1 Hz up to n = 30.
    expect(options).toHaveLength(30)
  })

  it('drives 10 Hz with three frames per half-cycle at 60 Hz, six at 120 Hz', () => {
    expect(S.snapFrequency(10, 60)).toEqual({ framesPerHalfCycle: 3, hz: 10 })
    expect(S.snapFrequency(10, 120)).toEqual({ framesPerHalfCycle: 6, hz: 10 })
  })

  it('snaps a request the display cannot show to the nearest it can', () => {
    expect(S.snapFrequency(12, 60)?.hz).toBe(10)
    expect(S.snapFrequency(26, 60)?.hz).toBe(30)
    // Exactly between 15 and 30: take the gentler one.
    expect(S.snapFrequency(22.5, 60)?.hz).toBe(15)
  })

  it('has nothing to offer a stopped display', () => {
    expect(S.achievableFrequencies(0, 1, 30)).toEqual([])
    expect(S.snapFrequency(10, 0)).toBeNull()
  })

  it('estimates the refresh rate from the median frame gap, ignoring a dropped frame', () => {
    const steady = [0, 16.7, 33.4, 50.1, 66.8]
    expect(S.estimateRefreshHz(steady)).toBeCloseTo(59.88, 2)
    const withStall = [0, 16.7, 33.4, 100, 116.7]
    expect(S.estimateRefreshHz(withStall)).toBeCloseTo(59.88, 2)
    expect(S.estimateRefreshHz([0])).toBeNull()
  })

  it('reports the frequency actually achieved from completed half-cycles', () => {
    expect(S.achievedHz(20, 1000)).toBeCloseTo(10, 9)
    expect(S.achievedHz(0, 1000)).toBeNull()
  })
})

describe('area as a share of the window', () => {
  it('covers exactly the requested share', () => {
    const rect = S.rectForShare(0.25, 1920, 1080)
    expect(rect).toEqual({ width: 960, height: 540 })
    expect((rect.width * rect.height) / (1920 * 1080)).toBeCloseTo(0.25, 6)
  })

  it('clamps to the window', () => {
    expect(S.rectForShare(1, 1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(S.rectForShare(2, 1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(S.rectForShare(0, 1920, 1080)).toEqual({ width: 0, height: 0 })
  })
})

describe('Phase 1 cross-check: luminance against the spec interface', () => {
  // Phase 1 owns src/core/luminance.ts (sRGB-to-linear, relative luminance, red ratio and
  // red value). It is not merged yet, so this reference implementation, written straight
  // from docs/SPEC.md "Step 1: linear light" and "Step 3: the red channel", stands in for
  // it. When Phase 1 lands, import the core module here instead of this stub and keep the
  // assertions: they are the contract between the page and the detector.
  const refSrgbToLinear = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const refLuminance = (r: number, g: number, b: number): number =>
    0.2126 * refSrgbToLinear(r / 255) +
    0.7152 * refSrgbToLinear(g / 255) +
    0.0722 * refSrgbToLinear(b / 255)
  const refRedRatio = (r: number, g: number, b: number): number => {
    const rl = refSrgbToLinear(r / 255)
    const sum = rl + refSrgbToLinear(g / 255) + refSrgbToLinear(b / 255)
    return sum > 0 ? rl / sum : 0
  }
  const refRedValue = (r: number, g: number, b: number): number =>
    RED_SCALE *
    Math.max(0, refSrgbToLinear(r / 255) - refSrgbToLinear(g / 255) - refSrgbToLinear(b / 255))

  it('agrees on every 8-bit grey', () => {
    for (let byte = 0; byte <= 255; byte++) {
      expect(S.greyLuminance(byte)).toBeCloseTo(refLuminance(byte, byte, byte), 12)
    }
  })

  it('agrees on the colours the page can show', () => {
    const colours = [RED, BLACK, [255, 255, 255], [89, 89, 89], [149, 149, 149]]
    for (const [r, g, b] of colours) {
      expect(S.relativeLuminance(r, g, b)).toBeCloseTo(refLuminance(r, g, b), 12)
      expect(S.redRatio(r, g, b)).toBeCloseTo(refRedRatio(r, g, b), 12)
      expect(S.redValue(r, g, b)).toBeCloseTo(refRedValue(r, g, b), 12)
    }
  })
})

describe('burst sequencing', () => {
  const FRAME_MS = 1000 / 60

  /** Drive a runner with 60 Hz frame timestamps and record what each tick returned. */
  function run(runner: BurstRunner, frames: number, startAt = 1000): BurstStatus[] {
    runner.start(startAt)
    const statuses: BurstStatus[] = []
    for (let i = 1; i <= frames; i++) {
      statuses.push(runner.tick(startAt + i * FRAME_MS))
    }
    return statuses
  }

  it('holds a steady lead-in, with nothing flashing, then flashes', () => {
    const runner = S.createBurstRunner({ leadInMs: 2000, burstMs: 3000, framesPerHalfCycle: 3 })
    const statuses = run(runner, 180)
    const leadIn = statuses.filter((status) => status.phase === 'leadIn')
    // 2 s of lead-in at 60 Hz, and not one frame of it changes the patch.
    expect(leadIn).toHaveLength(119)
    expect(leadIn.every((status) => status.half === null && !status.changed)).toBe(true)
    expect(leadIn[0].leadInRemainingMs).toBeCloseTo(2000 - FRAME_MS, 6)
    expect(statuses[119].phase).toBe('burst')
  })

  it('gives every half-cycle a whole number of display frames', () => {
    const runner = S.createBurstRunner({ leadInMs: 0, burstMs: 3000, framesPerHalfCycle: 3 })
    const burst = run(runner, 12).filter((status) => status.phase === 'burst')
    expect(burst.map((status) => status.half)).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1])
    // The patch colour is set on the first frame of each half-cycle and left alone after.
    expect(burst.map((status) => status.changed)).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false
    ])
  })

  it('reaches the requested frequency over a full burst', () => {
    // 60 Hz, 3 frames per half-cycle: 10 Hz, the spec's middle test frequency.
    const runner = S.createBurstRunner({ leadInMs: 0, burstMs: 3000, framesPerHalfCycle: 3 })
    const burst = run(runner, 200).filter((status) => status.phase === 'burst')
    const last = burst[burst.length - 1]
    // Measured between the first and last transition, so a part-finished half-cycle at
    // the end cannot bias it low.
    expect(S.achievedHz(last.halfCycles, last.measuredMs)).toBeCloseTo(10, 6)
  })

  it('stops itself when the burst length is up', () => {
    const runner = S.createBurstRunner({ leadInMs: 0, burstMs: 3000, framesPerHalfCycle: 3 })
    const statuses = run(runner, 200)
    const stopped = statuses.findIndex((status) => status.stopped)
    expect(stopped).toBeGreaterThan(0)
    expect(statuses[stopped].reason).toBe('burst complete')
    expect(statuses[stopped - 1].elapsedMs).toBeLessThan(3000)
    expect(runner.phase).toBe('idle')
  })

  it('never runs past the hard stop, however long a burst is asked for', () => {
    const runner = S.createBurstRunner({ leadInMs: 0, burstMs: 60000, framesPerHalfCycle: 3 })
    expect(runner.burstMs).toBe(S.HARD_STOP_MS)
    const statuses = run(runner, 400)
    const stopped = statuses.find((status) => status.stopped)
    expect(stopped?.reason).toBe('hard stop')
    expect(statuses.filter((status) => status.phase === 'burst').length).toBeLessThanOrEqual(
      Math.ceil(S.HARD_STOP_MS / FRAME_MS)
    )
    expect(runner.phase).toBe('idle')
  })

  it('stops on demand, mid-burst, and stays stopped', () => {
    const runner = S.createBurstRunner({ leadInMs: 0, burstMs: 5000, framesPerHalfCycle: 3 })
    runner.start(0)
    runner.tick(FRAME_MS)
    expect(runner.phase).toBe('burst')
    expect(runner.stop().stopped).toBe(true)
    expect(runner.phase).toBe('idle')
    expect(runner.tick(2 * FRAME_MS).phase).toBe('idle')
  })

  it('does not flash at all if it is stopped during the lead-in', () => {
    const runner = S.createBurstRunner({ leadInMs: 2000, burstMs: 3000, framesPerHalfCycle: 3 })
    runner.start(0)
    for (let i = 1; i <= 60; i++) expect(runner.tick(i * FRAME_MS).phase).toBe('leadIn')
    runner.stop()
    expect(runner.tick(1000).phase).toBe('idle')
  })
})
