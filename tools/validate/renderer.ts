/**
 * The offline render's pipeline (docs/SPEC.md, "One gotcha to plan around"): what a viewer
 * of the live app would see, worked out from a video file, because no screen recorder can
 * see the overlay.
 *
 * Each frame goes through the same code as the app: the grid average, the detector and the
 * overlay state machine from src/core, with the app's own settings (sensitivity, "Ignore
 * movement", "Keep motion sharp", the flash limit). The picture is then calmed per pixel on
 * the CPU by the arithmetic the GPU passes are checked against: the smoothing filter, or
 * the brightness correction (regionCorrect.ts).
 *
 * As in the app, a frame is filtered with the strength decided on the frame before, and the
 * overlay's picture reaches the viewer a little late: here a whole number of frames,
 * `delayFrames`, over the screen as it is by then. So the first flash or two of a burst get
 * through, as they do live.
 *
 * This file has no ffmpeg or file access, so the tests drive it with generated frames.
 * render.ts is the command around it.
 */

import { Detector } from '../../src/core/detector'
import { averageToGrid } from '../../src/core/gridAverage'
import { SRGB8_TO_LINEAR, linearToSrgb } from '../../src/core/luminance'
import { ReferenceFilter } from '../../src/core/referenceFilter'
import { correctImage } from '../../src/core/regionCorrect'
import { OverlayStateMachine } from '../../src/core/stateMachine'
import {
  ALPHA_WARM,
  DASHBOARD_GRAPH_MIN_Y_MAX,
  DEFAULT_FLASH_LIMIT,
  GRID_CELLS,
  GRID_COLS,
  GRID_ROWS,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  RED_DESATURATION,
  RENDER_GRAPH_WINDOW_MS,
  RENDER_HEIGHT,
  RENDER_WIDTH,
  THUMBNAIL_LUT_SIZE,
  VALIDATE_SECOND_MS
} from '../../src/shared/config'
import {
  detectorOptionsFor,
  sensitivityPosition,
  DEFAULT_SETTINGS,
  type Settings
} from '../../src/shared/settings'
import { blit, drawText, fillRect, newCanvas, type Canvas, type Rgb } from './draw'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type LayoutName = 'big-small' | 'equal' | 'protected-only'
export const LAYOUT_NAMES: readonly LayoutName[] = ['big-small', 'equal', 'protected-only']

/** Where everything goes in the rendered frame. */
export interface Layout {
  width: number
  height: number
  /** The protected picture. Its size is also the size frames are processed at. */
  protectedPane: Rect
  /** The original picture, `shrink` times smaller than the protected one, or null. */
  originalPane: Rect | null
  shrink: number
  /** Labels, status, graph and footer, or null for a clean picture. Text positions are the
   *  top-left corner of the first line. */
  text: {
    labelY: number
    status: { x: number; y: number }
    settings: { x: number; y: number }
    graph: Rect
    footer: { x: number; y: number }
  } | null
}

/**
 * The three layouts, for a RENDER_WIDTH x RENDER_HEIGHT frame.
 * - big-small: a large protected picture and a small original. The original is small on
 *   purpose: it is unprotected flashing in a video other people will watch.
 * - equal: the two side by side at the same size.
 * - protected-only: the protected picture alone, full frame, with no text, for editing.
 */
export function layoutFor(name: LayoutName): Layout {
  const width = RENDER_WIDTH
  const height = RENDER_HEIGHT
  if (name === 'protected-only') {
    return {
      width,
      height,
      protectedPane: { x: 0, y: 0, w: width, h: height },
      originalPane: null,
      shrink: 1,
      text: null
    }
  }
  if (name === 'equal') {
    const w = width / 2
    const h = (w * 9) / 16
    const y = 200
    return {
      width,
      height,
      protectedPane: { x: 0, y, w, h },
      originalPane: { x: w, y, w, h },
      shrink: 1,
      text: {
        labelY: y - 50,
        status: { x: 40, y: y + h + 30 },
        settings: { x: 40, y: y + h + 140 },
        graph: { x: w + 40, y: y + h + 30, w: w - 80, h: 150 },
        footer: { x: 40, y: height - 80 }
      }
    }
  }
  const w = (width * 2) / 3
  const h = (w * 9) / 16
  const y = 150
  const small = { x: w, y, w: w / 2, h: h / 2 }
  const column = small.x + 20
  return {
    width,
    height,
    protectedPane: { x: 0, y, w, h },
    originalPane: small,
    shrink: 2,
    text: {
      labelY: y - 50,
      status: { x: column, y: small.y + small.h + 30 },
      graph: { x: column, y: small.y + small.h + 140, w: small.w - 40, h: 150 },
      settings: { x: column, y: small.y + small.h + 305 },
      footer: { x: 20, y: y + h + 60 }
    }
  }
}

/** What a render found, for the report. Seconds are whole seconds of the clip in which at
 *  least one frame was flagged. */
export interface RenderSummary {
  frames: number
  durationS: number
  /** How long the viewer saw the overlay's picture, and in how many separate stretches. */
  overlayS: number
  episodes: number
  /** The first frame on which the viewer saw the overlay, or null if it never came on. */
  firstOverlayFrame: number | null
  /** Flagged at the standard: the strict trigger, the WCAG area, the limit of 3. */
  standard: { original: number; protectedPane: number; wholeVideo: number }
  /** Flagged with the settings the render was made with. */
  withSettings: { original: number; protectedPane: number }
}

const COLORS = {
  background: [20, 24, 29] as Rgb,
  panel: [28, 33, 40] as Rgb,
  text: [240, 243, 246] as Rgb,
  muted: [195, 202, 210] as Rgb,
  limit: [210, 153, 34] as Rgb,
  safe: [88, 166, 255] as Rgb,
  hazard: [244, 112, 103] as Rgb
}

/** Pixels per font dot. */
const LABEL_SCALE = 4
const STATUS_SCALE = 3
const SMALL_SCALE = 2
const lineHeight = (scale: number): number => 7 * scale + 4 * scale

/** Linear light to an 8-bit sRGB code, through a table. */
const ENCODE = new Uint8Array(THUMBNAIL_LUT_SIZE + 1)
for (let i = 0; i <= THUMBNAIL_LUT_SIZE; i++) {
  ENCODE[i] = Math.round(255 * linearToSrgb(i / THUMBNAIL_LUT_SIZE))
}
function encode(linear: number): number {
  if (linear <= 0) return ENCODE[0]
  if (linear >= 1) return ENCODE[THUMBNAIL_LUT_SIZE]
  return ENCODE[(linear * THUMBNAIL_LUT_SIZE + 0.5) | 0]
}

/** One overlay picture waiting to reach the viewer. */
interface Pending {
  opacity: number
  /** Linear R, G, B per pixel: what the overlay draws. Only filled when opacity > 0. */
  picture: Float32Array
}

/** Counts the whole seconds in which a hazard was raised: by its own detector, fed with
 *  step(), or by someone else's, reported with note(). */
class FlaggedSeconds {
  private readonly seconds = new Set<number>()
  constructor(private readonly detector: Detector | null = null) {}
  step(grid: Float32Array, tMs: number): void {
    if (this.detector?.step(grid, tMs).hazard) this.note(tMs)
  }
  note(tMs: number): void {
    this.seconds.add(Math.floor(tMs / VALIDATE_SECOND_MS))
  }
  get count(): number {
    return this.seconds.size
  }
}

/** The app's words for the settings, for the picture and the report. */
export function describeSettings(settings: Settings, delayFrames: number): string[] {
  const s = settings.sensitivity
  const names = ['MOST SENSITIVE', 'STANDARD', 'FEWER FALSE ALARMS']
  const sensitivity =
    s.trigger === 'strict'
      ? 'STRICT'
      : `${names[sensitivityPosition(s)] ?? 'CUSTOM'} (${s.streakN} CHANGES)`
  return [
    `SENSITIVITY: ${sensitivity}`,
    `IGNORE MOVEMENT: ${settings.concurrency === 'one-way' ? 'ON' : 'OFF'}`,
    `KEEP MOTION SHARP: ${settings.mitigation === 'correct' ? 'ON' : 'OFF'}`,
    `OVERLAY DELAY: ${delayFrames} ${delayFrames === 1 ? 'FRAME' : 'FRAMES'}`
  ]
}

export function describeLimit(flashLimit: number): string {
  return flashLimit === DEFAULT_FLASH_LIMIT
    ? `LIMIT: ${flashLimit} (WCAG)`
    : `LIMIT: ${flashLimit} (TESTING, WCAG IS ${DEFAULT_FLASH_LIMIT})`
}

export class ClipRenderer {
  /** The rendered frame, redrawn by every frame() call. */
  readonly canvas: Canvas

  private readonly w: number
  private readonly h: number
  private readonly linear: Float32Array
  private readonly grid = new Float32Array(GRID_CELLS * 4)
  private readonly seenGrid = new Float32Array(GRID_CELLS * 4)
  private readonly wholeGrid = new Float32Array(GRID_CELLS * 4)
  private readonly grid3 = new Float32Array(GRID_CELLS * 3)
  private readonly detector: Detector
  private readonly machine = new OverlayStateMachine()
  /** 'smooth': the smoothing filter's state S, linear RGB per pixel. */
  private readonly smoothed: Float32Array | null
  /** 'correct': the per-cell targets. */
  private readonly targets: ReferenceFilter | null
  private readonly pending: Pending[]
  private readonly pane: Uint8Array
  private readonly small: Uint8Array | null

  private readonly originalStandard = new FlaggedSeconds(strictDetector())
  private readonly seenStandard = new FlaggedSeconds(strictDetector())
  private readonly wholeStandard = new FlaggedSeconds(strictDetector())
  private readonly originalSettings = new FlaggedSeconds()
  private readonly seenSettings: FlaggedSeconds

  private readonly history: Float32Array
  private readonly historyHazard: Uint8Array
  private readonly shownText = new Map<string, string>()

  private index = 0
  private alpha = ALPHA_WARM
  private overlayFrames = 0
  private episodes = 0
  private overlayWasOn = false
  private firstOverlayFrame: number | null = null

  /**
   * @param fps the constant frame rate of the frames to come
   * @param delayFrames how many frames late the overlay's picture reaches the viewer
   */
  constructor(
    private readonly layout: Layout,
    private readonly settings: Settings = DEFAULT_SETTINGS,
    private readonly fps: number,
    private readonly delayFrames: number
  ) {
    if (!(fps > 0)) throw new Error(`The frame rate must be positive, got ${fps}`)
    if (!Number.isInteger(delayFrames) || delayFrames < 0) {
      throw new Error(`The overlay delay must be a whole number of frames, got ${delayFrames}`)
    }
    const { protectedPane: pane, originalPane, shrink } = layout
    this.w = pane.w
    this.h = pane.h
    if (!Number.isInteger(this.w) || !Number.isInteger(this.h)) {
      throw new Error(
        `The protected pane must be a whole number of pixels, got ${this.w}x${this.h}`
      )
    }
    if (
      originalPane &&
      (originalPane.w * shrink !== pane.w || originalPane.h * shrink !== pane.h)
    ) {
      throw new Error('The original pane must be the protected pane divided by the shrink factor')
    }
    const pixels = this.w * this.h
    this.canvas = newCanvas(layout.width, layout.height, COLORS.background)
    this.linear = new Float32Array(pixels * 3)
    this.pane = new Uint8Array(pixels * 4).fill(255)
    this.small =
      originalPane && shrink > 1
        ? new Uint8Array(originalPane.w * originalPane.h * 4).fill(255)
        : null
    const sharp = settings.mitigation === 'correct'
    this.smoothed = sharp ? null : new Float32Array(pixels * 3)
    this.targets = sharp ? new ReferenceFilter(GRID_CELLS) : null
    this.pending = Array.from({ length: delayFrames + 1 }, () => ({
      opacity: 0,
      picture: new Float32Array(pixels * 3)
    }))
    const options = { inputChannels: 4 as const, ...detectorOptionsFor(settings) }
    this.detector = new Detector(options)
    this.seenSettings = new FlaggedSeconds(new Detector(options))
    const samples = Math.max(2, Math.round((RENDER_GRAPH_WINDOW_MS * fps) / 1000))
    this.history = new Float32Array(samples)
    this.historyHazard = new Uint8Array(samples)
    this.drawStaticText()
  }

  /**
   * One frame of the clip.
   * @param rgba sRGB RGBA8 at the protected pane's size, row 0 at the top
   * @returns the rendered frame, sRGB RGBA8 at the layout's size. The buffer is reused.
   */
  frame(rgba: Uint8Array): Uint8Array {
    const { w, h, linear, grid } = this
    const pixels = w * h
    if (rgba.length < pixels * 4) throw new Error(`Expected a ${w}x${h} RGBA frame`)
    const n = this.index++
    const tMs = (n * 1000) / this.fps

    for (let p = 0, q = 0; q < pixels * 3; p += 4, q += 3) {
      linear[q] = SRGB8_TO_LINEAR[rgba[p]]
      linear[q + 1] = SRGB8_TO_LINEAR[rgba[p + 1]]
      linear[q + 2] = SRGB8_TO_LINEAR[rgba[p + 2]]
    }
    averageToGrid(rgba, w, h, grid)

    // The filter step, with the strength decided on the frame before (the app's Pass B).
    const alpha = n === 0 ? 1 : this.alpha
    if (this.smoothed) {
      const s = this.smoothed
      for (let i = 0; i < s.length; i++) s[i] += alpha * (linear[i] - s[i])
    } else if (this.targets) {
      const g3 = this.grid3
      for (let c = 0, a = 0, b = 0; c < GRID_CELLS; c++, a += 4, b += 3) {
        g3[b] = grid[a]
        g3[b + 1] = grid[a + 1]
        g3[b + 2] = grid[a + 2]
      }
      this.targets.step(g3, alpha)
    }

    const d = this.detector.step(grid, tMs)
    const out = this.machine.step(tMs, d, this.fps)
    this.alpha = out.alpha
    if (d.hazard) this.originalSettings.note(tMs)
    this.originalStandard.step(grid, tMs)

    // What the overlay draws for this frame (the app's Pass C), queued for the viewer.
    const now = this.pending[n % this.pending.length]
    now.opacity = out.opacity
    if (out.opacity > 0) this.drawOverlay(now.picture, out.dim, out.red)

    // What the viewer sees: the overlay drawn `delayFrames` ago, over the screen as it is now.
    const shown =
      n >= this.delayFrames ? this.pending[(n - this.delayFrames) % this.pending.length] : null
    const opacity = shown ? shown.opacity : 0
    this.drawPane(rgba, shown ? shown.picture : null, opacity)
    const on = opacity > 0
    if (on) {
      this.overlayFrames++
      if (!this.overlayWasOn) this.episodes++
      if (this.firstOverlayFrame === null) this.firstOverlayFrame = n
    }
    this.overlayWasOn = on

    averageToGrid(this.pane, w, h, this.seenGrid)
    this.seenStandard.step(this.seenGrid, tMs)
    this.seenSettings.step(this.seenGrid, tMs)

    this.compose(rgba, n, d.graphValue, d.hazard, on)
    averageToGrid(this.canvas.data, this.canvas.width, this.canvas.height, this.wholeGrid)
    this.wholeStandard.step(this.wholeGrid, tMs)
    return this.canvas.data
  }

  summary(): RenderSummary {
    return {
      frames: this.index,
      durationS: this.index / this.fps,
      overlayS: this.overlayFrames / this.fps,
      episodes: this.episodes,
      firstOverlayFrame: this.firstOverlayFrame,
      standard: {
        original: this.originalStandard.count,
        protectedPane: this.seenStandard.count,
        wholeVideo: this.wholeStandard.count
      },
      withSettings: {
        original: this.originalSettings.count,
        protectedPane: this.seenSettings.count
      }
    }
  }

  /** d times the calmed picture, desaturated for a red hazard, in linear light. */
  private drawOverlay(picture: Float32Array, dim: number, red: boolean): void {
    if (this.smoothed) picture.set(this.smoothed)
    else if (this.targets) {
      correctImage(
        this.linear,
        this.w,
        this.h,
        this.grid,
        4,
        this.targets.state,
        GRID_COLS,
        GRID_ROWS,
        picture
      )
    }
    if (dim === 1 && !red) return
    for (let q = 0; q < picture.length; q += 3) {
      let r = dim * picture[q]
      let g = dim * picture[q + 1]
      let b = dim * picture[q + 2]
      if (red) {
        const y = LUMA_R * r + LUMA_G * g + LUMA_B * b
        r += RED_DESATURATION * (y - r)
        g += RED_DESATURATION * (y - g)
        b += RED_DESATURATION * (y - b)
      }
      picture[q] = r
      picture[q + 1] = g
      picture[q + 2] = b
    }
  }

  /** The protected pane: the overlay's picture at its opacity over the current frame. */
  private drawPane(rgba: Uint8Array, picture: Float32Array | null, opacity: number): void {
    const pane = this.pane
    if (picture === null || opacity <= 0) {
      pane.set(rgba.subarray(0, pane.length))
      return
    }
    const linear = this.linear
    const keep = 1 - opacity
    for (let p = 0, q = 0; q < linear.length; p += 4, q += 3) {
      pane[p] = encode(opacity * picture[q] + keep * linear[q])
      pane[p + 1] = encode(opacity * picture[q + 1] + keep * linear[q + 1])
      pane[p + 2] = encode(opacity * picture[q + 2] + keep * linear[q + 2])
      pane[p + 3] = 255
    }
  }

  private compose(
    rgba: Uint8Array,
    n: number,
    graphValue: number,
    hazard: boolean,
    on: boolean
  ): void {
    const { layout, canvas, w, h } = this
    blit(canvas, this.pane, w, h, layout.protectedPane.x, layout.protectedPane.y)
    const original = layout.originalPane
    if (original) {
      if (this.small) {
        this.shrinkOriginal(this.small, original.w, original.h, layout.shrink)
        blit(canvas, this.small, original.w, original.h, original.x, original.y)
      } else {
        blit(canvas, rgba, w, h, original.x, original.y)
      }
    }
    const slot = n % this.history.length
    this.history[slot] = graphValue
    this.historyHazard[slot] = hazard ? 1 : 0
    const text = layout.text
    if (!text) return
    const step = lineHeight(STATUS_SCALE)
    this.line('status', `STATUS: ${on ? 'SMOOTHING' : 'PROTECTED'}`, text.status.x, text.status.y)
    this.line(
      'rate',
      `FLASHES PER SECOND: ${graphValue.toFixed(1)}`,
      text.status.x,
      text.status.y + step
    )
    this.drawGraph(text.graph, n)
  }

  /** The original frame, averaged down in linear light. */
  private shrinkOriginal(out: Uint8Array, ow: number, oh: number, k: number): void {
    const linear = this.linear
    const w = this.w
    const scale = 1 / (k * k)
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        let r = 0
        let g = 0
        let b = 0
        for (let dy = 0; dy < k; dy++) {
          let q = ((y * k + dy) * w + x * k) * 3
          for (let dx = 0; dx < k; dx++, q += 3) {
            r += linear[q]
            g += linear[q + 1]
            b += linear[q + 2]
          }
        }
        const p = (y * ow + x) * 4
        out[p] = encode(r * scale)
        out[p + 1] = encode(g * scale)
        out[p + 2] = encode(b * scale)
      }
    }
  }

  /** A line of status text, redrawn only when its words change. */
  private line(key: string, words: string, x: number, y: number): void {
    if (this.shownText.get(key) === words) return
    const previous = this.shownText.get(key) ?? ''
    const columns = Math.max(previous.length, words.length) * 6 * STATUS_SCALE
    fillRect(this.canvas, x, y, columns, 7 * STATUS_SCALE, COLORS.background)
    drawText(this.canvas, words, x, y, STATUS_SCALE, COLORS.text)
    this.shownText.set(key, words)
  }

  /** Flashes per second over the last RENDER_GRAPH_WINDOW_MS, newest at the right, with the
   *  limit line. Bars, in the dashboard's muted colours, so nothing in it can flash. */
  private drawGraph(box: Rect, n: number): void {
    const canvas = this.canvas
    const limit = this.settings.flashLimit
    fillRect(canvas, box.x, box.y, box.w, box.h, COLORS.panel)
    const samples = this.history.length
    let top = Math.max(DASHBOARD_GRAPH_MIN_Y_MAX, limit + 1)
    for (let i = 0; i < samples; i++) if (this.history[i] > top) top = this.history[i]
    const filled = Math.min(n + 1, samples)
    for (let x = 0; x < box.w; x++) {
      // Column x shows the sample this far back from the newest.
      const back = Math.floor(((box.w - 1 - x) * samples) / box.w)
      if (back >= filled) continue
      const slot = (((n - back) % samples) + samples) % samples
      const value = this.history[slot]
      if (value <= 0) continue
      const bar = Math.max(1, Math.round((value / top) * (box.h - 2)))
      fillRect(
        canvas,
        box.x + x,
        box.y + box.h - 1 - bar,
        1,
        bar,
        this.historyHazard[slot] ? COLORS.hazard : COLORS.safe
      )
    }
    const limitY = box.y + box.h - 1 - Math.round((limit / top) * (box.h - 2))
    for (let x = 0; x < box.w; x += 12) fillRect(canvas, box.x + x, limitY, 7, 2, COLORS.limit)
  }

  private drawStaticText(): void {
    const { layout, canvas } = this
    const text = layout.text
    if (!text) return
    drawText(
      canvas,
      'WITH CALMFRAME',
      layout.protectedPane.x + 20,
      text.labelY,
      LABEL_SCALE,
      COLORS.text
    )
    if (layout.originalPane) {
      drawText(
        canvas,
        'ORIGINAL (UNPROTECTED)',
        layout.originalPane.x + 20,
        text.labelY,
        LABEL_SCALE,
        COLORS.muted
      )
    }
    drawText(
      canvas,
      describeLimit(this.settings.flashLimit),
      text.status.x,
      text.status.y + 2 * lineHeight(STATUS_SCALE),
      STATUS_SCALE,
      COLORS.text
    )
    describeSettings(this.settings, this.delayFrames).forEach((words, i) => {
      drawText(
        canvas,
        words,
        text.settings.x,
        text.settings.y + i * lineHeight(SMALL_SCALE),
        SMALL_SCALE,
        COLORS.muted
      )
    })
    const footer = [
      "RENDERED OFFLINE WITH CALMFRAME'S OWN DETECTION AND FILTER CODE. NOT A RECORDING OF THE LIVE OVERLAY.",
      'THE FIRST FLASH OR TWO OF EACH BURST GETS THROUGH, AS IN THE APP.'
    ]
    footer.forEach((words, i) => {
      drawText(
        canvas,
        words,
        text.footer.x,
        text.footer.y + i * lineHeight(SMALL_SCALE),
        SMALL_SCALE,
        COLORS.muted
      )
    })
  }
}

/** The standard the report measures against: the strict trigger, the WCAG area, the limit
 *  of 3, with the movement rule on as in the app. */
function strictDetector(): Detector {
  return new Detector({ inputChannels: 4, trigger: 'strict' })
}
