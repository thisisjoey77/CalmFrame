/**
 * Game mode's way of calming a hazard: dim, never whiten. Experimental, and so far only in
 * the offline render (tools/validate). docs/SPEC.md, "Game mode (experimental)".
 *
 * The brightness correction of regionCorrect.ts meets in the middle: it pulls bright frames
 * down and dark frames up toward their running average, and the lifting washes a hard
 * flashing game out to pale grey. This keeps the idea of steadying each region's
 * brightness, with three changes that suit a fast, flat-coloured game:
 *
 * - Big zones. The screen is 16x9 zones (6x6 grid cells each), blended smoothly, so the
 *   correction changes slowly across the picture and draws no halo around every obstacle.
 * - Brightness only. One factor scales red, green and blue together, so a pixel keeps its
 *   hue and its contrast against its neighbours.
 * - Down only. A zone's target follows its brightness down at once and up only slowly, so
 *   the target is never above the zone's brightness now. Bright frames are dimmed to the
 *   level of the dark ones and nothing is lifted. Black stays black.
 *
 * What it gives up: the picture is darker while the game flashes, and a flash down to
 * black takes the picture down to black with it (zoneDim.test.ts pins both). Like every
 * zone method it steadies zones, not pixels, so it does little for a small flashing object.
 */

import { CORRECTION_EPSILON, GAME_RISE_FACTOR, LUMA_B, LUMA_G, LUMA_R } from '../shared/config'

/**
 * The mean luminance of each zone, from the analysis grid.
 * @param grid linear R, G, B (and A if gridChannels is 4) per cell, row-major
 * @param out luminance per zone, row-major
 */
export function gridToZones(
  grid: ArrayLike<number>,
  gridChannels: 3 | 4,
  cols: number,
  rows: number,
  zoneCols: number,
  zoneRows: number,
  out: Float32Array | Float64Array
): Float32Array | Float64Array {
  const kx = cols / zoneCols
  const ky = rows / zoneRows
  if (!Number.isInteger(kx) || !Number.isInteger(ky)) {
    throw new Error(`A ${cols}x${rows} grid does not divide into ${zoneCols}x${zoneRows} zones`)
  }
  const scale = 1 / (kx * ky)
  for (let j = 0; j < zoneRows; j++) {
    for (let i = 0; i < zoneCols; i++) {
      let sum = 0
      for (let y = j * ky; y < (j + 1) * ky; y++) {
        for (let x = i * kx; x < (i + 1) * kx; x++) {
          const p = (y * cols + x) * gridChannels
          sum += LUMA_R * grid[p] + LUMA_G * grid[p + 1] + LUMA_B * grid[p + 2]
        }
      }
      out[j * zoneCols + i] = sum * scale
    }
  }
  return out
}

/**
 * Each zone's target brightness: it drops to the zone's brightness at once, and rises
 * toward it by GAME_RISE_FACTOR x alpha per frame. So it follows the dark frames of a
 * flash and never exceeds the brightness the zone has now.
 *
 * The rise is half the smoothing filter's alpha because a target that only ever rises
 * between dark frames leaves a swing of dL (1 - beta^n), about twice what the two-sided
 * average leaves for the same alpha ("How much flicker survives").
 */
export class ZoneDimTargets {
  readonly state: Float64Array
  private primed = false

  constructor(readonly zones: number) {
    this.state = new Float64Array(zones)
  }

  /** @param alpha the smoothing filter's step for this frame; the first frame primes */
  step(zoneLuminance: ArrayLike<number>, alpha: number): void {
    const t = this.state
    if (!this.primed) {
      for (let i = 0; i < t.length; i++) t[i] = zoneLuminance[i]
      this.primed = true
      return
    }
    const rise = alpha >= 1 ? 1 : alpha * GAME_RISE_FACTOR
    for (let i = 0; i < t.length; i++) {
      const now = zoneLuminance[i]
      const risen = t[i] + rise * (now - t[i])
      t[i] = now < risen ? now : risen
    }
  }
}

/**
 * Dim a whole image: every pixel is scaled by its region's target over its region's
 * brightness, both interpolated between the four nearest zone centres, and never by more
 * than 1.
 * @param image linear R, G, B per pixel, row-major, row 0 at the top
 * @param out linear R, G, B per pixel; may be `image` itself
 */
export function dimImage(
  image: ArrayLike<number>,
  width: number,
  height: number,
  zoneLuminance: ArrayLike<number>,
  target: ArrayLike<number>,
  zoneCols: number,
  zoneRows: number,
  out: Float32Array | Float64Array
): Float32Array | Float64Array {
  if (zoneCols < 2 || zoneRows < 2) {
    throw new Error(`There must be at least 2x2 zones, got ${zoneCols}x${zoneRows}`)
  }
  for (let y = 0; y < height; y++) {
    const gy = clamp(((y + 0.5) / height) * zoneRows - 0.5, 0, zoneRows - 1)
    const j = Math.min(Math.floor(gy), zoneRows - 2)
    const fy = gy - j
    for (let x = 0; x < width; x++) {
      const gx = clamp(((x + 0.5) / width) * zoneCols - 0.5, 0, zoneCols - 1)
      const i = Math.min(Math.floor(gx), zoneCols - 2)
      const fx = gx - i
      const c00 = j * zoneCols + i
      const c10 = c00 + 1
      const c01 = c00 + zoneCols
      const c11 = c01 + 1
      const mean = mix(
        mix(zoneLuminance[c00], zoneLuminance[c10], fx),
        mix(zoneLuminance[c01], zoneLuminance[c11], fx),
        fy
      )
      const goal = mix(mix(target[c00], target[c10], fx), mix(target[c01], target[c11], fx), fy)
      const k = mean > CORRECTION_EPSILON && goal < mean ? goal / mean : 1
      const p = (y * width + x) * 3
      out[p] = image[p] * k
      out[p + 1] = image[p + 1] * k
      out[p + 2] = image[p + 2] * k
    }
  }
  return out
}

function mix(a: number, b: number, f: number): number {
  return a + (b - a) * f
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
