// Overlay renderer, Phase 0 spike: shows a red tint (its only visible content), opens
// the screen capture and measures it. Detection and smoothing arrive in Phases 3 and 4.
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
import { openScreenStream } from './capture'
import { runSelfCheck } from './selfCheck'
import { percentile } from './stats'

const api = window.api
const video = document.getElementById('capture') as HTMLVideoElement

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
}

// Each (re)started capture gets a new generation so a stale frame-callback chain stops.
let generation = 0

function onFrame(gen: number, meta: VideoFrameCallbackMetadata): void {
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

  if (framesTotal % STATS_EVERY_N_FRAMES === 0) sendStats()
  video.requestVideoFrameCallback((_now, m) => onFrame(gen, m))
}

let selfCheckRunning = false
async function selfCheck(): Promise<void> {
  if (selfCheckRunning || !track) return
  selfCheckRunning = true
  try {
    api.sendSelfCheckResult(await runSelfCheck(video, setTint))
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
  const stream = await openScreenStream(CAPTURE_FPS, size.maxWidth, size.maxHeight)
  const newTrack = stream.getVideoTracks()[0]
  if (!newTrack) throw new Error('stream has no video track')
  newTrack.addEventListener('ended', () => {
    if (track === newTrack) api.sendCaptureError('capture track ended')
  })
  track = newTrack
  video.srcObject = stream
  await video.play()
  video.requestVideoFrameCallback((_now, m) => onFrame(gen, m))
}

async function start(): Promise<void> {
  setTint(true)
  try {
    await openCapture({ maxWidth: CAPTURE_MAX_WIDTH, maxHeight: CAPTURE_MAX_HEIGHT })
    api.onSelfCheckRun(() => void selfCheck())
    api.onCaptureRestart((size) => {
      openCapture(size).catch((error) => api.sendCaptureError(String(error)))
    })
    // One automatic check once capture has settled; the debug window can rerun it.
    setTimeout(() => void selfCheck(), 1500)
  } catch (error) {
    api.sendCaptureError(String(error))
  }
}

void start()
