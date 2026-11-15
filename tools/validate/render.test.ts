import { describe, expect, it } from 'vitest'
import { SRGB8_TO_LINEAR } from '../../src/core/luminance'
import {
  LUMINANCE_THRESHOLD,
  RENDER_DEFAULT_DELAY_FRAMES,
  RENDER_HEIGHT,
  RENDER_WIDTH
} from '../../src/shared/config'
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings'
import { drawText, hasGlyph, newCanvas, textWidth } from './draw'
import { defaultOutput, parseRenderArgs, reportText } from './render'
import {
  ClipRenderer,
  INFO_LEVELS,
  LAYOUT_NAMES,
  describeLimit,
  describeSettings,
  layoutFor,
  type Layout
} from './renderer'

const FPS = 60
/** A small layout for the tests: a 192x108 protected pane (2x2 pixels per grid cell) with
 *  the original at half size beside it, and no text. */
const SMALL: Layout = {
  width: 300,
  height: 120,
  protectedPane: { x: 0, y: 0, w: 192, h: 108 },
  originalPane: { x: 192, y: 0, w: 96, h: 54 },
  shrink: 2,
  text: null
}
const LEAD_IN = 30

/** A full-screen strobe between black and white after a grey lead-in: the grey level of
 *  frame n. `half` is the frames per half-cycle: 3 is 10 Hz at 60 fps, 5 is 6 Hz. */
const strobe =
  (half: number) =>
  (n: number): number =>
    n < LEAD_IN ? 124 : Math.floor((n - LEAD_IN) / half) % 2 === 0 ? 255 : 0

interface Run {
  renderer: ClipRenderer
  /** Linear level of one pixel of the protected pane, and of the original pane, per frame. */
  seen: number[]
  original: number[]
}

function run(
  level: (n: number) => number,
  frames: number,
  settings: Partial<Settings>,
  delay = 1
): Run {
  const renderer = new ClipRenderer(SMALL, { ...DEFAULT_SETTINGS, ...settings }, FPS, delay)
  const { w, h } = SMALL.protectedPane
  const frame = new Uint8Array(w * h * 4).fill(255)
  const seen: number[] = []
  const original: number[] = []
  for (let n = 0; n < frames; n++) {
    const v = level(n)
    for (let p = 0; p < frame.length; p += 4) frame[p] = frame[p + 1] = frame[p + 2] = v
    const canvas = renderer.frame(frame)
    seen.push(SRGB8_TO_LINEAR[canvas[(50 * SMALL.width + 90) * 4]])
    original.push(SRGB8_TO_LINEAR[canvas[(20 * SMALL.width + 192 + 40) * 4]])
  }
  return { renderer, seen, original }
}

const swing = (values: number[]): number => Math.max(...values) - Math.min(...values)

describe('offline render: the pipeline', () => {
  it('shows the frame untouched until the detector fires, then calms it one frame late', () => {
    const { renderer, seen, original } = run(strobe(3), 240, {})
    // The third fast change is on frame 36; with the default one-frame delay the viewer
    // sees the overlay from frame 37, so the first flashes get through as in the app.
    expect(RENDER_DEFAULT_DELAY_FRAMES).toBe(1)
    expect(renderer.summary().firstOverlayFrame).toBe(LEAD_IN + 6 + 1)
    expect(seen.slice(0, 37)).toEqual(original.slice(0, 37))
    // From a second later the protected picture is under the flash threshold, while the
    // original still swings between black and white.
    expect(swing(seen.slice(120))).toBeLessThan(LUMINANCE_THRESHOLD)
    expect(swing(original.slice(120))).toBeGreaterThan(0.9)
  })

  it('reaches the viewer exactly as many frames late as asked', () => {
    const first = (delay: number): number | null =>
      run(strobe(3), 60, {}, delay).renderer.summary().firstOverlayFrame
    expect(first(0)).toBe(LEAD_IN + 6)
    expect(first(2)).toBe(LEAD_IN + 6 + 2)
  })

  it('calms the same strobe with "Keep motion sharp" on', () => {
    const { renderer, seen } = run(strobe(3), 240, { mitigation: 'correct' })
    expect(renderer.summary().firstOverlayFrame).toBe(LEAD_IN + 6 + 1)
    expect(swing(seen.slice(120))).toBeLessThan(LUMINANCE_THRESHOLD)
  })

  it('reports the original as over the WCAG limit and the protected picture as under it', () => {
    const s = run(strobe(3), 240, {}).renderer.summary()
    expect(s.frames).toBe(240)
    expect(s.durationS).toBeCloseTo(4, 10)
    expect(s.episodes).toBe(1)
    expect(s.overlayS).toBeGreaterThan(3)
    expect(s.standard.original).toBeGreaterThan(0)
    expect(s.standard.protectedPane).toBe(0)
    expect(s.withSettings.original).toBeGreaterThanOrEqual(s.standard.original)
  })

  it('follows the flash limit: a 6 Hz strobe is smoothed at 3 and let through at 7', () => {
    const atThree = run(strobe(5), 240, {}).renderer.summary()
    const atSeven = run(strobe(5), 240, { flashLimit: 7 }).renderer.summary()
    expect(atThree.overlayS).toBeGreaterThan(0)
    expect(atSeven.overlayS).toBe(0)
    expect(atSeven.firstOverlayFrame).toBeNull()
    // The report still measures against the standard, whatever limit was asked for.
    expect(atSeven.standard.protectedPane).toBeGreaterThan(0)
    expect(atSeven.withSettings.original).toBe(0)
  })

  it('follows the sensitivity: strict waits longer than the standard position', () => {
    const standard = run(strobe(3), 120, {}).renderer.summary().firstOverlayFrame as number
    const strict = run(strobe(3), 120, { sensitivity: { trigger: 'strict' } }).renderer.summary()
      .firstOverlayFrame as number
    const sensitive = run(strobe(3), 120, {
      sensitivity: { trigger: 'early', streakN: 2 }
    }).renderer.summary().firstOverlayFrame as number
    expect(sensitive).toBeLessThan(standard)
    expect(strict).toBeGreaterThan(standard)
  })

  it('game mode: dims a strobe between two greys, never brightens, and is always drawn', () => {
    // 10 Hz between sRGB 80 and 230, after a lead-in at the dark level.
    const level = (n: number): number =>
      n < LEAD_IN ? 80 : Math.floor((n - LEAD_IN) / 3) % 2 === 0 ? 230 : 80
    const renderer = new ClipRenderer(SMALL, DEFAULT_SETTINGS, FPS, 1, 'dim')
    const { w, h } = SMALL.protectedPane
    const frame = new Uint8Array(w * h * 4).fill(255)
    const seen: number[] = []
    for (let n = 0; n < 240; n++) {
      const v = level(n)
      for (let p = 0; p < frame.length; p += 4) frame[p] = frame[p + 1] = frame[p + 2] = v
      const canvas = renderer.frame(frame)
      const code = canvas[(50 * SMALL.width + 90) * 4]
      // Never brighter than the brighter of this frame and the one before (one frame late).
      expect(code).toBeLessThanOrEqual(Math.max(v, level(Math.max(0, n - 1))) + 1)
      seen.push(SRGB8_TO_LINEAR[code])
    }
    expect(swing(seen.slice(120))).toBeLessThan(LUMINANCE_THRESHOLD)
    // It settles near the dark level, not in the middle.
    expect(Math.max(...seen.slice(120))).toBeLessThan(SRGB8_TO_LINEAR[80] + LUMINANCE_THRESHOLD)
    // The detector still had the overlay on for the burst, and the report counts that.
    const s = renderer.summary()
    expect(s.episodes).toBe(1)
    expect(s.firstOverlayFrame).toBe(LEAD_IN + 6 + 1)
    expect(s.standard.protectedPane).toBe(0)
  })

  it('game mode hold: keeps the level it started at through a strobe, and is always drawn', () => {
    // 10 Hz between sRGB 80 and 230, after a lead-in at the dark level.
    const level = (n: number): number =>
      n < LEAD_IN ? 80 : Math.floor((n - LEAD_IN) / 3) % 2 === 0 ? 230 : 80
    const renderer = new ClipRenderer(SMALL, DEFAULT_SETTINGS, FPS, 1, 'hold')
    const { w, h } = SMALL.protectedPane
    const frame = new Uint8Array(w * h * 4).fill(255)
    const seen: number[] = []
    for (let n = 0; n < 240; n++) {
      const v = level(n)
      for (let p = 0; p < frame.length; p += 4) frame[p] = frame[p + 1] = frame[p + 2] = v
      const canvas = renderer.frame(frame)
      seen.push(SRGB8_TO_LINEAR[canvas[(50 * SMALL.width + 90) * 4]])
    }
    // Before the detector fires the frames pass as they are, one frame late.
    expect(seen[LEAD_IN + 1]).toBeCloseTo(SRGB8_TO_LINEAR[230], 3)
    expect(swing(seen.slice(120))).toBeLessThan(LUMINANCE_THRESHOLD)
    // It holds the dark level it was at, not the middle of the two.
    expect(Math.max(...seen.slice(120))).toBeLessThan(SRGB8_TO_LINEAR[80] + LUMINANCE_THRESHOLD)
    const s = renderer.summary()
    expect(s.episodes).toBe(1)
    expect(s.firstOverlayFrame).toBe(LEAD_IN + 6 + 1)
    expect(s.standard.original).toBeGreaterThan(0)
    expect(s.standard.protectedPane).toBe(0)
  })

  it('refuses a layout or a delay it cannot draw', () => {
    expect(() => new ClipRenderer(SMALL, DEFAULT_SETTINGS, FPS, -1)).toThrow()
    expect(() => new ClipRenderer(SMALL, DEFAULT_SETTINGS, FPS, 1.5)).toThrow()
    expect(() => new ClipRenderer(SMALL, DEFAULT_SETTINGS, 0, 1)).toThrow()
    const lopsided = { ...SMALL, originalPane: { x: 192, y: 0, w: 100, h: 54 } }
    expect(() => new ClipRenderer(lopsided, DEFAULT_SETTINGS, FPS, 1)).toThrow()
  })
})

describe('offline render: layouts and words', () => {
  it('fits every layout inside a 1920x1080 frame, in whole pixels', () => {
    for (const name of LAYOUT_NAMES) {
      const l = layoutFor(name)
      expect([l.width, l.height]).toEqual([RENDER_WIDTH, RENDER_HEIGHT])
      for (const pane of [l.protectedPane, l.originalPane]) {
        if (!pane) continue
        for (const v of [pane.x, pane.y, pane.w, pane.h]) expect(Number.isInteger(v)).toBe(true)
        expect(pane.x + pane.w).toBeLessThanOrEqual(l.width)
        expect(pane.y + pane.h).toBeLessThanOrEqual(l.height)
        expect(pane.w / pane.h).toBeCloseTo(16 / 9, 10)
      }
    }
  })

  it('keeps the unprotected original small in the default layout', () => {
    const l = layoutFor('big-small')
    expect(l.protectedPane).toMatchObject({ w: 1280, h: 720 })
    expect(l.originalPane).toMatchObject({ w: 640, h: 360 })
    // 11% of the frame, under the quarter of the frame the broadcast-style rule allows.
    const share = (640 * 360) / (RENDER_WIDTH * RENDER_HEIGHT)
    expect(share).toBeLessThan(0.25)
    expect(layoutFor('equal').originalPane).toMatchObject({ w: 960, h: 540 })
    expect(layoutFor('protected-only').originalPane).toBeNull()
    expect(layoutFor('protected-only').text).toBeNull()
  })

  it('writes only the labels and the graph into the picture unless asked for the words', () => {
    for (const name of ['big-small', 'equal'] as const) {
      const plain = layoutFor(name)
      expect(plain.text?.details).toBeNull()
      expect(layoutFor(name, 'graph')).toEqual(plain)
      const full = layoutFor(name, 'full')
      expect(full.text?.details).not.toBeNull()
      // Either way the graph stays inside the frame, clear of the pictures.
      for (const l of [plain, full]) {
        const g = l.text?.graph as { x: number; y: number; w: number; h: number }
        expect(g.x + g.w).toBeLessThanOrEqual(l.width)
        expect(g.y + g.h).toBeLessThanOrEqual(l.height)
        expect(g.y).toBeGreaterThanOrEqual((l.originalPane?.y ?? 0) + (l.originalPane?.h ?? 0))
      }
    }
  })

  it('draws every layout without throwing', () => {
    for (const [name, info] of LAYOUT_NAMES.flatMap((n) =>
      INFO_LEVELS.map((i) => [n, i] as const)
    )) {
      const l = layoutFor(name, info)
      const renderer = new ClipRenderer(l, DEFAULT_SETTINGS, 30, 1)
      const frame = new Uint8Array(l.protectedPane.w * l.protectedPane.h * 4).fill(128)
      expect(renderer.frame(frame)).toHaveLength(RENDER_WIDTH * RENDER_HEIGHT * 4)
    }
  })

  it('says in words which settings a render used, with letters the font has', () => {
    const lines = [
      ...describeSettings(DEFAULT_SETTINGS, 1),
      ...describeSettings(
        {
          ...DEFAULT_SETTINGS,
          sensitivity: { trigger: 'strict' },
          concurrency: 'off',
          mitigation: 'correct'
        },
        2
      ),
      ...describeSettings(DEFAULT_SETTINGS, 1, 'dim'),
      ...describeSettings(DEFAULT_SETTINGS, 1, 'hold'),
      describeLimit(3),
      describeLimit(7)
    ]
    expect(lines).toContain('GAME MODE: ON')
    expect(lines).toContain('GAME MODE: HOLD THE USUAL LOOK')
    expect(lines).toContain('SENSITIVITY: STANDARD (3 CHANGES)')
    expect(lines).toContain('IGNORE MOVEMENT: ON')
    expect(lines).toContain('KEEP MOTION SHARP: OFF')
    expect(lines).toContain('SENSITIVITY: STRICT')
    expect(lines).toContain('KEEP MOTION SHARP: ON')
    expect(lines).toContain('OVERLAY DELAY: 2 FRAMES')
    expect(lines).toContain('LIMIT: 3 (WCAG)')
    expect(lines).toContain('LIMIT: 7 (TESTING, WCAG IS 3)')
    for (const line of lines) for (const char of line) expect(hasGlyph(char), char).toBe(true)
  })

  it('draws text as dots at the asked scale, clipped to the canvas', () => {
    const c = newCanvas(40, 20, [0, 0, 0])
    const end = drawText(c, 'l', 2, 3, 2, [255, 255, 255])
    expect(end).toBe(2 + 6 * 2)
    // An L: its top-left dot is lit, the dot to its right is not, its bottom row is.
    const lit = (x: number, y: number): boolean => c.data[(y * 40 + x) * 4] === 255
    expect(lit(2, 3)).toBe(true)
    expect(lit(5, 3)).toBe(false)
    expect(lit(10, 3 + 6 * 2)).toBe(true)
    expect(textWidth('AB', 3)).toBe((2 * 6 - 1) * 3)
    // Off the edge, and a character the font lacks: nothing is drawn, nothing throws.
    expect(() => drawText(c, 'WIDE TEXT ~', 30, 15, 4, [255, 255, 255])).not.toThrow()
    expect(hasGlyph('~')).toBe(false)
  })
})

describe('offline render: the command line', () => {
  it("uses the app's defaults when given only a file", () => {
    const args = parseRenderArgs(['clip.mp4'])
    expect(args.settings).toEqual(DEFAULT_SETTINGS)
    expect(args).toMatchObject({
      file: 'clip.mp4',
      out: null,
      layout: 'big-small',
      info: 'graph',
      delayFrames: 1,
      fps: null,
      startS: null,
      durationS: null
    })
    expect(defaultOutput('C:/clips/my clip.mp4').replace(/\\/g, '/')).toBe(
      'C:/clips/my clip.calmframe.mp4'
    )
  })

  it("takes every one of the app's settings", () => {
    const args = parseRenderArgs([
      '--sensitivity',
      'strict',
      'clip.mp4',
      '--ignore-movement',
      'off',
      '--keep-motion-sharp',
      'on',
      '--flash-limit',
      '7',
      '--layout',
      'equal',
      '--delay-frames',
      '0',
      '--fps',
      '30',
      '--start',
      '12.5',
      '--duration',
      '20',
      '--out',
      'demo.mp4'
    ])
    expect(args.settings).toEqual({
      ...DEFAULT_SETTINGS,
      sensitivity: { trigger: 'strict' },
      concurrency: 'off',
      mitigation: 'correct',
      flashLimit: 7
    })
    expect(args).toMatchObject({
      layout: 'equal',
      delayFrames: 0,
      fps: 30,
      startS: 12.5,
      durationS: 20,
      out: 'demo.mp4'
    })
    expect(parseRenderArgs(['clip.mp4', '--info', 'full']).info).toBe('full')
    expect(parseRenderArgs(['clip.mp4']).gameMode).toBe('off')
    expect(parseRenderArgs(['clip.mp4', '--game-mode', 'off']).gameMode).toBe('off')
    expect(parseRenderArgs(['clip.mp4', '--game-mode', 'on']).gameMode).toBe('dim')
    expect(parseRenderArgs(['clip.mp4', '--game-mode', 'hold']).gameMode).toBe('hold')
    expect(parseRenderArgs(['clip.mp4', '--sensitivity', '4']).settings.sensitivity).toEqual({
      trigger: 'early',
      streakN: 4
    })
  })

  it('refuses anything it does not understand, so a typo never renders the wrong settings', () => {
    const bad = [
      [],
      ['a.mp4', 'b.mp4'],
      ['clip.mp4', '--sharp', 'on'],
      ['clip.mp4', '--sensitivity', '5'],
      ['clip.mp4', '--sensitivity'],
      ['clip.mp4', '--ignore-movement', 'yes'],
      ['clip.mp4', '--flash-limit', '2'],
      ['clip.mp4', '--flash-limit', '4.5'],
      ['clip.mp4', '--layout', 'triple'],
      ['clip.mp4', '--info', 'everything'],
      ['clip.mp4', '--game-mode', 'yes'],
      ['clip.mp4', '--delay-frames', '9'],
      ['clip.mp4', '--fps', '120'],
      ['clip.mp4', '--start', '-1']
    ]
    for (const argv of bad) expect(() => parseRenderArgs(argv), argv.join(' ')).toThrow()
  })

  it('reports the flagged seconds, and says so when the flash limit was raised', () => {
    const summary = run(strobe(3), 240, {}).renderer.summary()
    const standard = reportText(parseRenderArgs(['clip.mp4']), 'out.mp4', 60, summary)
    expect(standard).toContain('original 4, protected picture 0')
    expect(standard).toContain('not a recording of the live overlay')
    expect(standard).not.toContain('raised')
    const raised = reportText(
      parseRenderArgs(['clip.mp4', '--flash-limit', '7']),
      'out.mp4',
      60,
      summary
    )
    expect(raised).toContain('the flash limit was raised to 7')
  })
})
