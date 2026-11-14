/**
 * Per-region brightness correction: the experimental second way to calm a hazard.
 * docs/SPEC.md, "Mitigation math", "Stretch: correct brightness per region".
 *
 * The smoothing filter averages each pixel with its own past, so anything that moves leaves
 * a trail. This keeps the current frame and changes only how bright each region is. Each
 * grid cell has a target: the running average of its own mean, the same filter as the
 * smoothing but on the 96x54 grid (ReferenceFilter holds it). A pixel's region mean and
 * target are interpolated between the four nearest cell centres, and the pixel is then
 * scaled, per channel and in linear light:
 *
 * - region brighter than its target: toward black, x * target / mean
 * - region darker than its target: toward white, 1 - (1 - x) (1 - target) / (1 - mean)
 *
 * Both are straight lines in x that send the region's mean to its target, and neither can
 * leave 0..1, so nothing clips. A region already at its target is left exactly as it is.
 *
 * What this gives up against the smoothing filter: it holds each region's mean steady, not
 * each pixel. Detail smaller than a cell can still alternate, and a hard edge between
 * flashing and still content keeps a flickering rim about a cell wide (regionCorrect.test.ts
 * pins both). The app's GPU pass (src/overlay/correctPass.ts) runs the same arithmetic and
 * is checked against this at startup.
 */

import { CORRECTION_EPSILON } from '../shared/config'

/**
 * One channel of one pixel.
 * @param x the pixel, linear, 0..1
 * @param mean the region's mean now, linear
 * @param target the mean the region should have
 */
export function correctChannel(x: number, mean: number, target: number): number {
  if (mean >= target) return mean > CORRECTION_EPSILON ? (x * target) / mean : target
  const room = 1 - mean
  return room > CORRECTION_EPSILON ? 1 - ((1 - x) * (1 - target)) / room : target
}

/**
 * Correct a whole image.
 * @param image linear R, G, B per pixel, row-major, row 0 at the top
 * @param grid the image's own cell means, `gridChannels` values per cell (R, G, B first)
 * @param target the target mean per cell, R, G, B (ReferenceFilter.state)
 * @param out linear R, G, B per pixel; may be `image` itself
 * @returns out
 */
export function correctImage(
  image: ArrayLike<number>,
  width: number,
  height: number,
  grid: ArrayLike<number>,
  gridChannels: 3 | 4,
  target: ArrayLike<number>,
  cols: number,
  rows: number,
  out: Float32Array | Float64Array
): Float32Array | Float64Array {
  if (cols < 2 || rows < 2) throw new Error(`The grid must be at least 2x2, got ${cols}x${rows}`)
  if (image.length < width * height * 3 || out.length < width * height * 3) {
    throw new Error(`Expected ${width * height * 3} values per image`)
  }
  const gc = gridChannels
  for (let y = 0; y < height; y++) {
    // Where the pixel centre sits between cell centres, clamped at the edges of the grid.
    const gy = clamp(((y + 0.5) / height) * rows - 0.5, 0, rows - 1)
    const j = Math.min(Math.floor(gy), rows - 2)
    const fy = gy - j
    for (let x = 0; x < width; x++) {
      const gx = clamp(((x + 0.5) / width) * cols - 0.5, 0, cols - 1)
      const i = Math.min(Math.floor(gx), cols - 2)
      const fx = gx - i
      const c00 = j * cols + i
      const c10 = c00 + 1
      const c01 = c00 + cols
      const c11 = c01 + 1
      const p = (y * width + x) * 3
      for (let ch = 0; ch < 3; ch++) {
        const mean = mix(
          mix(grid[c00 * gc + ch], grid[c10 * gc + ch], fx),
          mix(grid[c01 * gc + ch], grid[c11 * gc + ch], fx),
          fy
        )
        const goal = mix(
          mix(target[c00 * 3 + ch], target[c10 * 3 + ch], fx),
          mix(target[c01 * 3 + ch], target[c11 * 3 + ch], fx),
          fy
        )
        out[p + ch] = correctChannel(image[p + ch], mean, goal)
      }
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
