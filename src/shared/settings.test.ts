import { describe, expect, it } from 'vitest'
import { DEFAULT_CONCURRENCY_RULE, EARLY_TRIGGER_STREAK, PREARM_ENABLED } from './config'
import {
  DEFAULT_SETTINGS,
  SENSITIVITY_POSITIONS,
  applySettingsPatch,
  detectorOptionsFor,
  parseSettings,
  predictedFlashesSeen,
  sensitivityPosition
} from './settings'

describe('settings (Phase 5)', () => {
  it('defaults to the spec: early trigger at N = 3, movement ignored (Step 5a on)', () => {
    expect(DEFAULT_SETTINGS.sensitivity).toEqual({
      trigger: 'early',
      streakN: EARLY_TRIGGER_STREAK
    })
    expect(DEFAULT_SETTINGS.concurrency).toBe('one-way')
    expect(DEFAULT_CONCURRENCY_RULE).toBe('one-way')
    expect(DEFAULT_SETTINGS.dashboardBounds).toBeNull()
  })

  it('defaults to the smoothing filter; "Keep motion sharp" is an opt-in (trail #10)', () => {
    expect(DEFAULT_SETTINGS.mitigation).toBe('smooth')
    expect(parseSettings({ mitigation: 'correct' }).mitigation).toBe('correct')
    expect(parseSettings({ mitigation: 'sharpest' }).mitigation).toBe('smooth')
    // A settings file saved before the option existed.
    expect(parseSettings({ concurrency: 'off' }).mitigation).toBe('smooth')
    const on = applySettingsPatch(DEFAULT_SETTINGS, { mitigation: 'correct' })
    expect(on).toEqual({ ...DEFAULT_SETTINGS, mitigation: 'correct' })
    expect(applySettingsPatch(on, { mitigation: true })).toEqual(on)
    // It changes how a hazard is drawn, not what the detector looks for.
    expect(detectorOptionsFor(on)).toEqual(detectorOptionsFor(DEFAULT_SETTINGS))
  })

  it('has slider positions N = 2, 3, 4, then strict, and no pre-arm position', () => {
    expect(SENSITIVITY_POSITIONS).toEqual([
      { trigger: 'early', streakN: 2 },
      { trigger: 'early', streakN: 3 },
      { trigger: 'early', streakN: 4 },
      { trigger: 'strict' }
    ])
    expect(PREARM_ENABLED).toBe(false)
    expect(sensitivityPosition(DEFAULT_SETTINGS.sensitivity)).toBe(1)
    expect(sensitivityPosition({ trigger: 'strict' })).toBe(3)
    expect(sensitivityPosition({ trigger: 'early', streakN: 5 })).toBe(-1)
  })

  it('round-trips through JSON', () => {
    const s = {
      sensitivity: { trigger: 'strict' as const },
      concurrency: 'off' as const,
      mitigation: 'correct' as const,
      dashboardBounds: { x: 10, y: -20, width: 460, height: 700 }
    }
    expect(parseSettings(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })

  it('falls back to the defaults, field by field, for anything damaged', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
    const s = parseSettings({
      sensitivity: { trigger: 'early', streakN: 9 },
      concurrency: 'one-way',
      dashboardBounds: { x: 0, y: 0, width: 10, height: 10 }
    })
    expect(s.sensitivity).toEqual(DEFAULT_SETTINGS.sensitivity)
    expect(s.concurrency).toBe('one-way')
    expect(s.dashboardBounds).toBeNull()
    expect(parseSettings({ concurrency: 'sideways' }).concurrency).toBe('one-way')
    expect(
      parseSettings({ dashboardBounds: { x: 0, y: NaN, width: 500, height: 600 } }).dashboardBounds
    ).toBeNull()
  })

  it('applies a renderer change to the named fields only, ignoring invalid values', () => {
    const changed = applySettingsPatch(DEFAULT_SETTINGS, { concurrency: 'off' })
    expect(changed).toEqual({ ...DEFAULT_SETTINGS, concurrency: 'off' })
    expect(applySettingsPatch(changed, { sensitivity: { trigger: 'early', streakN: 4 } })).toEqual({
      ...changed,
      sensitivity: { trigger: 'early', streakN: 4 }
    })
    expect(applySettingsPatch(changed, { sensitivity: { trigger: 'early', streakN: 1 } })).toEqual(
      changed
    )
    expect(applySettingsPatch(changed, { concurrency: 42 })).toEqual(changed)
    expect(applySettingsPatch(changed, 'off')).toEqual(changed)
  })

  it('turns the settings into detector options', () => {
    expect(detectorOptionsFor(DEFAULT_SETTINGS)).toEqual({
      trigger: 'early',
      streakN: 3,
      concurrency: 'one-way'
    })
    expect(
      detectorOptionsFor({
        ...DEFAULT_SETTINGS,
        sensitivity: { trigger: 'strict' },
        concurrency: 'off'
      })
    ).toEqual({ trigger: 'strict', concurrency: 'off' })
  })

  it("predicts the flashes seen as the spec's Step 7 table does (10 Hz, 75 ms)", () => {
    const [n2, n3, n4, strict] = SENSITIVITY_POSITIONS.map((s) => predictedFlashesSeen(s))
    expect(n2).toBeCloseTo(1.25, 10)
    expect(n3).toBeCloseTo(1.75, 10)
    expect(n4).toBeCloseTo(2.25, 10)
    expect(strict).toBeCloseTo(3.75, 10)
    // The other columns of the table.
    expect(predictedFlashesSeen(SENSITIVITY_POSITIONS[1], 5, 50)).toBeCloseTo(1.25, 10)
    expect(predictedFlashesSeen(SENSITIVITY_POSITIONS[1], 15, 100)).toBeCloseTo(2.5, 10)
  })
})
