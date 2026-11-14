/**
 * The protection status shown in the dashboard and the tray (docs/SPEC.md, Phase 5):
 * Protected, Smoothing or Protection off. "Never show Protected unless frames are flowing"
 * ("Safety mechanisms").
 *
 * Derived each time from the latest heartbeat and its age, never from a stored flag. Every
 * condition below can only turn the status off, so a missing or stale heartbeat, a hidden
 * overlay or a stalled capture all read as "Protection off". A heartbeat that stops
 * arriving turns the status off after WATCHDOG_MS, the same silence after which the
 * watchdog hides the overlay.
 */

import { FRAME_STALE_MS, KILL_SWITCH_ACCELERATOR, WATCHDOG_MS } from './config'
import type { StatusBeat } from './messages'

export type ProtectionStatus = 'protected' | 'smoothing' | 'off'

export interface StatusView {
  status: ProtectionStatus
  /** One line saying why, for the dashboard and the tray tooltip. */
  detail: string
  /** The on/off switch as the overlay reports it: off when the user or a failure switched
   *  protection off, or when the overlay cannot be heard from. */
  switchOn: boolean
}

/** The overlay states in which it is drawing a smoothed copy, fully or fading. Armed and
 *  Disarming belong to the optional pre-arm (Step 7a). */
const SMOOTHING_STATES: ReadonlySet<string> = new Set(['active', 'release', 'armed', 'disarming'])

/** The kill switch as a person types it: Ctrl+Alt+Shift+C. */
export const KILL_SWITCH_LABEL = KILL_SWITCH_ACCELERATOR.replace('Control', 'Ctrl')

const off = (detail: string, switchOn: boolean): StatusView => ({
  status: 'off',
  detail,
  switchOn
})

/**
 * @param beat the latest heartbeat as main relayed it, or null before the first
 * @param beatAgeMs how long ago it arrived, on the receiver's clock
 */
export function deriveStatus(beat: StatusBeat | null, beatAgeMs: number): StatusView {
  if (beat === null) return off('Starting up', false)
  if (!(beatAgeMs <= WATCHDOG_MS)) return off('The overlay stopped responding', false)
  if (beat.state === 'off') return off(beat.offReason ?? 'Detection failed', false)
  if (beat.state === 'disabled') return off(beat.offReason ?? 'Switched off', false)
  // Main hides the overlay first and tells the renderer after, so for a moment the
  // renderer can still report a running state over a hidden overlay.
  if (!beat.overlayVisible) {
    return off(beat.offReason ?? 'The overlay is hidden', beat.offReason === null)
  }
  if (!beat.captureLive) return off('Screen capture stopped', true)
  if (beat.frameAgeMs === null) return off('Waiting for the first frame', true)
  if (!(beat.frameAgeMs <= FRAME_STALE_MS)) {
    return off(`No frames from screen capture for ${(beat.frameAgeMs / 1000).toFixed(1)} s`, true)
  }
  if (SMOOTHING_STATES.has(beat.state)) {
    return {
      status: 'smoothing',
      detail: 'Flashing found. You see a smoothed copy',
      switchOn: true
    }
  }
  return { status: 'protected', detail: 'Watching the whole screen', switchOn: true }
}

/** The status as a word or two: what the dashboard, the tray and the logs print. */
export const STATUS_LABEL: Record<ProtectionStatus, string> = {
  protected: 'Protected',
  smoothing: 'Smoothing',
  off: 'Protection off'
}
