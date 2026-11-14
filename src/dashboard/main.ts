// Debug window: Phase 0 capture tools plus Phase 3 live detection. Phase 5 replaces it
// with the real dashboard.
import {
  ANALYSIS_BUDGET_MS,
  CAPTURE_FPS,
  CAPTURE_MAX_WIDTH,
  CAPTURE_MAX_HEIGHT,
  DEBUG_CAPTURE_SIZES,
  DEBUG_HAZARD_LOG_MAX,
  PHASE0_MIN_FPS
} from '../shared/config'
import type {
  CaptureStats,
  DetectionStats,
  HazardEvent,
  SelfCheckResult,
  Timing
} from '../shared/messages'
import { openScreenStream } from '../overlay/capture'
import { ScrollingGraph } from './graph'

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function setCell(id: string, text: string, cls?: 'ok' | 'bad' | 'warn'): void {
  const el = $(id)
  el.textContent = text
  el.className = cls ?? ''
}

// Preview: lets the user see what capture sees. Off by default. Chromium shares one
// capture device per screen and the first stream opened sets its format for every
// stream (Phase 0: a small slow preview opened first dragged the overlay down to
// 480x270 at 15 fps). So the preview asks for exactly the overlay's settings.
const preview = $<HTMLVideoElement>('preview')
let previewStream: MediaStream | null = null

async function startPreview(): Promise<void> {
  try {
    previewStream = await openScreenStream(CAPTURE_FPS, CAPTURE_MAX_WIDTH, CAPTURE_MAX_HEIGHT)
    preview.srcObject = previewStream
    await preview.play()
  } catch (error) {
    preview.replaceWith(Object.assign(document.createElement('p'), { textContent: String(error) }))
  }
}

function stopPreview(): void {
  previewStream?.getTracks().forEach((t) => t.stop())
  previewStream = null
  preview.srcObject = null
}

$<HTMLInputElement>('preview-on').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) void startPreview()
  else stopPreview()
})

api.onCaptureStats((s: CaptureStats) => {
  setCell(
    'fps',
    `${s.fps} fps (needs ≥ ${PHASE0_MIN_FPS} on moving content)`,
    s.fps >= PHASE0_MIN_FPS ? 'ok' : 'warn'
  )
  setCell(
    'delay',
    s.delayMedianMs === null
      ? 'n/a: frames carry no captureTime'
      : `median ${s.delayMedianMs.toFixed(1)} ms, p95 ${s.delayP95Ms?.toFixed(1)} ms`
  )
  setCell('size', `${s.width} × ${s.height}`)
  const st = s.settings
  setCell(
    'settings',
    `${st.width ?? '?'} × ${st.height ?? '?'} @ ${st.frameRate ?? '?'} fps, cursor: ${st.cursor ?? 'not reported'}`
  )
  setCell('skipped', `${s.skippedFrames} of ${s.framesTotal}`)
})

api.onOverlayState((o) => {
  setCell('overlay', `${o.visible ? 'shown' : 'hidden'} (${o.reason})`, o.visible ? 'ok' : 'warn')
})

const verdictText: Record<SelfCheckResult['verdict'], [string, 'ok' | 'bad' | 'warn']> = {
  pass: ['PASS: overlay is excluded from capture', 'ok'],
  'tint-leak': ['FAIL: the tint is in the capture', 'bad'],
  black: ['FAIL?: capture is black where the overlay sits', 'bad'],
  inconclusive: ['INCONCLUSIVE: pause video and rerun', 'warn'],
  error: ['ERROR', 'bad']
}

api.onSelfCheckResult((r) => {
  const [text, cls] = verdictText[r.verdict]
  setCell('selfcheck-verdict', text, cls)
  $('selfcheck-detail').textContent = r.detail
})

$('selfcheck-run').addEventListener('click', () => {
  setCell('selfcheck-verdict', 'running…')
  $('selfcheck-detail').textContent = ''
  api.runSelfCheck()
})

// Size-cap selector: reopens the overlay's capture with a different max size.
const sizes = $('sizes')
DEBUG_CAPTURE_SIZES.forEach((size) => {
  const label = document.createElement('label')
  label.style.display = 'inline-block'
  label.style.marginRight = '12px'
  const input = Object.assign(document.createElement('input'), {
    type: 'radio',
    name: 'capture-size',
    checked: size.maxWidth === CAPTURE_MAX_WIDTH && size.maxHeight === CAPTURE_MAX_HEIGHT
  })
  input.addEventListener('change', () => api.restartCapture(size))
  label.append(input, ` ${size.maxWidth} × ${size.maxHeight}`)
  sizes.append(label)
})

$<HTMLInputElement>('on-top').addEventListener('change', (e) => {
  api.setDebugOnTop((e.target as HTMLInputElement).checked)
})

// Motion test: a mid-grey bar sliding across a dark strip, redrawn every display frame,
// so the screen is guaranteed to change at the display rate. Moves, never flashes.
const motionCanvas = $<HTMLCanvasElement>('motion')
const motionCtx = motionCanvas.getContext('2d')
let motionOn = false
let motionFrames: number[] = []
function drawMotion(t: number): void {
  if (!motionOn || !motionCtx) return
  const w = motionCanvas.width
  const h = motionCanvas.height
  const barWidth = w / 8
  const x = ((t / 1000) * w * 0.5) % (w + barWidth)
  motionCtx.fillStyle = '#303030'
  motionCtx.fillRect(0, 0, w, h)
  motionCtx.fillStyle = '#7a7a7a'
  motionCtx.fillRect(x - barWidth, 0, barWidth, h)
  motionFrames.push(t)
  motionFrames = motionFrames.filter((f) => t - f <= 1000)
  $('motion-fps').textContent = `this window redraws at ${motionFrames.length} fps`
  requestAnimationFrame(drawMotion)
}
function setMotion(on: boolean): void {
  motionOn = on
  $<HTMLInputElement>('motion-on').checked = on
  if (on) requestAnimationFrame(drawMotion)
}
$<HTMLInputElement>('motion-on').addEventListener('change', (e) => {
  setMotion((e.target as HTMLInputElement).checked)
})

// The FPS sweep loads this page with #sweep: motion test on so the screen changes every
// frame. The preview stays off unless the user turns it on.
if (location.hash === '#sweep') setMotion(true)

// ---------------------------------------------------------------------------
// Phase 3: live detection
// ---------------------------------------------------------------------------

const graph = new ScrollingGraph($<HTMLCanvasElement>('graph'))
graph.draw()

const stateText: Record<DetectionStats['state'], string> = {
  safe: 'Safe',
  active: 'Active (Phase 4 will smooth here)',
  release: 'Release (fading out)',
  disabled: 'Disabled'
}

function ms(v: number | null, digits = 1): string {
  return v === null ? '?' : `${v.toFixed(digits)} ms`
}

function timingText(t: Timing): string {
  return `${ms(t.median)} median, ${ms(t.p95)} p95`
}

api.onDetectionStats((s: DetectionStats) => {
  graph.push(s.tMs, s.graphValue, s.hazard)
  graph.draw()
  setCell(
    'd-hazard',
    s.hazard ? `HAZARD (${s.type}), ${s.hotCells} hot cells` : `none, ${s.hotCells} hot cells`,
    s.hazard ? 'bad' : 'ok'
  )
  setCell('d-state', stateText[s.state])
  setCell('d-freq', s.frequencyHz > 0 ? `${s.frequencyHz.toFixed(1)} Hz` : '-')
  setCell('d-size', s.flashSize > 0 ? `ΔL ${s.flashSize.toFixed(2)}` : '-')
  setCell('d-area', s.areaFraction.toFixed(2))

  const overBudget = s.cost.p95 !== null && s.cost.p95 >= ANALYSIS_BUDGET_MS
  setCell(
    't-cost',
    `${timingText(s.cost)} (budget ${ANALYSIS_BUDGET_MS} ms; issue ${ms(s.issueMedianMs, 2)}, copy ${ms(s.copyMedianMs, 2)}, detector ${ms(s.detectorMedianMs, 2)})`,
    overBudget ? 'warn' : 'ok'
  )
  setCell('t-callback', timingText(s.latency.captureToCallback))
  setCell('t-grid', timingText(s.latency.callbackToGrid))
  setCell('t-decision', timingText(s.latency.gridToDecision))
  setCell('t-total', timingText(s.latency.captureToDecision))
  setCell('t-skips', `${s.busySkips} of ${s.framesAnalysed + s.busySkips}`)
})

api.onGridSelfTest((r) => {
  setCell(
    'd-selftest',
    r.pass ? 'PASS: true area average in linear light' : 'FAIL: detection is off',
    r.pass ? 'ok' : 'bad'
  )
  $('d-selftest-detail').textContent = r.detail
})

/** Local wall-clock time with milliseconds, e.g. 22:41:07.123. */
function clock(wallMs: number): string {
  const d = new Date(wallMs)
  const hms = d.toLocaleTimeString('en-GB', { hour12: false })
  return `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

const hazardLog = $('hazard-log')
let hazardLogEmpty = true

api.onHazardEvent((e: HazardEvent) => {
  if (hazardLogEmpty) {
    hazardLog.textContent = ''
    hazardLogEmpty = false
  }
  const values = `${e.type}, ${e.frequencyHz.toFixed(1)} Hz, ΔL ${e.flashSize.toFixed(2)}, area ${e.areaFraction.toFixed(2)}`
  const line =
    e.kind === 'start'
      ? `START ${clock(e.wallMs)}  ${values}`
      : `END   ${clock(e.wallMs)}  after ${((e.durationMs ?? 0) / 1000).toFixed(2)} s, peaks ${values}, ${e.graphValue.toFixed(1)}/s`
  const li = document.createElement('li')
  li.textContent = line
  li.title = `capture timestamp ${e.tMs.toFixed(1)} ms`
  hazardLog.prepend(li)
  while (hazardLog.childElementCount > DEBUG_HAZARD_LOG_MAX) hazardLog.lastElementChild?.remove()
})
