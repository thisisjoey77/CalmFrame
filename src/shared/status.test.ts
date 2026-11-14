import { describe, expect, it } from 'vitest'
import { FRAME_STALE_MS, WATCHDOG_MS } from './config'
import type { StatusBeat } from './messages'
import { KILL_SWITCH_LABEL, deriveStatus } from './status'

/** A healthy heartbeat: running, overlay shown, frames arriving. */
const healthy: StatusBeat = {
  state: 'safe',
  frameAgeMs: 20,
  captureLive: true,
  overlayVisible: true,
  offReason: null
}
const beat = (patch: Partial<StatusBeat>): StatusBeat => ({ ...healthy, ...patch })

describe('protection status (Phase 5): derived from the heartbeat, never wrong', () => {
  it('reads Protected only when everything is running and frames are flowing', () => {
    const v = deriveStatus(healthy, 100)
    expect(v.status).toBe('protected')
    expect(v.switchOn).toBe(true)
  })

  it('reads Smoothing while the overlay draws the smoothed copy, including the fade', () => {
    for (const state of ['active', 'release'] as const) {
      expect(deriveStatus(beat({ state }), 100).status).toBe('smoothing')
    }
  })

  it('reads Smoothing for the pre-arm states too, which also draw a smoothed copy', () => {
    for (const state of ['armed', 'disarming'] as const) {
      expect(deriveStatus(beat({ state }), 100).status).toBe('smoothing')
    }
  })

  it('reads off before the first heartbeat', () => {
    expect(deriveStatus(null, 0)).toMatchObject({ status: 'off', switchOn: false })
  })

  it('reads off once heartbeats stop for the watchdog time, whatever the last one said', () => {
    expect(deriveStatus(healthy, WATCHDOG_MS).status).toBe('protected')
    for (const state of ['safe', 'active'] as const) {
      const v = deriveStatus(beat({ state }), WATCHDOG_MS + 1)
      expect(v).toMatchObject({ status: 'off', switchOn: false })
      expect(v.detail).toMatch(/stopped responding/)
    }
    expect(deriveStatus(healthy, Infinity).status).toBe('off')
    expect(deriveStatus(healthy, NaN).status).toBe('off')
  })

  it('reads off when the pipeline failed open, with the reason main gave', () => {
    const v = deriveStatus(beat({ state: 'off', offReason: 'Detection failed: no WebGL2' }), 50)
    expect(v).toMatchObject({ status: 'off', switchOn: false })
    expect(v.detail).toBe('Detection failed: no WebGL2')
  })

  it('reads off when switched off, with the switch shown off', () => {
    const reason = `Switched off with ${KILL_SWITCH_LABEL}`
    const v = deriveStatus(
      beat({ state: 'disabled', overlayVisible: false, offReason: reason }),
      50
    )
    expect(v).toEqual({ status: 'off', detail: reason, switchOn: false })
  })

  it('reads off as soon as main hides the overlay, before the renderer has heard', () => {
    const v = deriveStatus(beat({ overlayVisible: false, offReason: 'Switched off' }), 50)
    expect(v).toMatchObject({ status: 'off', switchOn: false })
    // Hidden for no stated reason, e.g. before it is first shown: off, but not switched off.
    expect(deriveStatus(beat({ overlayVisible: false }), 50)).toMatchObject({
      status: 'off',
      switchOn: true
    })
  })

  it('reads off when the capture has stopped or no frame has arrived', () => {
    expect(deriveStatus(beat({ captureLive: false }), 50).status).toBe('off')
    expect(deriveStatus(beat({ frameAgeMs: null }), 50).status).toBe('off')
  })

  it('reads off when frames stop flowing, even while smoothing', () => {
    expect(deriveStatus(beat({ frameAgeMs: FRAME_STALE_MS }), 50).status).toBe('protected')
    for (const state of ['safe', 'active'] as const) {
      const v = deriveStatus(beat({ state, frameAgeMs: FRAME_STALE_MS + 1 }), 50)
      expect(v.status).toBe('off')
      expect(v.detail).toMatch(/No frames/)
    }
  })

  it('puts the kill switch the way a person types it', () => {
    expect(KILL_SWITCH_LABEL).toBe('Ctrl+Alt+Shift+C')
  })
})
