// Overlay renderer. Opens the screen capture and runs the per-frame loop: live detection
// (Phase 3) and, during a hazard, the smoothed copy drawn over the screen (Phase 4). The
// capture is Chromium's (getDisplayMedia into a <video>) or, with CALMFRAME_NATIVE_CAPTURE=1,
// the native module's shared textures at full size (trail #9); both feed the same frame
// handler. The Phase 0 red tint is a debug flag: the main process loads this page with
// #tint when CALMFRAME_DEBUG_TINT=1.
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
import type {
  CaptureSize,
  CorrectSelfTestResult,
  InitInfo,
  NativeFrameMeta
} from '../shared/messages'
import { DEFAULT_SETTINGS, detectorOptionsFor, type Settings } from '../shared/settings'
import { LiveAnalysis } from './analysis'
import { openScreenStream } from './capture'
import { CorrectPass } from './correctPass'
import { runCorrectSelfTest } from './correctSelfTest'
import { GridPass, type FrameImage } from './gridPass'
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
/** Which capture feeds the frame handler. */
let source: 'chromium' | 'native' = 'chromium'
/** Native capture started and has not been stopped. */
let nativeLive = false
/** Native only: the latest frame, kept while the capture-leak self-check samples it. */
let checkFrame: VideoFrame | null = null
const callbackTimes: number[] = []
/** Native only: frames in the last rolling second that were the screen sent again. */
const repeatTimes: number[] = []
/** The latest frame's size and capture timestamp. */
let frameWidth = 0
let frameHeight = 0
let lastCaptureT = -Infinity
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

function captureLive(): boolean {
  return source === 'native' ? nativeLive : track !== null && track.readyState === 'live'
}

function sendStats(): void {
  // Desktop Duplication leaves the cursor out of the image.
  const s =
    source === 'native'
      ? { frameRate: undefined, width: frameWidth, height: frameHeight, cursor: 'never' }
      : (track?.getSettings() as MediaTrackSettings & { cursor?: string })
  api.sendCaptureStats({
    source,
    fps: callbackTimes.length,
    repeats: repeatTimes.length,
    delayMedianMs: percentile(delays, 0.5),
    delayP95Ms: percentile(delays, 0.95),
    hasCaptureTime,
    width: frameWidth,
    height: frameHeight,
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

/**
 * One captured frame, from either capture.
 * @param captureT when the frame was captured, on the performance clock, if known
 * @param fallbackT the time to use when it is not (the frame callback's time)
 */
function processFrame(image: FrameImage, captureT: number | undefined, fallbackT: number): void {
  const t = performance.now()
  lastFrameAt = t
  framesTotal++
  frameWidth = image.width
  frameHeight = image.height

  callbackTimes.push(t)
  while (callbackTimes.length > 0 && t - callbackTimes[0] > FPS_WINDOW_MS) callbackTimes.shift()
  while (repeatTimes.length > 0 && t - repeatTimes[0] > FPS_WINDOW_MS) repeatTimes.shift()

  if (captureT !== undefined) {
    hasCaptureTime = true
    delays.push(t - captureT)
    if (delays.length > DELAY_STATS_WINDOW) delays.shift()
  }

  // Timing logic runs on capture timestamps, which must keep increasing. A native frame
  // presented just as the module re-sent the previous one can be stamped a fraction of a
  // millisecond before it.
  let tMs = captureT ?? fallbackT
  if (tMs <= lastCaptureT) tMs = lastCaptureT + 0.001
  lastCaptureT = tMs
  if (analysis) {
    try {
      analysis.frame(image, tMs, callbackTimes.length)
    } catch (error) {
      pipelineFailed(error)
    }
  }

  if (framesTotal % STATS_EVERY_N_FRAMES === 0) sendStats()
}

/** Chromium's capture: one call per frame the <video> presents. */
function onFrame(gen: number, now: number, meta: VideoFrameCallbackMetadata): void {
  if (gen !== generation) return
  if (lastPresented >= 0 && meta.presentedFrames > lastPresented + 1) {
    skippedFrames += meta.presentedFrames - lastPresented - 1
  }
  lastPresented = meta.presentedFrames
  // Chromium supplies captureTime for screen capture (Phase 0), on the performance clock.
  processFrame(
    { source: video, width: video.videoWidth, height: video.videoHeight },
    meta.captureTime,
    now
  )
  video.requestVideoFrameCallback((n, m) => onFrame(gen, n, m))
}

/** Native capture: one call per shared texture from main. The frame is closed before this
 *  returns, and the preload then releases the texture back to the module. */
function onNativeFrame(texture: { getVideoFrame(): VideoFrame }, meta: NativeFrameMeta): void {
  if (source !== 'native' || !nativeLive) return
  const frame = texture.getVideoFrame()
  try {
    if (meta.repeat) repeatTimes.push(performance.now())
    skippedFrames += meta.missed
    // The module stamps frames in epoch ms from the system's high-resolution clock;
    // performance.timeOrigin + performance.now() is the same clock here.
    const captureT = meta.presentEpochMs - performance.timeOrigin
    processFrame(
      { source: frame, width: frame.displayWidth, height: frame.displayHeight },
      captureT,
      performance.now()
    )
    if (selfCheckRunning) {
      checkFrame?.close()
      checkFrame = frame.clone()
    }
  } finally {
    frame.close()
  }
}

/** Draw the latest captured frame for the capture-leak self-check. */
function drawLatestFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  if (source === 'native') {
    if (checkFrame) ctx.drawImage(checkFrame, 0, 0, width, height)
  } else {
    ctx.drawImage(video, 0, 0, width, height)
  }
}

let selfCheckRunning = false
async function selfCheck(): Promise<void> {
  if (selfCheckRunning || !captureLive()) return
  selfCheckRunning = true
  try {
    api.sendSelfCheckResult(await runSelfCheck(drawLatestFrame, setTint, debugTint))
  } catch (error) {
    api.sendSelfCheckResult({ verdict: 'error', cycles: [], detail: String(error) })
  } finally {
    selfCheckRunning = false
    checkFrame?.close()
    checkFrame = null
  }
}

function resetCaptureCounters(): void {
  callbackTimes.length = 0
  repeatTimes.length = 0
  delays.length = 0
  framesTotal = 0
  skippedFrames = 0
  lastPresented = -1
  lastCaptureT = -Infinity
  captureOpenedAt = performance.now()
  // A restart leaves a gap in the timestamps; start detection from a clean slate.
  analysis?.reset()
}

/**
 * Native capture (trail #9): register the texture receiver, then ask main to start the
 * module. Resolves false, after logging why, if it cannot start; the caller then opens
 * Chromium's capture instead.
 */
async function openNativeCapture(): Promise<boolean> {
  window.nativeCapture.onFrame((texture, meta) => onNativeFrame(texture, meta))
  api.onNativeCaptureError((message) => console.error(`[native capture] ${message}`))
  source = 'native'
  resetCaptureCounters()
  nativeLive = true
  const result = await api.startNativeCapture()
  if (!result.ok) {
    nativeLive = false
    source = 'chromium'
    console.error(`[native capture] could not start, using Chromium's capture: ${result.error}`)
    return false
  }
  const i = result.info
  console.log(`[native capture] ${i.width}x${i.height} from ${i.output} via ${i.method}`)
  return true
}

async function openCapture(size: CaptureSize): Promise<void> {
  const gen = ++generation
  if (track) {
    // Stopping a track on purpose must not look like a capture failure.
    const old = track
    track = null
    old.stop()
  }
  resetCaptureCounters()
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
  const correction = smoothResult.pass ? startCorrection(gl, pass) : null
  if (correction) smoothResult.correction = correction.result
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
    detectorOptionsFor(settings),
    correction && correction.result.pass ? correction.pass : null
  )
  analysis.setMitigation(settings.mitigation)
}

/**
 * The experimental correction pass ("Keep motion sharp", trail #10) and its startup check
 * against the CPU twin. Nothing here may stop protection: if the pass cannot be built or
 * does not match, the result says so and the smoothing filter draws every hazard.
 */
function startCorrection(
  gl: WebGL2RenderingContext,
  pass: GridPass
): { pass: CorrectPass | null; result: CorrectSelfTestResult } {
  try {
    const correct = new CorrectPass(gl, pass.source, pass.gridTexture)
    const t0 = performance.now()
    const result = runCorrectSelfTest(gl, pass, correct)
    console.log(`[correct self-test] ${(performance.now() - t0).toFixed(0)} ms: ${result.detail}`)
    return { pass: correct, result }
  } catch (error) {
    // Leave no WebGL error behind for the passes that follow.
    while (gl.getError() !== gl.NO_ERROR);
    const detail = `correction pass could not start: ${String(error)}`
    console.error(`[correct self-test] ${detail}`)
    return { pass: null, result: { pass: false, maxDiff: NaN, detail } }
  }
}

/** The user's settings and the capture choice, from main. If main cannot be asked, the
 *  defaults: protection with the spec's detector beats no protection. */
async function loadInit(): Promise<Pick<InitInfo, 'settings' | 'nativeCapture'>> {
  try {
    return await api.getInit()
  } catch (error) {
    console.error('[settings] could not load, using the defaults', error)
    return { settings: DEFAULT_SETTINGS, nativeCapture: false }
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
      captureLive: captureLive()
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
  api.onSettings((settings) => {
    analysis?.configure(detectorOptionsFor(settings))
    analysis?.setMitigation(settings.mitigation)
  })
  const init = await loadInit()
  try {
    startAnalysis(init.settings)
  } catch (error) {
    pipelineFailed(error)
  }
  try {
    const native = init.nativeCapture && (await openNativeCapture())
    if (!native) await openCapture({ maxWidth: CAPTURE_MAX_WIDTH, maxHeight: CAPTURE_MAX_HEIGHT })
    api.onSelfCheckRun(() => void selfCheck())
    api.onCaptureRestart((size) => {
      if (source === 'native') {
        console.warn('[capture] size cap ignored: the native capture is always full size')
        return
      }
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
