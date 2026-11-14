/**
 * Startup proof that Passes B and C keep the picture in linear light and hand it back
 * unchanged when nothing is flashing ("Three implementation requirements").
 *
 * 1. Round trip. A generated image is seeded into the half-float state and drawn at d = 1
 *    and opacity 1. It must come back as the same 8-bit codes, the right way up. A pass
 *    that kept 8-bit state, re-encoded wrongly or forgot the row flip would not.
 * 2. One step. A second image is folded in at a test alpha, then drawn with a test dim,
 *    the red desaturation and a test opacity. The result must match the CPU twin
 *    (the ReferenceFilter arithmetic and linearToSrgb) code for code.
 *
 * Everything is drawn into an offscreen 8-bit target, never the overlay canvas, so nothing
 * appears on screen.
 */

import {
  RED_DESATURATION,
  SMOOTH_SELF_TEST_ALPHA,
  SMOOTH_SELF_TEST_DIM,
  SMOOTH_SELF_TEST_HEIGHT,
  SMOOTH_SELF_TEST_OPACITY,
  SMOOTH_SELF_TEST_TOLERANCE,
  SMOOTH_SELF_TEST_WIDTH
} from '../shared/config'
import type { SmoothSelfTestResult } from '../shared/messages'
import { linearToSrgb, relativeLuminance, SRGB8_TO_LINEAR } from '../core/luminance'
import type { GridPass } from './gridPass'
import type { SmoothPass } from './smoothPass'

const W = SMOOTH_SELF_TEST_WIDTH
const H = SMOOTH_SELF_TEST_HEIGHT

/** Every code across in R, its mirror in G, and a blue that differs per row. */
function imageA(): Uint8Array {
  const px = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4
      px[p] = x & 255
      px[p + 1] = 255 - (x & 255)
      px[p + 2] = (x + 37 * y) & 255
      px[p + 3] = 255
    }
  }
  return px
}

function imageB(): Uint8Array {
  const px = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4
      px[p] = 255 - (x & 255)
      px[p + 1] = (3 * x + 11 * y) & 255
      px[p + 2] = x & 255
      px[p + 3] = 255
    }
  }
  return px
}

/** Largest difference in 8-bit codes between expected image rows and the read-back,
 *  whose row r is image row H - 1 - r (a framebuffer's row 0 is its bottom). */
function maxDiff(expected: Uint8Array | Float64Array, readBack: Uint8Array): number {
  let worst = 0
  for (let r = 0; r < H; r++) {
    const y = H - 1 - r
    for (let i = 0; i < W * 4; i++) {
      worst = Math.max(worst, Math.abs(readBack[r * W * 4 + i] - expected[y * W * 4 + i]))
    }
  }
  return worst
}

export function runSmoothSelfTest(
  gl: WebGL2RenderingContext,
  grid: GridPass,
  smooth: SmoothPass
): SmoothSelfTestResult {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  const readBack = new Uint8Array(W * H * 4)
  const read = (): Uint8Array => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, readBack)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return readBack
  }

  try {
    // 1. Seed and draw back unchanged.
    const a = imageA()
    grid.uploadPixels(a, W, H)
    smooth.reset()
    smooth.update(W, H, 1)
    smooth.draw(1, 1, 0, framebuffer)
    const roundTripMaxDiff = maxDiff(a, read())

    // 2. One filter step, then dim, desaturation and opacity, against the CPU twin.
    const b = imageB()
    grid.uploadPixels(b, W, H)
    smooth.update(W, H, SMOOTH_SELF_TEST_ALPHA)
    smooth.draw(SMOOTH_SELF_TEST_DIM, SMOOTH_SELF_TEST_OPACITY, RED_DESATURATION, framebuffer)
    const expected = new Float64Array(W * H * 4)
    const o = SMOOTH_SELF_TEST_OPACITY
    for (let p = 0; p < W * H * 4; p += 4) {
      const lin = [0, 1, 2].map((c) => {
        const s0 = SRGB8_TO_LINEAR[a[p + c]]
        const s = s0 + SMOOTH_SELF_TEST_ALPHA * (SRGB8_TO_LINEAR[b[p + c]] - s0)
        return SMOOTH_SELF_TEST_DIM * s
      })
      const grey = relativeLuminance(lin[0], lin[1], lin[2])
      for (let c = 0; c < 3; c++) {
        const l = Math.min(1, Math.max(0, lin[c] + RED_DESATURATION * (grey - lin[c])))
        expected[p + c] = 255 * linearToSrgb(l) * o
      }
      expected[p + 3] = 255 * o
    }
    const stepMaxDiff = maxDiff(expected, read())

    const pass =
      roundTripMaxDiff <= SMOOTH_SELF_TEST_TOLERANCE && stepMaxDiff <= SMOOTH_SELF_TEST_TOLERANCE
    const detail =
      `round trip through the half-float state: max ${roundTripMaxDiff} codes; ` +
      `one step (alpha ${SMOOTH_SELF_TEST_ALPHA}, d ${SMOOTH_SELF_TEST_DIM}, red desaturation, ` +
      `opacity ${SMOOTH_SELF_TEST_OPACITY}) vs CPU: max ${stepMaxDiff.toFixed(2)} codes ` +
      `(limit ${SMOOTH_SELF_TEST_TOLERANCE})`
    return { pass, roundTripMaxDiff, stepMaxDiff, detail }
  } finally {
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(texture)
    // The live stream seeds the state from its own first frame.
    smooth.reset()
  }
}
