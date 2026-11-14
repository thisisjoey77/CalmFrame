import { describe, expect, it } from 'vitest'
import {
  AREA_WINDOW_COLS,
  AREA_WINDOW_ROWS,
  DEFAULT_FLASH_LIMIT,
  FAST_TRANSITION_INTERVAL_MS,
  GRAPH_LIMIT_FLASHES_PER_SEC,
  GRID_CELLS,
  STRICT_TRIGGER_COUNT,
  fastTransitionIntervalMs,
  strictTriggerCount
} from '../shared/config'

describe('config', () => {
  it('matches the derived values stated in the spec', () => {
    expect(GRID_CELLS).toBe(5184)
    expect([AREA_WINDOW_COLS, AREA_WINDOW_ROWS]).toEqual([32, 18])
    expect(FAST_TRANSITION_INTERVAL_MS).toBe(Math.round(1000 / 6))
    // The same two numbers, derived from the flash limit of 3 (Step 7).
    expect(DEFAULT_FLASH_LIMIT).toBe(3)
    expect(fastTransitionIntervalMs(DEFAULT_FLASH_LIMIT)).toBe(FAST_TRANSITION_INTERVAL_MS)
    expect(strictTriggerCount(DEFAULT_FLASH_LIMIT)).toBe(STRICT_TRIGGER_COUNT)
    expect(GRAPH_LIMIT_FLASHES_PER_SEC).toBe(DEFAULT_FLASH_LIMIT)
    // A raised limit asks for faster flashing: 5 a second is 11 changes, 100 ms apart.
    expect(strictTriggerCount(5)).toBe(11)
    expect(fastTransitionIntervalMs(5)).toBe(100)
    expect(fastTransitionIntervalMs(7)).toBe(72)
  })
})
