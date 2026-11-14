/**
 * How strongly to smooth and how much to dim. docs/SPEC.md, "Mitigation math".
 *
 * The filter is S_t = S_{t-1} + alpha (X_t - S_{t-1}), per pixel in linear light. For a
 * square strobe of size dL whose half-cycles last n frames, the swing that survives is
 * r = dL (1 - beta^n) / (1 + beta^n), with beta = 1 - alpha. Solving that for the target
 * residual gives alpha; dimming closes whatever gap the alpha clamp leaves.
 */

import { ALPHA_MAX, ALPHA_MIN, DIM_MIN, TARGET_RESIDUAL } from '../shared/config'

/** Frames per half-cycle, n = fs / (2 f). Not necessarily a whole number. */
export function halfCycleFrames(captureFps: number, frequencyHz: number): number {
  return captureFps / (2 * frequencyHz)
}

/** Steady-state peak-to-peak swing left in S. "How much flicker survives". */
export function residualSwing(flashSize: number, alpha: number, n: number): number {
  const bn = Math.pow(1 - alpha, n)
  return (flashSize * (1 - bn)) / (1 + bn)
}

/**
 * The alpha that leaves exactly the target residual, before clamping. "Choosing alpha".
 * A flash already at or under the target needs no smoothing, which is alpha = 1.
 */
export function solveAlphaUnclamped(
  flashSize: number,
  n: number,
  target: number = TARGET_RESIDUAL
): number {
  if (flashSize <= target) return 1
  return 1 - Math.pow((flashSize - target) / (flashSize + target), 1 / n)
}

/** The solved alpha clamped to [ALPHA_MIN, ALPHA_MAX]. Below the minimum the picture
 *  smears. */
export function solveAlpha(flashSize: number, n: number, target: number = TARGET_RESIDUAL): number {
  return clamp(solveAlphaUnclamped(flashSize, n, target), ALPHA_MIN, ALPHA_MAX)
}

/** d = min(1, target / r), never below DIM_MIN, where r is what alpha actually leaves.
 *  "Dimming covers what smoothing cannot". */
export function dimFactor(
  flashSize: number,
  alpha: number,
  n: number,
  target: number = TARGET_RESIDUAL
): number {
  const r = residualSwing(flashSize, alpha, n)
  return r <= target ? 1 : Math.max(DIM_MIN, target / r)
}

export interface FilterParams {
  alpha: number
  dim: number
  /** Swing left after smoothing and dimming: d * r. */
  residual: number
}

/** Alpha, dim and the resulting residual for a detected flash. */
export function filterParams(
  flashSize: number,
  frequencyHz: number,
  captureFps: number,
  out: FilterParams = { alpha: 0, dim: 0, residual: 0 }
): FilterParams {
  const n = halfCycleFrames(captureFps, frequencyHz)
  const alpha = solveAlpha(flashSize, n)
  const dim = dimFactor(flashSize, alpha, n)
  out.alpha = alpha
  out.dim = dim
  out.residual = dim * residualSwing(flashSize, alpha, n)
  return out
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
