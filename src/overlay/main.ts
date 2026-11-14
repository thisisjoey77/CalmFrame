// Overlay renderer. Phase 3: opens the screen capture and runs live detection on every
// frame (Pass A on the GPU, the detector, the state machine). It draws nothing yet; the
// smoothed copy arrives in Phase 4. The Phase 0 red tint is a debug flag: the main process
// loads this page with #tint when CALMFRAME_DEBUG_TINT=1.
import {
  CAPTURE_FPS,
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
  DEBUG_TINT_OPACITY,
  DELAY_STATS_WINDOW,
  FPS_WINDOW_MS,
  STATS_EVERY_N_FRAMES
} from '../shared/config'
import type { CaptureSize } from '../shared/messages'
import { LiveAnalysis } from './analysis'
import { openScreenStream } from './capture'
import { GridPass } from './gridPass'
import { runGridSelfTest } from './gridSelfTest'
import { runSelfCheck } from './selfCheck'
import { percentile } from './stats'

const api = window.api
const video = document.getElementById('capture') as HTMLVideoElement
const debugTint = location.hash === '#tint'

function setTint(on: boolean): void {
  document.body.style.background = on ? `rgba(255, 0, 0, ${DEBUG_TINT_OPACITY})` : 'transparent'
}

let track: MediaStreamTrack | null = null
const callbackTimes: number[] = []
const delays: number[] = []
let framesTotal = 0
let skippedFrames = 0
let lastPresented = -1
let hasCaptureTime = false

/** Set once the GPU pass is up. Null means detection is off and main has been told. */
let analysis: LiveAnalysis | null = null

/** Fail open: stop analysing and tell main, which hides the overlay. */
function pipelineFailed(error: unknown): void {
  analysis?.stop()
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
    settings: { frameRate: s?.frameRate, width: s?.width, height: s?.height, cursor: s?.cursor }
  })
  if (analysis) api.sendDetectionStats(analysis.stats())
}

// Each (re)started capture gets a new generation so a stale frame-callback chain stops.
let generation = 0

function onFrame(gen: number, now: number, meta: VideoFrameCallbackMetadata): void {
  if (gen !== generation) return
  const t = performance.now()
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
 * The GPU pipeline. Phase 3 never draws to this canvas, so it stays out of the page;
 * Phase 4 sizes it to the screen and draws the smoothed copy on it.
 */
function startAnalysis(): void {
  const canvas = document.createElement('canvas')
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

  analysis = new LiveAnalysis(pass, {
    hazardEvent: (event) => api.sendHazardEvent(event),
    failed: pipelineFailed
  })
}

async function start(): Promise<void> {
  setTint(debugTint)
  try {
    startAnalysis()
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
