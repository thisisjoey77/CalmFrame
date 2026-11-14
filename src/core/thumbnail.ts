/**
 * The dashboard's thumbnails (docs/SPEC.md, Phase 5): the 96x54 grid the detector sees,
 * encoded from linear RGB to sRGB RGBA8 so a canvas can show it.
 *
 * The overlay encodes the grid every STATS_EVERY_N_FRAMES frames ("The per-frame loop",
 * step 8). Only these 20 KB cross IPC, never a frame.
 */

import {
  AREA_LIMIT,
  AREA_WINDOW_FRACTION,
  GRID_CELLS,
  GRID_COLS,
  GRID_ROWS,
  THUMBNAIL_LUT_SIZE,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_SCREEN_FRACTION,
  THUMBNAIL_MAX_WIDTH
} from '../shared/config'
import { linearToSrgb } from './luminance'

const LUT_LAST = THUMBNAIL_LUT_SIZE - 1

function buildLut(): Uint8Array {
  const lut = new Uint8Array(THUMBNAIL_LUT_SIZE)
  for (let i = 0; i < THUMBNAIL_LUT_SIZE; i++) {
    lut[i] = Math.round(255 * linearToSrgb(i / LUT_LAST))
  }
  return lut
}

const LUT = buildLut()

/** One linear value in 0..1 (clamped; NaN reads as 0) to an 8-bit sRGB code, through the
 *  table. */
export function linearToSrgb8(l: number): number {
  const v = l > 0 ? (l < 1 ? l : 1) : 0
  return LUT[Math.round(v * LUT_LAST)]
}

/**
 * Encode a grid of linear RGB to sRGB RGBA8, alpha 255. Row 0 stays at the top.
 * @param grid linear R, G, B (and A if channels is 4) per cell, row-major 96x54
 * @param out GRID_CELLS * 4 bytes, overwritten
 */
export function encodeGridRgba8(
  grid: ArrayLike<number>,
  channels: 3 | 4,
  out: Uint8Array | Uint8ClampedArray
): void {
  if (out.length < GRID_CELLS * 4) throw new Error('thumbnail buffer is too small')
  for (let i = 0, k = 0, o = 0; i < GRID_CELLS; i++, k += channels, o += 4) {
    out[o] = linearToSrgb8(grid[k])
    out[o + 1] = linearToSrgb8(grid[k + 1])
    out[o + 2] = linearToSrgb8(grid[k + 2])
    out[o + 3] = 255
  }
}

export interface ThumbnailSize {
  width: number
  height: number
}

/**
 * Largest thumbnail, in device pixels, for a screen of this size in device pixels: no
 * larger than THUMBNAIL_MAX_WIDTH x THUMBNAIL_MAX_HEIGHT, nor than
 * THUMBNAIL_MAX_SCREEN_FRACTION of the screen each way, with the grid's aspect ratio.
 * At 1920x1080 that is exactly 240x135. Either cap keeps a flashing thumbnail under the
 * WCAG area limit, which is a quarter of a window one third of the screen each way.
 */
export function thumbnailDeviceSize(screenWidth: number, screenHeight: number): ThumbnailSize {
  const byWidth = Math.min(THUMBNAIL_MAX_WIDTH, screenWidth * THUMBNAIL_MAX_SCREEN_FRACTION)
  const byHeight = Math.min(THUMBNAIL_MAX_HEIGHT, screenHeight * THUMBNAIL_MAX_SCREEN_FRACTION)
  const width = Math.floor(Math.min(byWidth, (byHeight * GRID_COLS) / GRID_ROWS))
  const height = Math.floor((width * GRID_ROWS) / GRID_COLS)
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

/** Share of the WCAG area limit a thumbnail of this size fills on this screen: below 1
 *  means a thumbnail flashing at full contrast is still not a hazardous area. */
export function thumbnailShareOfAreaLimit(
  size: ThumbnailSize,
  screenWidth: number,
  screenHeight: number
): number {
  const windowArea = screenWidth * AREA_WINDOW_FRACTION * (screenHeight * AREA_WINDOW_FRACTION)
  return (size.width * size.height) / (AREA_LIMIT * windowArea)
}
