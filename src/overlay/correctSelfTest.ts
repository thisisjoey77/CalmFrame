/**
 * Startup check of the experimental correction pass against its CPU twin
 * (src/core/regionCorrect.ts). docs/SPEC.md, "Stretch: correct brightness per region".
 *
 * Two generated images go through the pass as two frames would: the first seeds the
 * targets, the second is folded in at a test alpha and then drawn with a test dim, the red
 * desaturation and a test opacity. The result must match the CPU arithmetic code for code.
 * The CPU side starts from the grids the GPU read back, since Pass A has its own self-test,
 * so this checks only the new pass: the targets, the interpolation between cells, the two
 * scalings, the row flip and the re-encoding.
 *
 * Everything is drawn into an offscreen 8-bit target, never the overlay canvas. A failure
 * does not fail the pipeline: "Keep motion sharp" then falls back to the smoothing filter.
 */

import {
  CORRECT_SELF_TEST_HEIGHT,
  CORRECT_SELF_TEST_TOLERANCE,
  CORRECT_SELF_TEST_WIDTH,
  GRID_CELLS,
  GRID_COLS,
  GRID_ROWS,
  RED_DESATURATION,
  SMOOTH_SELF_TEST_ALPHA,
  SMOOTH_SELF_TEST_DIM,
  SMOOTH_SELF_TEST_OPACITY
} from '../shared/config'
import type { CorrectSelfTestResult } from '../shared/messages'
import { linearToSrgb, relativeLuminance, SRGB8_TO_LINEAR } from '../core/luminance'
import { correctImage } from '../core/regionCorrect'
import type { CorrectPass } from './correctPass'
import type { GridPass } from './gridPass'

const W = CORRECT_SELF_TEST_WIDTH
const H = CORRECT_SELF_TEST_HEIGHT

/**
 * A picture with broad shapes, so neighbouring regions have different means, and detail
 * finer than a cell. Every channel stays between 24 and 231, so no region is all black or
 * all white. `shift` moves the shapes and `gain` changes the brightness between the two
 * test frames, so regions end up both above and below their targets.
 */
function image(shift: number, gain: number): Uint8Array {
  const px = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4
      const broad = 0.5 + 0.5 * Math.sin((x + shift) / 23) * Math.cos((y - shift) / 17)
      const fine = (x + 2 * y) % 3 === 0 ? 0.25 : 0
      const v = Math.min(1, gain * (0.15 + 0.6 * broad + fine))
      px[p] = 24 + Math.round(207 * v)
      px[p + 1] = 24 + Math.round(207 * Math.min(1, gain * (0.2 + 0.7 * (1 - broad))))
      px[p + 2] = 24 + Math.round(207 * (((x >> 3) + (y >> 3)) % 2 ? v : 1 - v))
      px[p + 3] = 255
    }
  }
  return px
}

export function runCorrectSelfTest(
  gl: WebGL2RenderingContext,
  grid: GridPass,
  correct: CorrectPass
): CorrectSelfTestResult {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  try {
    // Frame 1 seeds the targets with its own grid.
    const a = image(0, 0.7)
    grid.uploadPixels(a, W, H)
    const gridA = Float32Array.from(grid.run())
    correct.reset()
    correct.update(1)

    // Frame 2: one filter step on the targets, then the corrected picture.
    const b = image(40, 1.2)
    grid.uploadPixels(b, W, H)
    const gridB = Float32Array.from(grid.run())
    correct.update(SMOOTH_SELF_TEST_ALPHA)
    correct.draw(
      W,
      H,
      SMOOTH_SELF_TEST_DIM,
      SMOOTH_SELF_TEST_OPACITY,
      RED_DESATURATION,
      framebuffer
    )
    const readBack = new Uint8Array(W * H * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, readBack)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // The CPU twin, from the same two grids.
    const targets = new Float64Array(GRID_CELLS * 3)
    for (let c = 0; c < GRID_CELLS; c++) {
      for (let ch = 0; ch < 3; ch++) {
        const t0 = gridA[c * 4 + ch]
        targets[c * 3 + ch] = t0 + SMOOTH_SELF_TEST_ALPHA * (gridB[c * 4 + ch] - t0)
      }
    }
    const linear = new Float64Array(W * H * 3)
    for (let p = 0, q = 0; p < W * H * 4; p += 4, q += 3) {
      linear[q] = SRGB8_TO_LINEAR[b[p]]
      linear[q + 1] = SRGB8_TO_LINEAR[b[p + 1]]
      linear[q + 2] = SRGB8_TO_LINEAR[b[p + 2]]
    }
    correctImage(linear, W, H, gridB, 4, targets, GRID_COLS, GRID_ROWS, linear)

    // Read-back row r is image row H - 1 - r (a framebuffer's row 0 is its bottom).
    const o = SMOOTH_SELF_TEST_OPACITY
    let maxDiff = 0
    for (let y = 0; y < H; y++) {
      const r = H - 1 - y
      for (let x = 0; x < W; x++) {
        const q = (y * W + x) * 3
        const got = (r * W + x) * 4
        const lin = [0, 1, 2].map((ch) => SMOOTH_SELF_TEST_DIM * linear[q + ch])
        const grey = relativeLuminance(lin[0], lin[1], lin[2])
        for (let ch = 0; ch < 3; ch++) {
          const l = Math.min(1, Math.max(0, lin[ch] + RED_DESATURATION * (grey - lin[ch])))
          maxDiff = Math.max(maxDiff, Math.abs(readBack[got + ch] - 255 * linearToSrgb(l) * o))
        }
        maxDiff = Math.max(maxDiff, Math.abs(readBack[got + 3] - 255 * o))
      }
    }

    const pass = maxDiff <= CORRECT_SELF_TEST_TOLERANCE
    const detail =
      `correction pass, one step (alpha ${SMOOTH_SELF_TEST_ALPHA}, d ${SMOOTH_SELF_TEST_DIM}, ` +
      `red desaturation, opacity ${o}) on a ${W}x${H} image vs CPU: max ${maxDiff.toFixed(2)} ` +
      `codes (limit ${CORRECT_SELF_TEST_TOLERANCE})`
    return { pass, maxDiff, detail }
  } finally {
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(texture)
    // The live stream seeds the targets from its own first frame.
    correct.reset()
  }
}
