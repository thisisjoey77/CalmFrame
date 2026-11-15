/**
 * A brightness target that holds still against a flash and follows a real change.
 * Experimental, and so far only in the offline render. docs/SPEC.md, "Game mode: hold the
 * usual look".
 *
 * The smoothing filter and the brightness correction steer toward a running average, which
 * during a flash sits between the dark and the bright frames: every frame is then changed,
 * and the picture ends up hazy or dark. This target instead stays where the region usually
 * is:
 *
 * - While the region has been off its target, in one direction, for no longer than GAME_HOLD_MS,
 *   the target moves by at most TARGET_RESIDUAL per GAME_HOLD_MS. A hazardous flash reverses
 *   within 167 ms, so through any flash the target moves by less than the flash threshold.
 * - Once the region has stayed off its target for longer than that, the change cannot be a
 *   hazardous flash. It is the scene changing, and the target catches up quickly.
 *
 * So the frames that look as the region usually does pass untouched, and only the odd
 * frames out are pulled back. A strobe with equal halves keeps the state it started in.
 * Time comes from capture timestamps, never frame counts.
 */

import {
  GAME_HOLD_CATCH_UP_MS,
  GAME_HOLD_MS,
  GAME_HOLD_TOLERANCE,
  TARGET_RESIDUAL
} from '../shared/config'

/**
 * How far a mean is off its target: the channel that is furthest off, with its sign.
 * @param mean linear R, G, B at mean[m..m+2]
 * @param target linear R, G, B at target[t..t+2]
 */
export function deviation(
  mean: ArrayLike<number>,
  m: number,
  target: ArrayLike<number>,
  t: number
): number {
  let d = 0
  for (let ch = 0; ch < 3; ch++) {
    const e = mean[m + ch] - target[t + ch]
    if (Math.abs(e) > Math.abs(d)) d = e
  }
  return d
}

/**
 * Move one target toward its region's mean for this frame.
 * @param target the targets, linear R, G, B; this one is at target[t..t+2]
 * @param mean the region means; this one is at mean[m..m+2]
 * @param run per target: how long, in ms, the mean has been off the target in one
 *            direction. Positive is above, negative below. This one is run[r].
 * @param dtMs time since the previous frame, from capture timestamps
 */
export function followTarget(
  target: Float32Array | Float64Array,
  t: number,
  mean: ArrayLike<number>,
  m: number,
  run: Float32Array | Float64Array,
  r: number,
  dtMs: number
): void {
  const d = deviation(mean, m, target, t)
  let v = run[r]
  if (d > GAME_HOLD_TOLERANCE) v = v > 0 ? v + dtMs : dtMs
  else if (d < -GAME_HOLD_TOLERANCE) v = v < 0 ? v - dtMs : -dtMs
  else v = 0
  run[r] = v
  if (Math.abs(v) > GAME_HOLD_MS) {
    const k = 1 - Math.exp(-dtMs / GAME_HOLD_CATCH_UP_MS)
    for (let ch = 0; ch < 3; ch++) target[t + ch] += k * (mean[m + ch] - target[t + ch])
    return
  }
  const step = (TARGET_RESIDUAL * dtMs) / GAME_HOLD_MS
  for (let ch = 0; ch < 3; ch++) {
    const e = mean[m + ch] - target[t + ch]
    target[t + ch] += e > step ? step : e < -step ? -step : e
  }
}
