/**
 * The settings file (docs/SPEC.md, Phase 5: "Settings persist across restarts"): JSON in
 * the app's userData folder. Read once at startup; written a moment after each change,
 * through a temporary file and a rename, so a crash mid-write cannot leave half a file.
 * A missing or damaged file gives the defaults (src/shared/settings.ts validates each
 * field). No Electron imports, so it is unit-tested.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SETTINGS_SAVE_DELAY_MS } from '../shared/config'
import { applySettingsPatch, parseSettings, type Settings } from '../shared/settings'

export class SettingsStore {
  private current: Settings
  private timer: ReturnType<typeof setTimeout> | null = null

  /** @param file full path of the settings file */
  constructor(
    private readonly file: string,
    private readonly saveDelayMs = SETTINGS_SAVE_DELAY_MS
  ) {
    this.current = this.load()
  }

  get settings(): Settings {
    return this.current
  }

  /**
   * Apply a change (validated field by field) and schedule a save.
   * @returns the settings now in force; the same object if nothing changed
   */
  update(patch: unknown): Settings {
    const next = applySettingsPatch(this.current, patch)
    if (JSON.stringify(next) === JSON.stringify(this.current)) return this.current
    this.current = next
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.saveDelayMs)
    return this.current
  }

  /** Write any pending change now, e.g. when the app quits. */
  flush(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8')
      renameSync(temp, this.file)
    } catch (error) {
      console.error(`[settings] could not save ${this.file}: ${String(error)}`)
    }
  }

  private load(): Settings {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return parseSettings(null)
    }
    try {
      return parseSettings(JSON.parse(text))
    } catch (error) {
      console.warn(`[settings] ${this.file} is damaged, using the defaults: ${String(error)}`)
      return parseSettings(null)
    }
  }
}
