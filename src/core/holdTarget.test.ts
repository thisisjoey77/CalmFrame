import { describe, expect, it } from 'vitest'
import {
  FAST_TRANSITION_INTERVAL_MS,
  GAME_HOLD_MS,
  GAME_HOLD_TOLERANCE,
  LUMINANCE_THRESHOLD,
  TARGET_RESIDUAL
} from '../shared/config'
import { deviation, followTarget } from './holdTarget'

/** One grey target followed through a list of levels, one per frame. Returns the target
 *  after each frame. */
function follow(start: number, levels: number[], fps = 60): number[] {
  const target = new Float32Array([start, start, start])
  const run = new Float32Array(1)
  const mean = new Float32Array(3)
  return levels.map((level) => {
    mean.fill(level)
    followTarget(target, 0, mean, 0, run, 0, 1000 / fps)
    return target[0]
  })
}

/** A square strobe: `half` frames at `high`, then `half` at `low`, starting high. */
const strobe = (frames: number, half: number, low: number, high: number): number[] =>
  Array.from({ length: frames }, (_, n) => (Math.floor(n / half) % 2 === 0 ? high : low))

const swing = (values: number[]): number => Math.max(...values) - Math.min(...values)

describe('hold target: still against a flash, following a real change (experimental)', () => {
  it('holds longer than the slowest hazardous half-cycle', () => {
    expect(GAME_HOLD_MS).toBeGreaterThan(FAST_TRANSITION_INTERVAL_MS)
  })

  it('measures how far off a mean is by its furthest channel, with its sign', () => {
    expect(deviation([0.5, 0.2, 0.9], 0, [0.4, 0.6, 0.8], 0)).toBeCloseTo(-0.4, 6)
    expect(deviation([0, 0, 0, 0.5, 0.5, 0.9], 3, [0.5, 0.5, 0.5], 0)).toBeCloseTo(0.4, 6)
  })

  it('stays where it was through a 10 Hz strobe, instead of settling in the middle', () => {
    const seen = follow(0.2, strobe(240, 3, 0.2, 0.9))
    expect(swing(seen)).toBeLessThan(TARGET_RESIDUAL)
    expect(Math.max(...seen)).toBeLessThan(0.2 + TARGET_RESIDUAL)
  })

  it('moves by less than the flash threshold through the slowest hazardous flash', () => {
    // 3 Hz at 60 fps: 10 frames, 167 ms, each way.
    const seen = follow(0.1, strobe(300, 10, 0.1, 1))
    expect(swing(seen)).toBeLessThan(LUMINANCE_THRESHOLD)
  })

  it('keeps the bright state when the strobe starts from bright', () => {
    const seen = follow(0.9, strobe(240, 3, 0.1, 0.9))
    expect(Math.min(...seen)).toBeGreaterThan(0.9 - TARGET_RESIDUAL)
  })

  it('follows a change that lasts, GAME_HOLD_MS late', () => {
    const frames = 60
    const seen = follow(0.2, new Array<number>(frames).fill(0.8))
    const held = Math.floor(GAME_HOLD_MS / (1000 / 60))
    // Still within the residual while the change could be a flash.
    expect(seen[held - 1]).toBeLessThan(0.2 + TARGET_RESIDUAL + 1e-6)
    // Half a second on, it is there.
    expect(seen[frames / 2]).toBeGreaterThan(0.75)
    expect(seen[frames - 1]).toBeCloseTo(0.8, 2)
  })

  it('tracks a slow drift without holding it back', () => {
    // 0.3 a second is slower than the residual per hold time, so the target keeps up.
    const levels = Array.from({ length: 120 }, (_, n) => 0.2 + (0.3 * n) / 60)
    const seen = follow(0.2, levels)
    for (let n = 0; n < levels.length; n++) {
      expect(Math.abs(seen[n] - levels[n])).toBeLessThanOrEqual(GAME_HOLD_TOLERANCE + 1e-6)
    }
  })

  it('keeps time from timestamps: the same strobe at 30 fps is held as well', () => {
    const seen = follow(0.2, strobe(120, 2, 0.2, 0.9), 30)
    expect(swing(seen)).toBeLessThan(LUMINANCE_THRESHOLD)
    const lasting = follow(0.2, new Array<number>(30).fill(0.8), 30)
    expect(lasting[29]).toBeCloseTo(0.8, 2)
  })
})
