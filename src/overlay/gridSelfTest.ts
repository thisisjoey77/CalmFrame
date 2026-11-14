/**
 * Startup proof that Pass A is a true area average in linear light.
 * docs/SPEC.md, Step 2 acceptance test, run on generated textures (Phase 0 found
 * Chromium already shrinks real captures in gamma space, so the live screen can't test it).
 *
 * 1. A 1-pixel black and white checkerboard must read Y = 0.5 in every cell, at sizes with
 *    whole and fractional pixels per cell. Point sampling or gamma averaging reads 0.21.
 * 2. Noise at a fractional size must match the CPU twin (src/core/gridAverage.ts) cell for
 *    cell. A checkerboard can't catch a pass that averages only part of each cell, since
 *    any even block of it averages to 0.5; noise can. This also checks row orientation.
 */

import {
  CHECKERBOARD_Y,
  GRID_CELLS,
  GRID_SELF_TEST_CHECKER_TOLERANCE,
  GRID_SELF_TEST_MAX_DIFF,
  GRID_SELF_TEST_NOISE_SIZE,
  GRID_SELF_TEST_SIZES
} from '../shared/config'
import type { GridSelfTestResult } from '../shared/messages'
import { averageToGrid } from '../core/gridAverage'
import { relativeLuminance, srgbToLinear } from '../core/luminance'
import type { GridPass } from './gridPass'

function checkerboard(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (x + y) % 2 === 0 ? 0 : 255
      const p = (y * width + x) * 4
      px[p] = v
      px[p + 1] = v
      px[p + 2] = v
      px[p + 3] = 255
    }
  }
  return px
}

/** Deterministic colour noise, so a failure reproduces. */
function noise(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4)
  let seed = 0x2545f491
  for (let i = 0; i < px.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    px[i] = (i & 3) === 3 ? 255 : seed >>> 24
  }
  return px
}

export function runGridSelfTest(pass: GridPass): GridSelfTestResult {
  const checkerboards = GRID_SELF_TEST_SIZES.map(({ width, height }) => {
    pass.uploadPixels(checkerboard(width, height), width, height)
    const grid = pass.run()
    let minY = Infinity
    let maxY = -Infinity
    let sum = 0
    for (let c = 0; c < GRID_CELLS; c++) {
      const y = relativeLuminance(grid[c * 4], grid[c * 4 + 1], grid[c * 4 + 2])
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      sum += y
    }
    return { width, height, minY, maxY, meanY: sum / GRID_CELLS }
  })

  const { width, height } = GRID_SELF_TEST_NOISE_SIZE
  const px = noise(width, height)
  pass.uploadPixels(px, width, height)
  const gpu = pass.run()
  const cpu = averageToGrid(px, width, height, new Float32Array(GRID_CELLS * 4))
  let noiseMaxDiff = 0
  for (let i = 0; i < GRID_CELLS * 4; i++) {
    noiseMaxDiff = Math.max(noiseMaxDiff, Math.abs(gpu[i] - cpu[i]))
  }

  const checkerOk = checkerboards.every(
    (c) =>
      Math.abs(c.minY - CHECKERBOARD_Y) <= GRID_SELF_TEST_CHECKER_TOLERANCE &&
      Math.abs(c.maxY - CHECKERBOARD_Y) <= GRID_SELF_TEST_CHECKER_TOLERANCE
  )
  const noiseOk = noiseMaxDiff <= GRID_SELF_TEST_MAX_DIFF
  const pass_ = checkerOk && noiseOk
  const sizes = checkerboards
    .map((c) => `${c.width}x${c.height} Y ${c.minY.toFixed(4)} to ${c.maxY.toFixed(4)}`)
    .join('; ')
  // What averaging the gamma-encoded values would read: the middle code, decoded.
  const gammaY = srgbToLinear(0.5).toFixed(2)
  const detail =
    `checkerboard should read ${CHECKERBOARD_Y} (gamma averaging would give ${gammaY}): ${sizes}. ` +
    `GPU vs CPU on ${width}x${height} noise: max difference ${noiseMaxDiff.toExponential(1)}` +
    ` (limit ${GRID_SELF_TEST_MAX_DIFF})`
  return { pass: pass_, checkerboards, noiseMaxDiff, detail }
}
