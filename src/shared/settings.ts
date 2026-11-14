/**
 * The user's settings (docs/SPEC.md, Phase 5): the sensitivity slider, the "Ignore
 * movement" switch and where the dashboard sits. Main keeps them in a JSON file in the
 * app's userData folder, so they persist across restarts.
 *
 * Protection itself is not a setting: it starts on at every launch. A switch left off by
 * accident must not leave someone unprotected after a restart.
 *
 * Everything that arrives from the file or a renderer goes through these validators, so a
 * damaged file or a bad message falls back to the defaults field by field.
 */

import type { DetectorOptions } from '../core/detector'
import {
  DASHBOARD_MIN_HEIGHT,
  DASHBOARD_MIN_WIDTH,
  DEFAULT_CONCURRENCY_RULE,
  EARLY_TRIGGER_STREAK,
  SENSITIVITY_STREAK_STEPS,
  SLIDER_EXAMPLE_HZ,
  SLIDER_EXAMPLE_LATENCY_MS,
  STRICT_TRIGGER_COUNT,
  type ConcurrencyRule
} from './config'

/** One position of the sensitivity slider (Step 7): the early trigger at some N, or
 *  strict. */
export type Sensitivity = { trigger: 'early'; streakN: number } | { trigger: 'strict' }

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Settings {
  sensitivity: Sensitivity
  /** The Step 5a concurrency rule: 'one-way' is "Ignore movement" ticked. */
  concurrency: ConcurrencyRule
  /** Where the dashboard was last left, in DIP. Null until it has been moved or resized. */
  dashboardBounds: WindowBounds | null
}

/** The slider's positions, most sensitive first: the early trigger at each N in
 *  SENSITIVITY_STREAK_STEPS, then strict. No pre-arm position (decided Sat Nov 14). */
export const SENSITIVITY_POSITIONS: readonly Sensitivity[] = [
  ...SENSITIVITY_STREAK_STEPS.map((streakN): Sensitivity => ({ trigger: 'early', streakN })),
  { trigger: 'strict' }
]

export const DEFAULT_SENSITIVITY: Sensitivity = {
  trigger: 'early',
  streakN: EARLY_TRIGGER_STREAK
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: DEFAULT_SENSITIVITY,
  concurrency: DEFAULT_CONCURRENCY_RULE,
  dashboardBounds: null
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The slider position of a sensitivity, or -1 if it is not one of them. */
export function sensitivityPosition(s: Sensitivity): number {
  return SENSITIVITY_POSITIONS.findIndex((p) =>
    p.trigger === 'strict'
      ? s.trigger === 'strict'
      : s.trigger === 'early' && s.streakN === p.streakN
  )
}

/** A sensitivity from untrusted input, or null if it is not one of the slider's. */
export function parseSensitivity(raw: unknown): Sensitivity | null {
  if (!isObject(raw)) return null
  if (raw.trigger === 'strict') return { trigger: 'strict' }
  if (raw.trigger === 'early' && typeof raw.streakN === 'number') {
    const s: Sensitivity = { trigger: 'early', streakN: raw.streakN }
    return sensitivityPosition(s) >= 0 ? s : null
  }
  return null
}

function parseConcurrency(raw: unknown): ConcurrencyRule | null {
  return raw === 'one-way' || raw === 'off' ? raw : null
}

/** Window bounds from untrusted input, or null. Whether they are on a screen is for main
 *  to check against the displays. */
export function parseBounds(raw: unknown): WindowBounds | null {
  if (!isObject(raw)) return null
  const { x, y, width, height } = raw
  const ints = [x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))
  if (!ints) return null
  const b = { x, y, width, height } as WindowBounds
  if (b.width < DASHBOARD_MIN_WIDTH || b.height < DASHBOARD_MIN_HEIGHT) return null
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
}

/** Settings from the file, field by field: anything missing or invalid takes its default. */
export function parseSettings(raw: unknown): Settings {
  const r = isObject(raw) ? raw : {}
  return {
    sensitivity: parseSensitivity(r.sensitivity) ?? DEFAULT_SETTINGS.sensitivity,
    concurrency: parseConcurrency(r.concurrency) ?? DEFAULT_SETTINGS.concurrency,
    dashboardBounds: parseBounds(r.dashboardBounds)
  }
}

/** A change from a renderer, applied to the current settings. Fields it does not name, or
 *  names with an invalid value, stay as they were. */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (!isObject(patch)) return current
  const next = { ...current }
  if ('sensitivity' in patch)
    next.sensitivity = parseSensitivity(patch.sensitivity) ?? current.sensitivity
  if ('concurrency' in patch)
    next.concurrency = parseConcurrency(patch.concurrency) ?? current.concurrency
  if ('dashboardBounds' in patch) {
    next.dashboardBounds = parseBounds(patch.dashboardBounds) ?? current.dashboardBounds
  }
  return next
}

/** The detector options the settings ask for. */
export function detectorOptionsFor(
  settings: Settings
): Pick<DetectorOptions, 'trigger' | 'streakN' | 'concurrency'> {
  const s = settings.sensitivity
  return s.trigger === 'early'
    ? { trigger: 'early', streakN: s.streakN, concurrency: settings.concurrency }
    : { trigger: 'strict', concurrency: settings.concurrency }
}

/** Fast reversals a cell needs before it counts as hot: N for the early trigger, the 1 s
 *  count for strict (Step 7). */
export function transitionsToTrigger(s: Sensitivity): number {
  return s.trigger === 'early' ? s.streakN : STRICT_TRIGGER_COUNT
}

/**
 * The spec's prediction of flashes seen before smoothing starts (Step 7):
 * F = (N - 1) / 2 + f L. With the defaults, a 10 Hz strobe and 75 ms of latency, that is
 * 1.75 at N = 3 and 3.75 for strict, as in the spec's table. A prediction: the Phase 6
 * slow-motion measurement replaces it.
 */
export function predictedFlashesSeen(
  s: Sensitivity,
  frequencyHz = SLIDER_EXAMPLE_HZ,
  latencyMs = SLIDER_EXAMPLE_LATENCY_MS
): number {
  return (transitionsToTrigger(s) - 1) / 2 + (frequencyHz * latencyMs) / 1000
}
