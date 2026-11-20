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

  it('defaults to "Keep motion sharp" (asked for Sat Nov 14); smoothing is the other choice', () => {
    expect(DEFAULT_SETTINGS.mitigation).toBe('correct')
    expect(parseSettings({ mitigation: 'smooth' }).mitigation).toBe('smooth')
    expect(parseSettings({ mitigation: 'sharpest' }).mitigation).toBe('correct')
    // A settings file saved before the option existed.
    expect(parseSettings({ concurrency: 'off' }).mitigation).toBe('correct')
    const off = applySettingsPatch(DEFAULT_SETTINGS, { mitigation: 'smooth' })
    expect(off).toEqual({ ...DEFAULT_SETTINGS, mitigation: 'smooth' })
    expect(applySettingsPatch(off, { mitigation: true })).toEqual(off)
    // It changes how a hazard is drawn, not what the detector looks for.
    expect(detectorOptionsFor(off)).toEqual(detectorOptionsFor(DEFAULT_SETTINGS))
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
      flashLimit: 3,
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
      concurrency: 'one-way',
      flashLimit: 3
    })
    expect(
      detectorOptionsFor({
        ...DEFAULT_SETTINGS,
        sensitivity: { trigger: 'strict' },
        concurrency: 'off'
      })
    ).toEqual({ trigger: 'strict', concurrency: 'off', flashLimit: 3 })
  })

  it('keeps the flash limit at the standard 3 unless raised, and never restores a raised one', () => {
    expect(DEFAULT_SETTINGS.flashLimit).toBe(3)
    // While the app runs, the slider's whole numbers from 3 to 10 are accepted.
    const raised = applySettingsPatch(DEFAULT_SETTINGS, { flashLimit: 7 })
    expect(raised).toEqual({ ...DEFAULT_SETTINGS, flashLimit: 7 })
    expect(detectorOptionsFor(raised).flashLimit).toBe(7)
    for (const bad of [2, 11, 4.5, '5', null, NaN]) {
      expect(applySettingsPatch(raised, { flashLimit: bad })).toEqual(raised)
    }
    // From the file it is always the standard: a limit raised for a test must not leave
    // someone with weaker protection after a restart.
    expect(parseSettings(JSON.parse(JSON.stringify(raised))).flashLimit).toBe(3)
  })

  it('predicts more flashes seen in strict mode when the flash limit is raised', () => {
    const strict = SENSITIVITY_POSITIONS[3]
    // Strict needs 2 x limit + 1 changes: 7 at the standard's 3, 11 at 5.
    expect(predictedFlashesSeen(strict, 10, 75, 3)).toBeCloseTo(3.75, 10)
    expect(predictedFlashesSeen(strict, 10, 75, 5)).toBeCloseTo(5.75, 10)
    // The early trigger counts N changes whatever the limit.
    expect(predictedFlashesSeen(SENSITIVITY_POSITIONS[1], 10, 75, 5)).toBeCloseTo(1.75, 10)
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
