import {
  SELF_CHECK_BLACK_FRACTION,
  SELF_CHECK_BLACK_LEVEL,
  SELF_CHECK_CANVAS_HEIGHT,
  SELF_CHECK_CANVAS_WIDTH,
  SELF_CHECK_CLEAN_DELTA,
  SELF_CHECK_CYCLES,
  SELF_CHECK_LEAK_DELTA,
  SELF_CHECK_SAMPLE_INTERVAL_MS,
  SELF_CHECK_SAMPLES,
  SELF_CHECK_SETTLE_MS
} from '../shared/config'
import type { ColorSample, SelfCheckResult } from '../shared/messages'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Capture-leak self-check for Phase 0. Toggles the overlay's own tint off and on and
 * compares the captured frame's average colour. If the overlay is excluded from
 * capture, the captured colour doesn't change. If it leaks, the red ratio jumps.
 * If it shows as a black rectangle, the capture is near black.
 */
export async function runSelfCheck(
  /** Draw the latest captured frame scaled into the 2D context. */
  drawFrame: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  setTint: (on: boolean) => void,
  tintAfter: boolean
): Promise<SelfCheckResult> {
  const canvas = document.createElement('canvas')
  canvas.width = SELF_CHECK_CANVAS_WIDTH
  canvas.height = SELF_CHECK_CANVAS_HEIGHT
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { verdict: 'error', cycles: [], detail: 'no 2D canvas context' }

  const sampleOnce = (): { r: number; g: number; b: number; black: number } => {
    drawFrame(ctx, canvas.width, canvas.height)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let r = 0
    let g = 0
    let b = 0
    let black = 0
    const pixels = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      if (
        data[i] <= SELF_CHECK_BLACK_LEVEL &&
        data[i + 1] <= SELF_CHECK_BLACK_LEVEL &&
        data[i + 2] <= SELF_CHECK_BLACK_LEVEL
      ) {
        black++
      }
    }
    return { r: r / pixels, g: g / pixels, b: b / pixels, black: black / pixels }
  }

  const sample = async (): Promise<ColorSample> => {
    let r = 0
    let g = 0
    let b = 0
    let black = 0
    for (let i = 0; i < SELF_CHECK_SAMPLES; i++) {
      const s = sampleOnce()
      r += s.r
      g += s.g
      b += s.b
      black += s.black
      await wait(SELF_CHECK_SAMPLE_INTERVAL_MS)
    }
    const n = SELF_CHECK_SAMPLES
    const sum = r / n + g / n + b / n
    return {
      r: r / n,
      g: g / n,
      b: b / n,
      redRatio: sum > 0 ? r / n / sum : 0,
      blackFraction: black / n
    }
  }

  const cycles: SelfCheckResult['cycles'] = []
  try {
    for (let i = 0; i < SELF_CHECK_CYCLES; i++) {
      setTint(false)
      await wait(SELF_CHECK_SETTLE_MS)
      const hidden = await sample()
      setTint(true)
      await wait(SELF_CHECK_SETTLE_MS)
      const shown = await sample()
      cycles.push({ hidden, shown })
    }
  } finally {
    setTint(tintAfter)
  }
  return judge(cycles)
}

function judge(cycles: SelfCheckResult['cycles']): SelfCheckResult {
  const deltas = cycles.map((c) => c.shown.redRatio - c.hidden.redRatio)
  const meanDelta = deltas.reduce((a, d) => a + d, 0) / deltas.length
  const deltaText = `red-ratio change with tint on: ${deltas.map((d) => d.toFixed(3)).join(', ')}`

  if (cycles.every((c) => c.shown.blackFraction >= SELF_CHECK_BLACK_FRACTION)) {
    return {
      verdict: 'black',
      cycles,
      detail:
        'capture is almost entirely black while the overlay is up: either the overlay shows as a black rectangle, or the screen really is black'
    }
  }
  if (deltas.every((d) => d >= SELF_CHECK_LEAK_DELTA)) {
    return {
      verdict: 'tint-leak',
      cycles,
      detail: `the overlay's red tint appears in the capture (${deltaText})`
    }
  }
  if (deltas.every((d) => Math.abs(d) < SELF_CHECK_CLEAN_DELTA)) {
    return {
      verdict: 'pass',
      cycles,
      detail: `capture unchanged when the tint toggles, so the overlay is excluded (${deltaText})`
    }
  }
  return {
    verdict: 'inconclusive',
    cycles,
    detail: `screen content changed during the check; pause any video and rerun (${deltaText}, mean ${meanDelta.toFixed(3)})`
  }
}
