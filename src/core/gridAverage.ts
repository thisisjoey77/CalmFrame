/**
 * Area average of an sRGB image down to the analysis grid, in linear light.
 * docs/SPEC.md, "Detection math", Step 2.
 *
 * The overlay does this on the GPU (Pass A, src/overlay/gridPass.ts). This is the CPU twin:
 * the reference the GPU pass is checked against at startup, and the grid step the
 * validator CLI (Phase 6) needs when it decodes a video file.
 *
 * Each source pixel is linearised first, then weighted by how much of it falls inside the
 * cell. Cells need not hold a whole number of pixels (1366 px over 96 cells is 14.23 each),
 * so edge pixels count fractionally. That is a true area average, not point sampling.
 */

import { GRID_COLS, GRID_ROWS } from '../shared/config'
import { SRGB8_TO_LINEAR } from './luminance'

/**
 * @param pixels sRGB RGBA, 8 bits per channel, row-major, row 0 at the top of the image
 * @param out linear R, G, B and A = 1 per cell, row-major, row 0 at the top. The same
 *            layout the GPU pass reads back, so the detector takes either with
 *            inputChannels 4.
 * @returns out
 */
export function averageToGrid(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  out: Float32Array,
  cols = GRID_COLS,
  rows = GRID_ROWS
): Float32Array {
  if (!(width >= cols && height >= rows)) {
    throw new Error(`Image ${width}x${height} is smaller than the ${cols}x${rows} grid`)
  }
  if (pixels.length < width * height * 4) {
    throw new Error(`Expected ${width * height * 4} values, got ${pixels.length}`)
  }
  if (out.length < cols * rows * 4) {
    throw new Error(`Output needs ${cols * rows * 4} values, got ${out.length}`)
  }

  // Horizontal pass: each source row reduced to one weighted sum per cell column.
  const lut = SRGB8_TO_LINEAR
  const rowSums = new Float64Array(height * cols * 3)
  for (let i = 0; i < cols; i++) {
    const lo = (i * width) / cols
    const hi = ((i + 1) * width) / cols
    const end = Math.min(width, Math.ceil(hi))
    for (let x = Math.floor(lo); x < end; x++) {
      const w = Math.min(hi, x + 1) - Math.max(lo, x)
      for (let y = 0; y < height; y++) {
        const p = (y * width + x) * 4
        const s = (y * cols + i) * 3
        rowSums[s] += w * lut[pixels[p]]
        rowSums[s + 1] += w * lut[pixels[p + 1]]
        rowSums[s + 2] += w * lut[pixels[p + 2]]
      }
    }
  }

  // Vertical pass, then divide by the cell's area in pixels.
  const area = (width / cols) * (height / rows)
  for (let j = 0; j < rows; j++) {
    const lo = (j * height) / rows
    const hi = ((j + 1) * height) / rows
    const end = Math.min(height, Math.ceil(hi))
    for (let i = 0; i < cols; i++) {
      let r = 0
      let g = 0
      let b = 0
      for (let y = Math.floor(lo); y < end; y++) {
        const w = Math.min(hi, y + 1) - Math.max(lo, y)
        const s = (y * cols + i) * 3
        r += w * rowSums[s]
        g += w * rowSums[s + 1]
        b += w * rowSums[s + 2]
      }
      const o = (j * cols + i) * 4
      out[o] = r / area
      out[o + 1] = g / area
      out[o + 2] = b / area
      out[o + 3] = 1
    }
  }
  return out
}
