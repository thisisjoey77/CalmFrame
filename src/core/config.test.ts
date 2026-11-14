import { describe, expect, it } from 'vitest'
import {
  AREA_WINDOW_COLS,
  AREA_WINDOW_ROWS,
  FAST_TRANSITION_INTERVAL_MS,
  GRID_CELLS
} from '../shared/config'

describe('config', () => {
  it('matches the derived values stated in the spec', () => {
    expect(GRID_CELLS).toBe(5184)
    expect([AREA_WINDOW_COLS, AREA_WINDOW_ROWS]).toEqual([32, 18])
    expect(FAST_TRANSITION_INTERVAL_MS).toBe(Math.round(1000 / 6))
  })
})
