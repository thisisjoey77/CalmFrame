/**
 * The synthetic test clips (docs/SPEC.md, "Validation and measurement", "Test clips"):
 * 10-second 1080p60 files with a 3-second steady lead-in, so the ground truth is known by
 * construction. Each clip is described frame by frame as a background colour and an
 * optional rectangle, which make-clips paints and pipes to ffmpeg.
 *
 * A 60 fps file can only hold strobes whose half-cycle is a whole number of frames, 30/n Hz
 * (Step 7): 3.75 Hz is 8 frames, 10 Hz is 3 and 15 Hz is 2. The 2 Hz clip is 15 frames.
 */

import { linearToSrgb, srgbToLinear } from '../../src/core/luminance'
import {
  VALIDATE_CLIP_FPS,
  VALIDATE_CLIP_HEIGHT,
  VALIDATE_CLIP_LEAD_IN_MS,
  VALIDATE_CLIP_MS,
  VALIDATE_CLIP_WIDTH
} from '../../src/shared/config'

export type Rgb = readonly [number, number, number]

/** A rectangle in fractions of the frame, centred. */
export interface Patch {
  /** Share of the frame's area it covers, with the frame's aspect ratio. */
  area: number
  color: Rgb
}

/** One frame: a background and an optional centred patch. */
export interface FrameImage {
  background: Rgb
  patch?: Patch
}

/** What the spec's table expects, clip by clip. */
export interface Expected {
  /** WCAG area mode: 'safe', or the hazard type. */
  wcag: 'safe' | 'luminance' | 'red'
  /** IRIS-compatible area mode with the extended-failure rule: fail if any second fails. */
  iris: 'pass' | 'fail'
  /** The spec's IRIS column, word for word. */
  irisNote: string
}

export interface ClipSpec {
  id: string
  /** The spec's row title. */
  title: string
  frame(index: number): FrameImage
  expected: Expected
}

export const BLACK: Rgb = [0, 0, 0]
export const WHITE: Rgb = [255, 255, 255]
export const RED: Rgb = [255, 0, 0]

const grey = (code: number): Rgb => [code, code, code]

/** The 8-bit sRGB grey whose relative luminance is closest to y. */
export function greyForLuminance(y: number): number {
  return Math.round(255 * linearToSrgb(y))
}

/** Relative luminance of an 8-bit sRGB grey. */
export const greyLuminance = (code: number): number => srgbToLinear(code / 255)

/** The strobe page's default greys (Phase 2): sRGB 89 and 149, a 0.2 swing. */
export const LOW_GREY = 89
export const SWING_02_HIGH = 149
/** A 0.05 swing above the same low grey. */
export const SWING_005_HIGH = greyForLuminance(greyLuminance(LOW_GREY) + 0.05)

const FPS = VALIDATE_CLIP_FPS
const LEAD_IN_FRAMES = Math.round((VALIDATE_CLIP_LEAD_IN_MS * FPS) / 1000)

/** Frames per half-cycle of a strobe at f Hz in a FPS file; throws unless whole. */
export function halfCycleFrames(frequencyHz: number, fps = FPS): number {
  const n = fps / (2 * frequencyHz)
  if (!Number.isInteger(n)) throw new Error(`${frequencyHz} Hz is not 30/n Hz at ${fps} fps`)
  return n
}

/** A square strobe that starts high on the first frame after the lead-in. */
function strobe(frequencyHz: number, low: FrameImage, high: FrameImage): (i: number) => FrameImage {
  const half = halfCycleFrames(frequencyHz)
  return (i) => {
    if (i < LEAD_IN_FRAMES) return low
    return Math.floor((i - LEAD_IN_FRAMES) / half) % 2 === 0 ? high : low
  }
}

const full = (c: Rgb): FrameImage => ({ background: c })
const patch = (area: number, c: Rgb): FrameImage => ({
  background: BLACK,
  patch: { area, color: c }
})

export const CLIPS: readonly ClipSpec[] = [
  {
    id: 'flash-2hz-full',
    title: '2 Hz full-screen black and white',
    frame: strobe(2, full(BLACK), full(WHITE)),
    expected: {
      wcag: 'safe',
      iris: 'fail',
      irisNote: 'Warning, then extended failure after 4 s'
    }
  },
  {
    id: 'flash-3.75hz-full',
    title: '3.75 Hz full-screen',
    frame: strobe(3.75, full(BLACK), full(WHITE)),
    expected: { wcag: 'luminance', iris: 'fail', irisNote: 'Fail' }
  },
  {
    id: 'flash-10hz-full',
    title: '10 Hz full-screen',
    frame: strobe(10, full(BLACK), full(WHITE)),
    expected: { wcag: 'luminance', iris: 'fail', irisNote: 'Fail' }
  },
  {
    id: 'flash-15hz-full',
    title: '15 Hz full-screen',
    frame: strobe(15, full(BLACK), full(WHITE)),
    expected: { wcag: 'luminance', iris: 'fail', irisNote: 'Fail' }
  },
  {
    id: 'flash-10hz-swing-0.05',
    title: '10 Hz, swing 0.05',
    frame: strobe(10, full(grey(LOW_GREY)), full(grey(SWING_005_HIGH))),
    expected: { wcag: 'safe', iris: 'pass', irisNote: 'Pass' }
  },
  {
    id: 'flash-10hz-swing-0.2',
    title: '10 Hz, swing 0.2 between two greys',
    frame: strobe(10, full(grey(LOW_GREY)), full(grey(SWING_02_HIGH))),
    expected: { wcag: 'luminance', iris: 'fail', irisNote: 'Fail' }
  },
  {
    id: 'flash-10hz-patch-15',
    title: '10 Hz in a patch covering 15% of the frame',
    frame: strobe(10, patch(0.15, BLACK), patch(0.15, WHITE)),
    expected: { wcag: 'luminance', iris: 'pass', irisNote: 'Pass' }
  },
  {
    id: 'flash-10hz-patch-30',
    title: '10 Hz in a patch covering 30% of the frame',
    frame: strobe(10, patch(0.3, BLACK), patch(0.3, WHITE)),
    expected: { wcag: 'luminance', iris: 'fail', irisNote: 'Fail' }
  },
  {
    id: 'flash-10hz-red',
    title: '10 Hz red and black',
    frame: strobe(10, full(BLACK), full(RED)),
    expected: { wcag: 'red', iris: 'fail', irisNote: 'Red fail and luminance fail' }
  },
  {
    id: 'cuts-every-2s',
    title: 'Hard cuts every 2 s',
    // Black for the lead-in, then a cut to white, back to black, and so on, every 2 s.
    frame: (i) =>
      i < LEAD_IN_FRAMES
        ? full(BLACK)
        : Math.floor((i - LEAD_IN_FRAMES) / (2 * FPS)) % 2 === 0
          ? full(WHITE)
          : full(BLACK),
    expected: { wcag: 'safe', iris: 'pass', irisNote: 'Pass' }
  },
  {
    id: 'fade-2s-cycle',
    title: 'Slow fade, one cycle per 2 s',
    // Black to white and back, a raised cosine in sRGB, continuous with the black lead-in.
    frame: (i) => {
      if (i < LEAD_IN_FRAMES) return full(BLACK)
      const t = (i - LEAD_IN_FRAMES) / FPS
      return full(grey(Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * t)))))
    },
    expected: { wcag: 'safe', iris: 'pass', irisNote: 'Pass' }
  }
]

export const CLIP_FRAMES = Math.round((VALIDATE_CLIP_MS * FPS) / 1000)
export const CLIP_SIZE = { width: VALIDATE_CLIP_WIDTH, height: VALIDATE_CLIP_HEIGHT }

/** The patch's rectangle in pixels: centred, the frame's aspect ratio, `area` of it. */
export function patchRect(
  area: number,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  const k = Math.sqrt(area)
  const w = Math.round(width * k)
  const h = Math.round(height * k)
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h }
}

/** Paint a frame as packed RGB24 (3 bytes per pixel, row 0 at the top). */
export function paintRgb24(
  image: FrameImage,
  width: number,
  height: number,
  out: Uint8Array
): void {
  const [r, g, b] = image.background
  for (let p = 0; p < width * height * 3; p += 3) {
    out[p] = r
    out[p + 1] = g
    out[p + 2] = b
  }
  if (!image.patch) return
  const { x, y, w, h } = patchRect(image.patch.area, width, height)
  const [pr, pg, pb] = image.patch.color
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const p = (row * width + col) * 3
      out[p] = pr
      out[p + 1] = pg
      out[p + 2] = pb
    }
  }
}
