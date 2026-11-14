import { describe, expect, it } from 'vitest'
import { elapsedText, flashEventText } from './eventText'
import type { FlashEventMessage } from './messages'

const START = 1_700_000_000_000

const event = (patch: Partial<FlashEventMessage>): FlashEventMessage => ({
  kind: 'end',
  id: 1,
  startT: 0,
  lastT: 2100,
  durationMs: 2100,
  type: 'luminance',
  frequencyHz: 8.2,
  smoothed: true,
  startWallMs: START + 42_000,
  ...patch
})

describe('event log lines (Phase 5)', () => {
  it("reads like the spec's example", () => {
    expect(flashEventText(event({}), START)).toBe('0:42, 8 Hz, 2.1 s, smoothed')
  })

  it('says ongoing and smoothing while the event is open', () => {
    expect(flashEventText(event({ kind: 'start', durationMs: null }), START)).toBe(
      '0:42, 8 Hz, ongoing, smoothing'
    )
  })

  it('says so when protection was off', () => {
    expect(flashEventText(event({ smoothed: false }), START)).toBe(
      '0:42, 8 Hz, 2.1 s, not smoothed (protection off)'
    )
  })

  it('marks red flashes, very short ones and an unknown rate', () => {
    expect(flashEventText(event({ type: 'red', frequencyHz: 12.6 }), START)).toBe(
      '0:42, 13 Hz red, 2.1 s, smoothed'
    )
    expect(flashEventText(event({ durationMs: 30 }), START)).toBe(
      '0:42, 8 Hz, under 0.1 s, smoothed'
    )
    expect(flashEventText(event({ frequencyHz: 0 }), START)).toBe(
      '0:42, rate unknown, 2.1 s, smoothed'
    )
  })

  it('counts minutes, then hours', () => {
    expect(elapsedText(0)).toBe('0:00')
    expect(elapsedText(59_999)).toBe('0:59')
    expect(elapsedText(61_000)).toBe('1:01')
    expect(elapsedText(3_600_000 + 5 * 60_000 + 7_000)).toBe('1:05:07')
    expect(elapsedText(-500)).toBe('0:00')
  })
})
