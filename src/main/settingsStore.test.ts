import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsStore } from './settingsStore'

describe('settings file (Phase 5: settings persist across restarts)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calmframe-settings-'))
    file = join(dir, 'nested', 'settings.json')
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts from the defaults when there is no file, and writes nothing until a change', () => {
    const store = new SettingsStore(file)
    expect(store.settings).toEqual(DEFAULT_SETTINGS)
    store.flush()
    expect(() => readFileSync(file)).toThrow()
  })

  it('keeps a change across a restart', () => {
    const store = new SettingsStore(file)
    store.update({ sensitivity: { trigger: 'early', streakN: 4 }, concurrency: 'off' })
    store.flush()
    const again = new SettingsStore(file)
    expect(again.settings.sensitivity).toEqual({ trigger: 'early', streakN: 4 })
    expect(again.settings.concurrency).toBe('off')
  })

  it('saves a moment after the last change, once', () => {
    vi.useFakeTimers()
    const store = new SettingsStore(file, 500)
    store.update({ concurrency: 'off' })
    store.update({ sensitivity: { trigger: 'strict' } })
    vi.advanceTimersByTime(499)
    expect(() => readFileSync(file)).toThrow()
    vi.advanceTimersByTime(1)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.sensitivity).toEqual({ trigger: 'strict' })
    expect(saved.concurrency).toBe('off')
  })

  it('returns the same settings when a change changes nothing or is invalid', () => {
    const store = new SettingsStore(file)
    const before = store.settings
    expect(store.update({ concurrency: 'one-way' })).toBe(before)
    expect(store.update({ concurrency: 'sideways' })).toBe(before)
    expect(store.update(null)).toBe(before)
  })

  it('falls back to the defaults for a damaged file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new SettingsStore(join(dir, 'settings.json'))
    store.update({ concurrency: 'off' })
    store.flush()
    writeFileSync(join(dir, 'settings.json'), '{ not json', 'utf8')
    expect(new SettingsStore(join(dir, 'settings.json')).settings).toEqual(DEFAULT_SETTINGS)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
