import { describe, expect, it } from 'vitest'
import type { StatusBeat } from './messages'
import { panelNotice } from './panelNotice'
import { deriveStatus } from './status'

const healthy: StatusBeat = {
  state: 'safe',
  frameAgeMs: 20,
  captureLive: true,
  overlayVisible: true,
  offReason: null,
  offByUser: false,
  ageMs: 0
}
const view = (patch: Partial<StatusBeat> | null, ageMs = 50): ReturnType<typeof deriveStatus> =>
  deriveStatus(patch === null ? null : { ...healthy, ...patch }, ageMs)

describe("the dashboard's notice line: only when something is wrong", () => {
  it('says nothing while protecting or smoothing normally', () => {
    expect(panelNotice({ view: view({}), sharpUnavailable: false })).toBeNull()
    expect(panelNotice({ view: view({ state: 'active' }), sharpUnavailable: false })).toBeNull()
  })

  it('says nothing when the user switched protection off: the switch shows it', () => {
    const v = view({
      state: 'disabled',
      overlayVisible: false,
      offReason: 'Switched off with Ctrl+Alt+Shift+C',
      offByUser: true
    })
    expect(v.status).toBe('off')
    expect(panelNotice({ view: v, sharpUnavailable: true })).toBeNull()
  })

  it('says it is not protecting, and why, for every other way to be off', () => {
    const cases: [Partial<StatusBeat> | null, number, RegExp][] = [
      [null, 0, /starting up/],
      [{}, 10_000, /the overlay stopped responding/],
      [
        { state: 'off', offReason: 'Detection failed: no WebGL2' },
        50,
        /detection failed: no WebGL2/
      ],
      [
        { state: 'disabled', overlayVisible: false, offReason: 'Screen capture failed: x' },
        50,
        /capture failed/
      ],
      [{ captureLive: false }, 50, /screen capture stopped/],
      [{ frameAgeMs: 5000 }, 50, /no frames from screen capture/]
    ]
    for (const [patch, age, text] of cases) {
      // Not protecting comes first, before the Keep motion sharp note.
      const n = panelNotice({ view: view(patch, age), sharpUnavailable: true })
      expect(n?.level).toBe('problem')
      expect(n?.text).toMatch(/^Not protecting: /)
      expect(n?.text).toMatch(text)
    }
  })

  it('says when Keep motion sharp fell back to smoothing', () => {
    expect(panelNotice({ view: view({}), sharpUnavailable: true })).toEqual({
      level: 'info',
      text: 'Keep motion sharp is not available on this computer, so CalmFrame smooths instead'
    })
  })
})
