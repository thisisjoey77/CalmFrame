/**
 * One line of the dashboard's event log (docs/SPEC.md, Phase 5): "0:42, 8 Hz, 2.1 s,
 * smoothed". The time counts from the app's start.
 */

import type { FlashEventMessage } from './messages'

/** Elapsed time as m:ss, or h:mm:ss from an hour on. Negative times read as 0:00. */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function flashEventText(e: FlashEventMessage, startedAtWallMs: number): string {
  const when = elapsedText(e.startWallMs - startedAtWallMs)
  const rate = e.frequencyHz > 0 ? `${Math.round(e.frequencyHz)} Hz` : 'rate unknown'
  const kind = e.type === 'red' ? `${rate} red` : rate
  let length = 'ongoing'
  if (e.kind === 'end' && e.durationMs !== null) {
    length = e.durationMs < 100 ? 'under 0.1 s' : `${(e.durationMs / 1000).toFixed(1)} s`
  }
  let outcome = 'not smoothed (protection off)'
  if (e.smoothed) outcome = e.kind === 'end' ? 'smoothed' : 'smoothing'
  return `${when}, ${kind}, ${length}, ${outcome}`
}
