// Dashboard (docs/SPEC.md, Phase 5): status, graph, thumbnails, event log and controls.
// It sits above the overlay and is excluded from capture, so it stays sharp and live while
// the rest of the screen is smoothed. Nothing in it is smoothed, so nothing in it may flash
// over a hazardous area: the thumbnails are capped under the area limit, and the protected
// preview shows a picture only while the overlay is drawing its smoothed copy.
import {
  DASHBOARD_GRAPH_MIN_Y_MAX,
  DASHBOARD_GRAPH_WINDOW_MS,
  DEFAULT_FLASH_LIMIT,
  EVENT_LOG_MAX,
  FLASH_LIMIT_MAX,
  FLASH_LIMIT_MIN,
  FPS_WINDOW_MS,
  LOW_FPS_WARNING,
  LOW_FPS_WARNING_HOLD_MS,
  SLIDER_EXAMPLE_HZ,
  STATUS_REFRESH_MS,
  strictTriggerCount
} from '../shared/config'
import { flashEventText } from '../shared/eventText'
import type { CaptureStats, FlashEventMessage, StatusBeat } from '../shared/messages'
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
import { GridThumbnail } from './thumbnail'

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const EMPTY_THUMBNAIL = '#1c2128'

// ---------------------------------------------------------------------------
// Status: derived from the latest heartbeat and its age, never from a stored flag
// ---------------------------------------------------------------------------

const statusCard = $('status')
const statusWord = $('status-word')
const statusDetail = $('status-detail')
const protectionSwitch = $<HTMLButtonElement>('protection')
const protectionLabel = $('protection-label')
const fpsWarning = $('fps-warning')

let beat: StatusBeat | null = null
let beatAt = 0
let shownView: StatusView | null = null
let shownDetail = ''
/** The latest full-second capture rate, or null before the first. */
let captureFps: number | null = null
/** When the capture rate was last under LOW_FPS_WARNING, and what it was. */
let lowFpsAt = -Infinity
let lowFps = 0

function setSwitch(on: boolean): void {
  protectionSwitch.setAttribute('aria-checked', String(on))
  protectionLabel.textContent = on ? 'On' : 'Off'
}

function renderStatus(): void {
  const age = beat === null ? Infinity : performance.now() - beatAt + beat.ageMs
  const view = deriveStatus(beat, age)
  const detail =
    view.status === 'protected' && captureFps !== null
      ? `${view.detail} at ${captureFps} fps`
      : view.detail
  if (shownView === null || shownView.status !== view.status) {
    statusCard.className = view.status
    statusWord.textContent = STATUS_LABEL[view.status]
  }
  if (detail !== shownDetail) {
    statusDetail.textContent = detail
    shownDetail = detail
  }
  // The switch follows the overlay only when the overlay's answer changes, so a click is
  // not undone while main is still switching.
  if (shownView === null || shownView.switchOn !== view.switchOn) setSwitch(view.switchOn)
  shownView = view

  // The capture-rate warning ("Known behaviour at the edges"), held for a few seconds so a
  // rate hovering at the line doesn't make it come and go. Not shown while protection is
  // off: the status already says why.
  const lowNow = performance.now() - lowFpsAt < LOW_FPS_WARNING_HOLD_MS && view.status !== 'off'
  if (lowNow) {
    fpsWarning.textContent = `Capture at ${lowFps} fps, under ${LOW_FPS_WARNING}: fast flashing may be caught late. Use mains power and Turbo mode.`
  }
  fpsWarning.hidden = !lowNow
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

api.onCaptureStats((s: CaptureStats) => {
  // The rate counts over a rolling second, so the first second's readings are partial.
  if (s.runningMs < FPS_WINDOW_MS) return
  captureFps = s.fps
  if (s.fps < LOW_FPS_WARNING) {
    lowFpsAt = performance.now()
    lowFps = s.fps
  }
})

// ---------------------------------------------------------------------------
// Graph and thumbnails
// ---------------------------------------------------------------------------

const graph = new ScrollingGraph($<HTMLCanvasElement>('graph'), {
  windowMs: DASHBOARD_GRAPH_WINDOW_MS,
  minYMax: DASHBOARD_GRAPH_MIN_Y_MAX,
  fontPx: 12,
  lineWidth: 2
})
graph.draw()
window.addEventListener('resize', () => graph.draw())

/** When the box was last changed. The overlay's reports from just before a change still
 *  name the old method, so they are not held against the new setting. */
let sharpChangedAt = -Infinity

api.onDetectionStats((s) => {
  const settled = performance.now() - sharpChangedAt > STATUS_REFRESH_MS
  const unavailable = settled && keepSharp.checked && s.smoothing.method !== 'correct'
  if (unavailable !== sharpUnavailable) {
    sharpUnavailable = unavailable
    describeSharp()
  }
  graph.push(s.tMs, s.graphValue, s.hazard)
  if (!document.hidden) graph.draw()
})

const raw = new GridThumbnail($<HTMLCanvasElement>('raw'), EMPTY_THUMBNAIL)
const preview = new GridThumbnail($<HTMLCanvasElement>('preview'), EMPTY_THUMBNAIL)
const previewIdle = $('preview-idle')
let previewShowing = false

api.onThumbnails((t) => {
  if (document.hidden) return
  raw.draw(t.raw)
  if (t.seen) {
    preview.draw(t.seen)
    if (!previewShowing) previewIdle.hidden = true
    previewShowing = true
  } else if (previewShowing) {
    preview.clear()
    previewIdle.hidden = false
    previewShowing = false
  }
})

// ---------------------------------------------------------------------------
// Controls: sensitivity and Ignore movement, saved by main
// ---------------------------------------------------------------------------

const slider = $<HTMLInputElement>('sensitivity')
const sensitivityName = $('sensitivity-name')
const sensitivityDesc = $('sensitivity-desc')
const movement = $<HTMLInputElement>('ignore-movement')
const flashLimit = $<HTMLInputElement>('flash-limit')
const flashLimitName = $('flash-limit-name')
const flashLimitDesc = $('flash-limit-desc')
const graphTitle = $('graph-title')
/** The flash limit in force, which the strict position's words and the prediction use. */
let limitInForce = DEFAULT_FLASH_LIMIT

flashLimit.min = String(FLASH_LIMIT_MIN)
flashLimit.max = String(FLASH_LIMIT_MAX)

/** The words for a flash limit. Above the standard's 3 they say plainly what is given up. */
function describeFlashLimit(limit: number): void {
  const standard = limit === DEFAULT_FLASH_LIMIT
  const name = standard ? `${limit} a second (WCAG)` : `${limit} a second (testing)`
  flashLimitName.textContent = name
  flashLimit.setAttribute('aria-valuetext', name)
  flashLimitDesc.textContent = standard
    ? 'The WCAG limit: more than 3 flashes in a second is a hazard. Raise it only to test.'
    : `Not the WCAG limit: flashing between 3 and ${limit} times a second is now let through. Back to 3 when CalmFrame restarts.`
  flashLimitDesc.classList.toggle('raised', !standard)
}
const keepSharp = $<HTMLInputElement>('keep-sharp')
const sharpDesc = $('sharp-desc')
const SHARP_HINT =
  'Shows the current picture and steadies the brightness of each region, with no blending of ' +
  'old frames. For testing: a thin rim can still flicker at a hard edge.'
/** The overlay reports the method it draws with. If the box is ticked and it still says
 *  smoothing, the new pass failed its startup check on this computer. */
let sharpUnavailable = false

function describeSharp(): void {
  sharpDesc.textContent =
    keepSharp.checked && sharpUnavailable
      ? 'Not available: the new pass failed its startup check on this computer, so the usual smoothing is used.'
      : SHARP_HINT
}

slider.max = String(SENSITIVITY_POSITIONS.length - 1)

/** The name and the trade-off of a slider position, and the spec's predicted flashes. */
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
      name: `Most sensitive, ${s.streakN} changes`,
      what: `Smooths on fast change ${s.streakN}. Scene cuts set it off more often.`
    }
  }
  if (position === standard) {
    return {
      name: `Standard, ${s.streakN} changes`,
      what: `Smooths on fast change ${s.streakN} (the default).`
    }
  }
  return {
    name: `Fewer false alarms, ${s.streakN} changes`,
    what: `Waits for fast change ${s.streakN}. Game camera turns and tab switches set it off less.`
  }
}

function describeSensitivity(s: Sensitivity): void {
  const { name, what } = sensitivityText(s)
  const seen = predictedFlashesSeen(s, undefined, undefined, limitInForce).toFixed(1)
  sensitivityName.textContent = name
  sensitivityDesc.textContent = `${what} Predicted: about ${seen} flashes of a ${SLIDER_EXAMPLE_HZ} Hz strobe get through first.`
  slider.setAttribute('aria-valuetext', name)
}

function applySettings(s: Settings): void {
  limitInForce = s.flashLimit
  flashLimit.value = String(s.flashLimit)
  describeFlashLimit(s.flashLimit)
  graph.setLimit(s.flashLimit)
  graphTitle.textContent =
    s.flashLimit === DEFAULT_FLASH_LIMIT
      ? `Flashes per second, limit ${s.flashLimit} (WCAG 2.3.1)`
      : `Flashes per second, limit ${s.flashLimit} (testing; WCAG is ${DEFAULT_FLASH_LIMIT})`
  if (!document.hidden) graph.draw()
  slider.value = String(sensitivityPosition(s.sensitivity))
  describeSensitivity(s.sensitivity)
  movement.checked = s.concurrency === 'one-way'
  keepSharp.checked = s.mitigation === 'correct'
  describeSharp()
}

// 'input' while dragging only updates the words; 'change' (release, or each arrow key
// step) sends the setting, so the detector is not rebuilt at every step of a drag.
slider.addEventListener('input', () => {
  describeSensitivity(SENSITIVITY_POSITIONS[Number(slider.value)])
})
slider.addEventListener('change', () => {
  api.updateSettings({ sensitivity: SENSITIVITY_POSITIONS[Number(slider.value)] })
})
movement.addEventListener('change', () => {
  api.updateSettings({ concurrency: movement.checked ? 'one-way' : 'off' })
})
// As for the sensitivity: words while dragging, the setting on release.
flashLimit.addEventListener('input', () => describeFlashLimit(Number(flashLimit.value)))
flashLimit.addEventListener('change', () => {
  api.updateSettings({ flashLimit: Number(flashLimit.value) })
})
keepSharp.addEventListener('change', () => {
  sharpChangedAt = performance.now()
  sharpUnavailable = false
  describeSharp()
  api.updateSettings({ mitigation: keepSharp.checked ? 'correct' : 'smooth' })
})
api.onSettings(applySettings)

// ---------------------------------------------------------------------------
// Event log and counter
// ---------------------------------------------------------------------------

const eventList = $('events')
const counterValue = $('counter-value')
const lines = new Map<number, HTMLLIElement>()
const smoothedIds = new Set<number>()
let startedAtWallMs = performance.timeOrigin

api.onFlashEvent((e: FlashEventMessage) => {
  let li = lines.get(e.id)
  if (!li) {
    if (lines.size === 0) eventList.textContent = ''
    li = document.createElement('li')
    eventList.prepend(li)
    lines.set(e.id, li)
    while (eventList.childElementCount > EVENT_LOG_MAX) {
      const last = eventList.lastElementChild as HTMLLIElement
      for (const [id, el] of lines) if (el === last) lines.delete(id)
      last.remove()
    }
  }
  li.textContent = flashEventText(e, startedAtWallMs)
  li.title = `Started at ${new Date(e.startWallMs).toLocaleTimeString()}`
  if (e.smoothed && !smoothedIds.has(e.id)) {
    smoothedIds.add(e.id)
    counterValue.textContent = String(smoothedIds.size)
  }
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('kill-switch').textContent = KILL_SWITCH_LABEL
applySettings(DEFAULT_SETTINGS)
renderStatus()
api
  .getInit()
  .then((init) => {
    startedAtWallMs = init.startedAtWallMs
    applySettings(init.settings)
  })
  .catch((error) => console.error('[dashboard] could not load the settings', error))
