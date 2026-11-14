/**
 * Linear light, relative luminance and the red-flash quantities.
 * docs/SPEC.md, "Detection math", Steps 1 and 3.
 *
 * Every threshold in the spec is defined on linear relative luminance, so pixels are
 * decoded from sRGB before anything is averaged or compared.
 */

import {
  LUMA_B,
  LUMA_G,
  LUMA_R,
  RED_SCALE,
  SRGB_GAMMA,
  SRGB_LINEAR_CUTOFF,
  SRGB_LINEAR_SLOPE,
  SRGB_OFFSET
} from '../shared/config'

/** One sRGB channel value in 0..1 to linear light in 0..1. Step 1. */
export function srgbToLinear(c: number): number {
  return c <= SRGB_LINEAR_CUTOFF
    ? c / SRGB_LINEAR_SLOPE
    : Math.pow((c + SRGB_OFFSET) / (1 + SRGB_OFFSET), SRGB_GAMMA)
}

function buildSrgb8Lut(): Float32Array {
  const lut = new Float32Array(256)
  for (let code = 0; code < 256; code++) lut[code] = srgbToLinear(code / 255)
  return lut
}

/** Linear value of each 8-bit sRGB code, for decoding frames on the CPU (validator). */
export const SRGB8_TO_LINEAR: Float32Array = buildSrgb8Lut()

/** Relative luminance Y of linear R, G, B: 0 is black, 1 is white. Step 1. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b
}

/** Red ratio rho = R / (R + G + B) of linear R, G, B. Black counts as 0, not NaN. Step 3. */
export function redRatio(r: number, g: number, b: number): number {
  const sum = r + g + b
  return sum > 0 ? r / sum : 0
}

/** Red value v = 320 * max(0, R - G - B) of linear R, G, B. Step 3. */
export function redValue(r: number, g: number, b: number): number {
  return RED_SCALE * Math.max(0, r - g - b)
}
