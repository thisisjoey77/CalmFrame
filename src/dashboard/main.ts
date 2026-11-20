// Dashboard (docs/SPEC.md, Phase 5; redesigned as a small panel on Sat Nov 14, afternoon):
// the protection switch with a small status mark, the flashes-per-second graph with its
// latest value, the sensitivity and flash-limit sliders, and one notice line that appears
// only when something is wrong. No capture-rate warning: the user asked for none. A
// normal window since Sat Nov 14 evening: minimize it, or close it to the tray.
// "Ignore movement" and "Keep motion sharp" moved to the tray menu.
//
// It sits above the overlay and is excluded from capture, and nothing in it is smoothed,
// so nothing in it may blink.
import {
  DASHBOARD_GRAPH_MIN_Y_MAX,
  DASHBOARD_GRAPH_WINDOW_MS,
  DEFAULT_FLASH_LIMIT,
  FLASH_LIMIT_MAX,
  FLASH_LIMIT_MIN,
  SLIDER_EXAMPLE_HZ,
  STATUS_REFRESH_MS,
  strictTriggerCount
} from '../shared/config'
import type { StatusBeat } from '../shared/messages'
import { panelNotice } from '../shared/panelNotice'
import {
  DEFAULT_SETTINGS,
  SENSITIVITY_POSITIONS,
  predictedFlashesSeen,
  sensitivityPosition,
  type Sensitivity,
  type Settings
} from '../shared/settings'
import { KILL_SWITCH_LABEL, STATUS_LABEL, deriveStatus, type StatusView } from '../shared/status'
import { ScrollingGraph } from './graph'

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// ---------------------------------------------------------------------------
// Status: derived from the latest heartbeat and its age, never from a stored flag
// ---------------------------------------------------------------------------

const mark = $('mark')
const statusText = $('status-text')
const protectionSwitch = $<HTMLButtonElement>('protection')
const protectionLabel = $('protection-label')
const notice = $('notice')

let beat: StatusBeat | null = null
let beatAt = 0
let shownView: StatusView | null = null
let shownNotice = ''
/** "Keep motion sharp" is on (set from the tray menu), and whether the overlay still draws
 *  with smoothing, i.e. the correction pass failed its startup check on this computer. */
let keepSharp = DEFAULT_SETTINGS.mitigation === 'correct'
let sharpUnavailable = false
/** When the setting last changed. The overlay's reports from just before a change still
 *  name the old method, so they are not held against the new setting. */
let sharpChangedAt = -Infinity

protectionSwitch.title = `${KILL_SWITCH_LABEL} switches protection off and on from anywhere.`

function setSwitch(on: boolean): void {
  protectionSwitch.setAttribute('aria-checked', String(on))
  protectionLabel.textContent = on ? 'On' : 'Off'
}

function renderStatus(): void {
  const age = beat === null ? Infinity : performance.now() - beatAt + beat.ageMs
  const view = deriveStatus(beat, age)
  if (shownView === null || shownView.status !== view.status) {
    mark.setAttribute('class', view.status)
    statusText.textContent = STATUS_LABEL[view.status]
  }
  // The switch follows the overlay only when the overlay's answer changes, so a click is
  // not undone while main is still switching.
  if (shownView === null || shownView.switchOn !== view.switchOn) setSwitch(view.switchOn)
  shownView = view

  const n = panelNotice({ view, sharpUnavailable: keepSharp && sharpUnavailable })
  const key = n === null ? '' : `${n.level}|${n.text}`
  if (key !== shownNotice) {
    shownNotice = key
    notice.hidden = n === null
    notice.className = n?.level ?? ''
    notice.textContent = n?.text ?? ''
  }
}

api.onStatusBeat((b) => {
  beat = b
  beatAt = performance.now()
  renderStatus()
})
// Re-derive even when no heartbeat arrives: silence is what turns the status off.
setInterval(renderStatus, STATUS_REFRESH_MS)

protectionSwitch.addEventListener('click', () => {
  const want = protectionSwitch.getAttribute('aria-checked') !== 'true'
  setSwitch(want)
  api
    .setProtection(want)
    .catch(() => false)
    .then((accepted) => {
      if (!accepted) setSwitch(shownView?.switchOn ?? false)
    })
})

// ---------------------------------------------------------------------------
// Flashes per second: the graph, and its latest value as a number
// ---------------------------------------------------------------------------

const graph = new ScrollingGraph($<HTMLCanvasElement>('graph'), {
  windowMs: DASHBOARD_GRAPH_WINDOW_MS,
  minYMax: DASHBOARD_GRAPH_MIN_Y_MAX,
  fontPx: 12,
  lineWidth: 2,
  axisLabels: false
})
graph.draw()
window.addEventListener('resize', () => graph.draw())

const rateValue = $('rate-value')
let shownRate = ''

/** The graph value comes in steps of a half (Step 8: k / 2), so it is shown exactly. */
const rateText = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1))

api.onDetectionStats((s) => {
  const settled = performance.now() - sharpChangedAt > STATUS_REFRESH_MS
  sharpUnavailable = settled && keepSharp && s.smoothing.method !== 'correct'
  graph.push(s.tMs, s.graphValue, s.hazard)
  if (document.hidden) return
  graph.draw()
  const text = rateText(s.graphValue)
  if (text !== shownRate) {
    shownRate = text
    rateValue.textContent = text
  }
})

// ---------------------------------------------------------------------------
// Controls: sensitivity and the flash limit, saved by main
// ---------------------------------------------------------------------------

const slider = $<HTMLInputElement>('sensitivity')
const sensitivityName = $('sensitivity-name')
const sensitivityDesc = $('sensitivity-desc')
const flashLimit = $<HTMLInputElement>('flash-limit')
const flashLimitName = $('flash-limit-name')
/** The flash limit in force, which the strict position's words and the prediction use. */
let limitInForce = DEFAULT_FLASH_LIMIT

flashLimit.min = String(FLASH_LIMIT_MIN)
flashLimit.max = String(FLASH_LIMIT_MAX)
$('flash-limit-min').textContent = String(FLASH_LIMIT_MIN)
$('flash-limit-max').textContent = String(FLASH_LIMIT_MAX)
slider.max = String(SENSITIVITY_POSITIONS.length - 1)

/** The flash limit's name. "WCAG" only at the standard's limit: above it the app no longer
 *  implements the WCAG threshold, so the word would be wrong (the user chose no warning
 *  text, Sat Nov 14). */
function describeFlashLimit(limit: number): void {
  const name = limit === DEFAULT_FLASH_LIMIT ? `${limit} a second (WCAG)` : `${limit} a second`
  flashLimitName.textContent = name
  flashLimit.setAttribute('aria-valuetext', name)
}

/** A slider position's short name, and its trade-off in a sentence for the tooltip. */
function sensitivityText(s: Sensitivity): { name: string; what: string } {
  if (s.trigger === 'strict') {
    return {
      name: 'Strict',
      what: `Only a clear violation: ${strictTriggerCount(limitInForce)} fast changes in a second.`
    }
  }
  const position = sensitivityPosition(s)
  const standard = sensitivityPosition(DEFAULT_SETTINGS.sensitivity)
  if (position < standard) {
    return {
      name: 'Most sensitive',
      what: `Smooths on fast change ${s.streakN}. Scene cuts set it off more often.`
    }
  }
  if (position === standard) {
    return { name: 'Standard', what: `Smooths on fast change ${s.streakN} (the default).` }
  }
  return {
    name: 'Fewer false alarms',
    what: `Waits for fast change ${s.streakN}. Game camera turns and tab switches set it off less.`
  }
}

function describeSensitivity(s: Sensitivity): void {
  const { name, what } = sensitivityText(s)
  const seen = predictedFlashesSeen(s, undefined, undefined, limitInForce).toFixed(1)
  const description = `${what} Predicted: about ${seen} flashes of a ${SLIDER_EXAMPLE_HZ} Hz strobe get through first.`
  sensitivityName.textContent = name
  sensitivityDesc.textContent = description
  slider.title = description
  slider.setAttribute('aria-valuetext', name)
}

function applySettings(s: Settings): void {
  limitInForce = s.flashLimit
  flashLimit.value = String(s.flashLimit)
  describeFlashLimit(s.flashLimit)
  graph.setLimit(s.flashLimit)
  if (!document.hidden) graph.draw()
  slider.value = String(sensitivityPosition(s.sensitivity))
  describeSensitivity(s.sensitivity)
  const sharp = s.mitigation === 'correct'
  if (sharp !== keepSharp) {
    keepSharp = sharp
    sharpChangedAt = performance.now()
    sharpUnavailable = false
  }
  renderStatus()
}

// 'input' while dragging only updates the words; 'change' (release, or each arrow key
// step) sends the setting, so the detector is not rebuilt at every step of a drag.
slider.addEventListener('input', () => {
  describeSensitivity(SENSITIVITY_POSITIONS[Number(slider.value)])
})
slider.addEventListener('change', () => {
  api.updateSettings({ sensitivity: SENSITIVITY_POSITIONS[Number(slider.value)] })
})
flashLimit.addEventListener('input', () => describeFlashLimit(Number(flashLimit.value)))
flashLimit.addEventListener('change', () => {
  api.updateSettings({ flashLimit: Number(flashLimit.value) })
})
api.onSettings(applySettings)

// ---------------------------------------------------------------------------
// The window is as tall as the panel: main fits it to the height reported here
// ---------------------------------------------------------------------------

const panel = $('panel')
let reportedHeight = 0
new ResizeObserver(() => {
  const height = Math.ceil(panel.getBoundingClientRect().height)
  if (height === reportedHeight) return
  reportedHeight = height
  api.fitDashboard(height)
}).observe(panel)

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

applySettings(DEFAULT_SETTINGS)
api
  .getInit()
  .then((init) => applySettings(init.settings))
  .catch((error) => console.error('[dashboard] could not load the settings', error))
