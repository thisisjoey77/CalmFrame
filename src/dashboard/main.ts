// Dashboard (docs/SPEC.md, Phase 5): status, graph, thumbnails, event log and controls.
// It sits above the overlay and is excluded from capture, so it stays sharp and live while
// the rest of the screen is smoothed. Nothing in it is smoothed, so nothing in it may flash
// over a hazardous area: the thumbnails are capped under the area limit, and the protected
// preview shows a picture only while the overlay is drawing its smoothed copy.
import {
  DASHBOARD_GRAPH_MIN_Y_MAX,
  DASHBOARD_GRAPH_WINDOW_MS,
  EVENT_LOG_MAX,
  FPS_WINDOW_MS,
  LOW_FPS_WARNING,
  LOW_FPS_WARNING_HOLD_MS,
  SLIDER_EXAMPLE_HZ,
  STATUS_REFRESH_MS,
  STRICT_TRIGGER_COUNT
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
  protectionLabel.textContent = on ? 'Protection on' : 'Protection off'
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
    fpsWarning.textContent = `Screen capture is running at ${lowFps} fps, under ${LOW_FPS_WARNING}. Fast flashing may be caught late. Use mains power and Turbo mode, and close heavy apps.`
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

api.onDetectionStats((s) => {
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

slider.max = String(SENSITIVITY_POSITIONS.length - 1)

/** The name and the trade-off of a slider position, and the spec's predicted flashes. */
function sensitivityText(s: Sensitivity): { name: string; what: string } {
  if (s.trigger === 'strict') {
    return {
      name: 'Strict',
      what: `Smooths only a clear violation: ${STRICT_TRIGGER_COUNT} fast changes within a second, more than 3 flashes.`
    }
  }
  const position = sensitivityPosition(s)
  const standard = sensitivityPosition(DEFAULT_SETTINGS.sensitivity)
  if (position < standard) {
    return {
      name: `Most sensitive (${s.streakN} fast changes)`,
      what: `Smooths on fast change ${s.streakN}. Scene cuts and explosions set it off more often.`
    }
  }
  if (position === standard) {
    return {
      name: `Standard (${s.streakN} fast changes)`,
      what: `Smooths on fast change ${s.streakN}, the default, from the WCAG limit of 3 flashes a second.`
    }
  }
  return {
    name: `Fewer false alarms (${s.streakN} fast changes)`,
    what: `Waits for fast change ${s.streakN}. Fast scrolling, game camera turns and tab switches set it off less often.`
  }
}

function describeSensitivity(s: Sensitivity): void {
  const { name, what } = sensitivityText(s)
  const seen = predictedFlashesSeen(s).toFixed(1)
  sensitivityName.textContent = name
  sensitivityDesc.textContent = `${what} Predicted: about ${seen} flashes of a ${SLIDER_EXAMPLE_HZ} Hz strobe reach you before smoothing starts.`
  slider.setAttribute('aria-valuetext', name)
}

function applySettings(s: Settings): void {
  slider.value = String(sensitivityPosition(s.sensitivity))
  describeSensitivity(s.sensitivity)
  movement.checked = s.concurrency === 'one-way'
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
