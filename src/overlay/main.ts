// Overlay renderer. Opens the screen capture and runs the per-frame loop: live detection
// (Phase 3) and, during a hazard, the smoothed copy drawn over the screen (Phase 4). The
// Phase 0 red tint is a debug flag: the main process loads this page with #tint when
// CALMFRAME_DEBUG_TINT=1.
import {
  CAPTURE_FPS,
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
  DEBUG_TINT_OPACITY,
  DELAY_STATS_WINDOW,
  FPS_WINDOW_MS,
  HEARTBEAT_MS,
  STATS_EVERY_N_FRAMES
} from '../shared/config'
import type { CaptureSize } from '../shared/messages'
import { DEFAULT_SETTINGS, detectorOptionsFor, type Settings } from '../shared/settings'
import { LiveAnalysis } from './analysis'
import { openScreenStream } from './capture'
import { GridPass } from './gridPass'
import { runGridSelfTest } from './gridSelfTest'
import { runSelfCheck } from './selfCheck'
import { SmoothPass } from './smoothPass'
import { runSmoothSelfTest } from './smoothSelfTest'
import { percentile } from './stats'

const api = window.api
const video = document.getElementById('capture') as HTMLVideoElement
const canvas = document.getElementById('smoothed') as HTMLCanvasElement
const debugTint = location.hash === '#tint'

// The capture is the whole primary display, so the copy is stretched over the whole
// display (screen size in CSS pixels), not the window, which is 1 DIP shorter.
canvas.style.width = `${screen.width}px`
canvas.style.height = `${screen.height}px`

function setTint(on: boolean): void {
  document.body.style.background = on ? `rgba(255, 0, 0, ${DEBUG_TINT_OPACITY})` : 'transparent'
}

let track: MediaStreamTrack | null = null
const callbackTimes: number[] = []
const delays: number[] = []
let framesTotal = 0
let skippedFrames = 0
/** When the current capture was opened, for CaptureStats.runningMs. */
let captureOpenedAt = performance.now()
let lastPresented = -1
let hasCaptureTime = false
/** When the latest frame callback ran, for the heartbeat. */
let lastFrameAt: number | null = null

/** Set once the GPU pass is up. Null means detection is off and main has been told. */
let analysis: LiveAnalysis | null = null

/** Fail open: stop analysing, leave the canvas transparent and tell main, which hides
 *  the overlay and reports protection off. */
function pipelineFailed(error: unknown): void {
  try {
    analysis?.stop()
  } catch (stopError) {
    console.error('[pipeline] while stopping', stopError)
  }
  analysis = null
  console.error('[pipeline]', error)
  api.sendPipelineError(String(error))
}

function sendStats(): void {
  const s = track?.getSettings() as MediaTrackSettings & { cursor?: string }
  api.sendCaptureStats({
    fps: callbackTimes.length,
    delayMedianMs: percentile(delays, 0.5),
    delayP95Ms: percentile(delays, 0.95),
    hasCaptureTime,
    width: video.videoWidth,
    height: video.videoHeight,
    skippedFrames,
    framesTotal,
    settings: { frameRate: s?.frameRate, width: s?.width, height: s?.height, cursor: s?.cursor },
    runningMs: performance.now() - captureOpenedAt
  })
  if (analysis) {
    api.sendDetectionStats(analysis.stats())
    api.sendThumbnails(analysis.thumbnails())
  }
}

// Each (re)started capture gets a new generation so a stale frame-callback chain stops.
let generation = 0

function onFrame(gen: number, now: number, meta: VideoFrameCallbackMetadata): void {
  if (gen !== generation) return
  const t = performance.now()
  lastFrameAt = t
  framesTotal++
  if (lastPresented >= 0 && meta.presentedFrames > lastPresented + 1) {
    skippedFrames += meta.presentedFrames - lastPresented - 1
  }
  lastPresented = meta.presentedFrames

  callbackTimes.push(t)
  while (callbackTimes.length > 0 && t - callbackTimes[0] > FPS_WINDOW_MS) callbackTimes.shift()

  if (meta.captureTime !== undefined) {
    hasCaptureTime = true
    delays.push(t - meta.captureTime)
    if (delays.length > DELAY_STATS_WINDOW) delays.shift()
  }

  // Timing logic runs on capture timestamps. Chromium supplies captureTime for screen
  // capture (Phase 0); the callback time is the fallback, on the same clock.
  if (analysis) {
    try {
      analysis.frame(video, meta.captureTime ?? now, callbackTimes.length)
    } catch (error) {
      pipelineFailed(error)
    }
  }

  if (framesTotal % STATS_EVERY_N_FRAMES === 0) sendStats()
  video.requestVideoFrameCallback((n, m) => onFrame(gen, n, m))
}

let selfCheckRunning = false
async function selfCheck(): Promise<void> {
  if (selfCheckRunning || !track) return
  selfCheckRunning = true
  try {
    api.sendSelfCheckResult(await runSelfCheck(video, setTint, debugTint))
  } catch (error) {
    api.sendSelfCheckResult({ verdict: 'error', cycles: [], detail: String(error) })
  } finally {
    selfCheckRunning = false
  }
}

async function openCapture(size: CaptureSize): Promise<void> {
  const gen = ++generation
  if (track) {
    // Stopping a track on purpose must not look like a capture failure.
    const old = track
    track = null
    old.stop()
  }
  callbackTimes.length = 0
  delays.length = 0
  framesTotal = 0
  skippedFrames = 0
  lastPresented = -1
  captureOpenedAt = performance.now()
  // A restart leaves a gap in the timestamps; start detection from a clean slate.
  analysis?.reset()
  const stream = await openScreenStream(CAPTURE_FPS, size.maxWidth, size.maxHeight)
  const newTrack = stream.getVideoTracks()[0]
  if (!newTrack) throw new Error('stream has no video track')
  newTrack.addEventListener('ended', () => {
    if (track === newTrack) api.sendCaptureError('capture track ended')
  })
  track = newTrack
  video.srcObject = stream
  await video.play()
  video.requestVideoFrameCallback((n, m) => onFrame(gen, n, m))
}

/**
 * The GPU pipeline: Pass A for detection, Passes B and C for the smoothed copy, all on the
 * overlay canvas's context. Passes A and B only draw offscreen; Pass C draws on the canvas.
 */
function startAnalysis(settings: Settings): void {
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    pipelineFailed('WebGL context lost')
  })
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false
  })
  if (!gl) throw new Error('WebGL2 is not available')
  const pass = new GridPass(gl)

  const t0 = performance.now()
  const result = runGridSelfTest(pass)
  console.log(`[grid self-test] ${(performance.now() - t0).toFixed(0)} ms: ${result.detail}`)
  api.sendGridSelfTest(result)
  if (!result.pass) throw new Error(`grid self-test failed: ${result.detail}`)

  // Throws if the GPU cannot render to half-float textures.
  const smooth = new SmoothPass(gl, pass.source)
  const t1 = performance.now()
  const smoothResult = runSmoothSelfTest(gl, pass, smooth)
  console.log(
    `[smooth self-test] ${(performance.now() - t1).toFixed(0)} ms: ${smoothResult.detail}`
  )
  api.sendSmoothSelfTest(smoothResult)
  if (!smoothResult.pass) throw new Error(`smoothing self-test failed: ${smoothResult.detail}`)

  analysis = new LiveAnalysis(
    pass,
    smooth,
    {
      hazardEvent: (event) => api.sendHazardEvent(event),
      flashEvent: (event) => api.sendFlashEvent(event),
      stateChange: (change) => {
        console.log(
          `[state] ${change.from} -> ${change.to} (${change.reason}): alpha ${change.alpha.toFixed(3)}, d ${change.dim.toFixed(2)}, opacity ${change.opacity.toFixed(2)}`
        )
        api.sendStateChange(change)
      },
      failed: pipelineFailed
    },
    detectorOptionsFor(settings)
  )
}

/** The user's settings, from main. If main cannot be asked, the defaults: protection with
 *  the spec's detector beats no protection. */
async function loadSettings(): Promise<Settings> {
  try {
    return (await api.getInit()).settings
  } catch (error) {
    console.error('[settings] could not load, using the defaults', error)
    return DEFAULT_SETTINGS
  }
}

/** Every HEARTBEAT_MS, from a timer rather than the frame loop, so a static screen that
 *  delivers few frames never looks like a frozen renderer. The watchdog in main hides the
 *  overlay if these stop. */
function startHeartbeat(): void {
  setInterval(() => {
    api.sendHeartbeat({
      state: analysis ? analysis.state : 'off',
      frameAgeMs: lastFrameAt === null ? null : performance.now() - lastFrameAt,
      captureLive: track !== null && track.readyState === 'live'
    })
  }, HEARTBEAT_MS)
}

/** Debug only (main sends it from a hidden shortcut in dev builds): block this thread so
 *  the watchdog can be seen to fire. Nothing else runs meanwhile, heartbeats included. */
function freeze(ms: number): void {
  console.warn(`[debug] freezing the overlay renderer for ${ms} ms`)
  const end = performance.now() + ms
  let spins = 0
  while (performance.now() < end) spins++
  console.warn(`[debug] overlay renderer resumed after ${spins} spins`)
}

async function start(): Promise<void> {
  setTint(debugTint)
  startHeartbeat()
  api.onProtection((enabled, reason) => analysis?.setEnabled(enabled, reason))
  api.onDebugFreeze(freeze)
  api.onSettings((settings) => analysis?.configure(detectorOptionsFor(settings)))
  const settings = await loadSettings()
  try {
    startAnalysis(settings)
  } catch (error) {
    pipelineFailed(error)
  }
  try {
    await openCapture({ maxWidth: CAPTURE_MAX_WIDTH, maxHeight: CAPTURE_MAX_HEIGHT })
    api.onSelfCheckRun(() => void selfCheck())
    api.onCaptureRestart((size) => {
      openCapture(size).catch((error) => api.sendCaptureError(String(error)))
    })
    // The automatic capture-leak check toggles the tint, so it only runs when the tint is
    // on. The debug window can run it any time.
    if (debugTint) setTimeout(() => void selfCheck(), 1500)
  } catch (error) {
    api.sendCaptureError(String(error))
  }
}

void start()
