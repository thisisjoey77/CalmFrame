import { describe, expect, it } from 'vitest'
import { greyLuminance } from './clips'
import {
  CLIPS,
  CLIP_FRAMES,
  LOW_GREY,
  SWING_005_HIGH,
  SWING_02_HIGH,
  halfCycleFrames,
  paintRgb24,
  patchRect,
  type ClipSpec
} from './clips'
import {
  COMPARISON_MODES,
  ClipAnalyser,
  csvToRows,
  rowsToCsv,
  secondFails,
  type SecondRow
} from './analyse'
import { clipVerdict, compareSeconds, secondRanges } from './compare'
import {
  IRIS_EXTENDED_FAIL,
  IRIS_FAIL,
  IRIS_WARNING,
  irisSecondFails,
  irisSeconds,
  irisWord,
  parseIrisCsv,
  parseTimeStamp,
  type IrisSecond
} from './iris'
import { modesFromArgs } from './validate'
import { VALIDATE_CLIP_FPS } from '../../src/shared/config'

/** Render a clip at a small size, straight into the analyser: the validator's pipeline
 *  without the video file. 192x108 is 2x2 pixels per grid cell. */
function analyseClip(clip: ClipSpec, width = 192, height = 108): Map<string, SecondRow[]> {
  const analyser = new ClipAnalyser(COMPARISON_MODES)
  const rgb = new Uint8Array(width * height * 3)
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < CLIP_FRAMES; i++) {
    paintRgb24(clip.frame(i), width, height, rgb)
    for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
      rgba[q] = rgb[p]
      rgba[q + 1] = rgb[p + 1]
      rgba[q + 2] = rgb[p + 2]
      rgba[q + 3] = 255
    }
    analyser.frame(rgba, width, height, (i * 1000) / VALIDATE_CLIP_FPS)
  }
  return analyser.results()
}

describe('validator clips (Phase 6, "Test clips")', () => {
  it('are the spec table, 10 s at 60 fps', () => {
    expect(CLIPS).toHaveLength(11)
    expect(CLIP_FRAMES).toBe(600)
  })

  it('only use strobes a 60 fps file can hold (30/n Hz)', () => {
    expect([2, 3.75, 10, 15].map((f) => halfCycleFrames(f))).toEqual([15, 8, 3, 2])
    expect(() => halfCycleFrames(7)).toThrow()
  })

  it('use greys with the swings the spec names', () => {
    expect(greyLuminance(SWING_02_HIGH) - greyLuminance(LOW_GREY)).toBeCloseTo(0.2, 2)
    expect(greyLuminance(SWING_005_HIGH) - greyLuminance(LOW_GREY)).toBeCloseTo(0.05, 2)
  })

  it('make patches with the stated share of the frame', () => {
    for (const area of [0.15, 0.3]) {
      const r = patchRect(area, 1920, 1080)
      expect((r.w * r.h) / (1920 * 1080)).toBeCloseTo(area, 3)
      expect(r.x * 2 + r.w).toBeCloseTo(1920, -1)
    }
  })

  it('hold still through the 3 s lead-in, then the strobe starts high', () => {
    const clip = CLIPS.find((c) => c.id === 'flash-10hz-full') as ClipSpec
    for (let i = 0; i < 180; i++) expect(clip.frame(i).background).toEqual([0, 0, 0])
    expect(clip.frame(180).background).toEqual([255, 255, 255])
    expect(clip.frame(183).background).toEqual([0, 0, 0])
  })

  it('paint the patch over the background', () => {
    const out = new Uint8Array(192 * 108 * 3)
    paintRgb24(
      { background: [0, 0, 0], patch: { area: 0.3, color: [255, 255, 255] } },
      192,
      108,
      out
    )
    const at = (x: number, y: number): number => out[(y * 192 + x) * 3]
    expect(at(96, 54)).toBe(255)
    expect(at(0, 0)).toBe(0)
  })
})

describe('validator analysis: every clip gets the verdict the spec expects', () => {
  for (const clip of CLIPS) {
    it(`${clip.title}: WCAG ${clip.expected.wcag}, IRIS ${clip.expected.iris}`, () => {
      const results = analyseClip(clip)
      const wcag = results.get('wcag') as SecondRow[]
      const iris = results.get('iris') as SecondRow[]
      expect(wcag).toHaveLength(10)
      const v = clipVerdict(wcag)
      expect(v === 'extended' ? 'safe' : v).toBe(clip.expected.wcag)
      expect(iris.some(secondFails)).toBe(clip.expected.iris === 'fail')
      // Nothing fails during the 3 s lead-in.
      for (const rows of [wcag, iris]) expect(rows.slice(0, 3).some(secondFails)).toBe(false)
    })
  }

  it('fails the 2 Hz clip only by the extended rule, after about 4 s of flashing', () => {
    const iris = analyseClip(CLIPS[0]).get('iris') as SecondRow[]
    expect(iris.some((r) => r.hazard)).toBe(false)
    const first = iris.findIndex((r) => r.extendedFailure)
    // Flashing starts at 3 s; the rule needs 4 s within 5 s.
    expect(first).toBeGreaterThanOrEqual(7)
  })
})

describe('validator CSV', () => {
  it('round-trips', () => {
    const rows: SecondRow[] = [
      { second: 0, frames: 60, graphMax: 0, hazard: false, type: 'none', extendedFailure: false },
      { second: 1, frames: 59, graphMax: 10.5, hazard: true, type: 'red', extendedFailure: true }
    ]
    expect(csvToRows(rowsToCsv(rows))).toEqual(rows)
  })

  it('runs the two comparison setups unless options are given', () => {
    expect(modesFromArgs([]).map((m) => m.name)).toEqual(['iris', 'wcag'])
    expect(modesFromArgs(['--area', 'iris', '--extended'])).toEqual([
      {
        name: 'custom',
        options: { areaMode: 'iris', trigger: 'strict', streakN: undefined, extendedFailure: true }
      }
    ])
    expect(() => modesFromArgs(['--area', 'nowhere'])).toThrow()
  })
})

describe('IRIS results (iris-pse-detection framedata.csv)', () => {
  const header =
    'Frame,TimeStamp,AverageLuminance,FlashAreaLuminance,AverageLuminanceDiff,AverageLuminanceDiffAcc,AverageRed,FlashAreaRed,AverageRedDiff,AverageRedDiffAcc,LuminanceTransitions,RedTransitions,LuminanceExtendedFailCount,RedExtendedFailCount,LuminanceFrameResult,RedFrameResult,PatternArea,PatternDetectedLines,PatternFrameResult'
  const row = (frame: number, ts: string, lum: number, red: number): string =>
    `${frame},${ts},0.5,100.00%,0,0,0,0.00%,0,0,0,0,0,0,${lum},${red},0.00%,0,0`

  it('reads time stamps', () => {
    expect(parseTimeStamp('00:00:01.500000')).toBe(1500)
    expect(parseTimeStamp('01:02:03.25')).toBe(3723250)
    expect(() => parseTimeStamp('soon')).toThrow()
  })

  it('reduces frames to seconds by the worst result, failing on extended or full failure', () => {
    const text = [
      header,
      row(0, '00:00:00.000000', 0, 0),
      row(1, '00:00:00.500000', IRIS_WARNING, 0),
      row(2, '00:00:01.000000', 0, IRIS_EXTENDED_FAIL),
      row(3, '00:00:02.000000', IRIS_FAIL, 0)
    ].join('\n')
    const s = irisSeconds(parseIrisCsv(text))
    expect(s.map(irisSecondFails)).toEqual([false, true, true])
    expect(s.map(irisWord)).toEqual(['warning', 'red extended fail', 'fail'])
  })
})

describe('comparison', () => {
  const ours = (fails: boolean[]): SecondRow[] =>
    fails.map((f, second) => ({
      second,
      frames: 60,
      graphMax: f ? 10 : 0,
      hazard: f,
      type: f ? 'luminance' : 'none',
      extendedFailure: false
    }))
  const iris = (fails: boolean[]): IrisSecond[] =>
    fails.map((f, second) => ({ second, frames: 60, luminance: f ? IRIS_FAIL : 0, red: 0 }))

  it('fills the two-by-two table and lists the seconds that disagree', () => {
    const c = compareSeconds(ours([false, true, true, false]), iris([false, true, false, true]))
    expect(c.table).toEqual({ bothFail: 1, bothPass: 1, onlyIris: 1, onlyCalmFrame: 1 })
    expect(c.disagreements.map((d) => d.second)).toEqual([2, 3])
  })

  it('skips seconds only one side has', () => {
    const c = compareSeconds(ours([true, true, true]), iris([true, true]))
    expect(c.table.bothFail).toBe(2)
  })

  it('writes seconds as ranges', () => {
    expect(secondRanges([3, 4, 5, 8, 10, 11])).toBe('3-5, 8, 10-11')
    expect(secondRanges([])).toBe('')
  })
})
