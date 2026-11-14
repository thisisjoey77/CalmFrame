/**
 * IPC channel names and message shapes shared by main, preload and the renderers.
 * Only small stats objects cross IPC. Frames never do (CLAUDE.md working rules).
 */

import type { HazardType } from '../core/detector'
import type { FlashEvent } from '../core/events'
import type { OverlayStateName } from '../core/stateMachine'
import type { ConcurrencyRule, MitigationMethod } from './config'
import type { Settings } from './settings'

export const IPC = {
  /** overlay -> main -> debug: capture stats, every STATS_EVERY_N_FRAMES frames. */
  captureStats: 'capture-stats',
  /** overlay -> main: capture failed to start or stopped. Main fails open. */
  captureError: 'capture-error',
  /** debug -> main -> overlay: run the capture-leak self-check. */
  selfCheckRun: 'self-check-run',
  /** overlay -> main -> debug: self-check result. */
  selfCheckResult: 'self-check-result',
  /** main -> debug: overlay shown or hidden (kill switch, failure). */
  overlayState: 'overlay-state',
  /** debug -> main: put the debug window above the overlay and hide it from capture. */
  debugSetOnTop: 'debug-set-on-top',
  /** debug -> main -> overlay: reopen the capture with a different size cap (Phase 0 tuning). */
  captureRestart: 'capture-restart',
  /** overlay -> main -> debug: detector stats, every STATS_EVERY_N_FRAMES frames. */
  detectionStats: 'detection-stats',
  /** overlay -> main -> debug: a hazard started or ended. */
  hazardEvent: 'hazard-event',
  /** overlay -> main -> debug: the Pass A startup self-test result. */
  gridSelfTest: 'grid-self-test',
  /** overlay -> main: the GPU pipeline or detector failed. Main fails open. */
  pipelineError: 'pipeline-error',
  /** overlay -> main -> debug: the Passes B and C startup self-test result. */
  smoothSelfTest: 'smooth-self-test',
  /** overlay -> main: the renderer is alive, every HEARTBEAT_MS. The watchdog's input. */
  heartbeat: 'heartbeat',
  /** overlay -> main -> debug: the overlay state machine changed state. */
  stateChange: 'state-change',
  /** main -> overlay: protection switched on or off (kill switch, watchdog, failure). */
  protection: 'protection',
  /** main -> overlay: debug only, block the renderer's main thread for this many ms. */
  debugFreeze: 'debug-freeze',
  /** dashboard or debug -> main: change some settings (a partial Settings, validated in
   *  main). Main saves them and sends the result on `settings`. */
  updateSettings: 'update-settings',
  /** main -> every renderer: the settings now in force. The overlay applies the detector
   *  options; the dashboard and debug windows show them. */
  settings: 'settings',
  /** any renderer -> main, invoke: the settings and the app's start time (InitInfo). */
  getInit: 'get-init',
  /** dashboard -> main, invoke: switch protection on or off. Resolves false if main refused
   *  (the overlay is not responding, so it must not be shown again). */
  setProtection: 'set-protection',
  /** main -> dashboard and debug: each heartbeat with main's view of the overlay
   *  (StatusBeat). The status is derived from these. */
  statusBeat: 'status-beat',
  /** overlay -> main -> dashboard: the thumbnails, every STATS_EVERY_N_FRAMES frames. */
  thumbnails: 'thumbnails',
  /** overlay -> main -> dashboard: a flash event started or ended. */
  flashEvent: 'flash-event',
  /** overlay -> main, invoke: start the native capture module (trail #9) and send its
   *  frames to the overlay as shared textures. Resolves a NativeCaptureStart. */
  startNativeCapture: 'start-native-capture',
  /** main -> overlay: the native capture module reported an error. */
  nativeCaptureError: 'native-capture-error'
} as const

/** What a renderer asks main for when it loads. */
export interface InitInfo {
  settings: Settings
  /** When the app started, wall-clock ms since the epoch. The event log counts from it. */
  startedAtWallMs: number
  /** Capture with the native module instead of Chromium (CALMFRAME_NATIVE_CAPTURE=1). */
  nativeCapture: boolean
}

/** Sent with each native frame's shared texture, main -> overlay. Only this and a texture
 *  handle cross the process boundary, never pixels. Times are Unix epoch ms from the
 *  high-resolution system clock, so the overlay can put them on its own clock. */
export interface NativeFrameMeta {
  /** When the frame reached the screen (for a repeat: when it was sent again). */
  presentEpochMs: number
  /** The screen had not changed, so this is the latest frame sent again. */
  repeat: boolean
  /** Screen updates Desktop Duplication merged into this frame, so missed. */
  missed: number
}

/** What the native capture module reports when it starts. */
export interface NativeCaptureInfo {
  width: number
  height: number
  adapter: string
  adapterLuid: string
  /** The duplicated output's Windows device name. */
  output: string
  /** DuplicateOutput1 or DuplicateOutput. */
  method: string
  /** Shared textures in the ring. */
  slots: number
}

export type NativeCaptureStart =
  { ok: true; info: NativeCaptureInfo } | { ok: false; error: string }

/** The dashboard's two thumbnails (Phase 5), each the 96x54 grid as sRGB RGBA8, row 0 at
 *  the top. 20 KB each: the only picture data that crosses IPC, never a frame. */
export interface Thumbnails {
  /** What the detector sees: the screen under the overlay. */
  raw: Uint8Array
  /** What the viewer sees (the viewer check's grid) while the overlay is drawn, else null. */
  seen: Uint8Array | null
}

/** A flash event as the overlay reports it, with the wall-clock time it started. */
export interface FlashEventMessage extends FlashEvent {
  /** startT as wall-clock ms since the epoch. */
  startWallMs: number
}

export interface CaptureSize {
  maxWidth: number
  maxHeight: number
}

export interface CaptureStats {
  /** Chromium's screen capture, or the native module (trail #9). */
  source: 'chromium' | 'native'
  /** Frame callbacks in the last rolling second. */
  fps: number
  /** Of those, frames the native module sent again because the screen had not changed. */
  repeats: number
  /** Capture-to-callback delay over recent frames, or null if captureTime is not provided. */
  delayMedianMs: number | null
  delayP95Ms: number | null
  /** Whether frame metadata carries captureTime at all. */
  hasCaptureTime: boolean
  /** Decoded frame size. */
  width: number
  height: number
  /** Frames skipped between callbacks since start (gaps in presentedFrames). */
  skippedFrames: number
  framesTotal: number
  /** What the browser reports it actually applied. */
  settings: { frameRate?: number; width?: number; height?: number; cursor?: string }
  /** How long this capture has been open. fps counts over a rolling second, so readings
   *  from the first second are partial. */
  runningMs: number
}

export interface ColorSample {
  /** Mean sRGB channel values, 0..255. */
  r: number
  g: number
  b: number
  /** Mean R / (R + G + B). */
  redRatio: number
  /** Share of sampled pixels that are near black. */
  blackFraction: number
}

export type SelfCheckVerdict = 'pass' | 'tint-leak' | 'black' | 'inconclusive' | 'error'

export interface SelfCheckResult {
  verdict: SelfCheckVerdict
  /** One pair per cycle: capture with the tint off, then on. */
  cycles: { hidden: ColorSample; shown: ColorSample }[]
  detail: string
}

export interface OverlayState {
  visible: boolean
  reason: string
}

/** Pass A startup self-test: the Step 2 checkerboard, and GPU against CPU on noise. */
export interface GridSelfTestResult {
  pass: boolean
  /** Y over all cells of a 1-pixel checkerboard; each should be 0.5. */
  checkerboards: { width: number; height: number; minY: number; maxY: number; meanY: number }[]
  /** Largest per-channel difference between the GPU grid and the CPU twin. */
  noiseMaxDiff: number
  detail: string
}

/** Passes B and C startup self-test: round trip through the half-float state, and one
 *  filter step with dim, desaturation and opacity against the CPU twin. In 8-bit codes. */
export interface SmoothSelfTestResult {
  pass: boolean
  roundTripMaxDiff: number
  stepMaxDiff: number
  detail: string
  /** The experimental correction pass (trail #10), checked against its CPU twin. Its
   *  failure does not fail the pipeline: "Keep motion sharp" then falls back to smoothing. */
  correction?: CorrectSelfTestResult
}

/** Correction pass startup self-test: one corrected frame against the CPU twin
 *  (src/core/regionCorrect.ts), in 8-bit codes. */
export interface CorrectSelfTestResult {
  pass: boolean
  maxDiff: number
  detail: string
}

/** Sent every HEARTBEAT_MS from a timer in the overlay renderer. Its arrival is what the
 *  watchdog checks, and its contents are what the status is derived from (Phase 5). */
export interface Heartbeat {
  /** The overlay state machine, or 'off' when the pipeline has failed open. */
  state: OverlayStateName | 'off'
  /** Time since the last captured frame arrived, or null before the first. */
  frameAgeMs: number | null
  /** The capture track exists and has not ended. */
  captureLive: boolean
}

/** What main relays to the dashboard for each heartbeat: the heartbeat as the overlay sent
 *  it, plus main's own view of the overlay window at that moment. The status is derived
 *  from this and from how old it is (src/shared/status.ts), never from a stored flag. */
export interface StatusBeat extends Heartbeat {
  /** The overlay window is shown (main hides it when protection goes off). */
  overlayVisible: boolean
  /** Why main last switched protection off, for the status line. Null while it is on. */
  offReason: string | null
  /** How old the heartbeat already was when main sent this. Main also re-sends the latest
   *  heartbeat when it switches protection off, and that one must not look fresh. */
  ageMs: number
}

/** The overlay state machine changed state ("On fast, off slow"). */
export interface StateChange {
  /** Capture timestamp of the frame that caused it, on the overlay's clock, or the time of
   *  the call for a switch from main. */
  tMs: number
  wallMs: number
  from: OverlayStateName
  to: OverlayStateName
  /** What the overlay does from this frame on. */
  alpha: number
  dim: number
  opacity: number
  red: boolean
  /** Why, in a few words. */
  reason: string
  /** The detection on that frame. */
  frequencyHz: number
  flashSize: number
}

/** Median and 95th percentile of a duration over recent frames, in ms. Null when empty. */
export interface Timing {
  median: number | null
  p95: number | null
}

/** Detector output for the debug window, sent every STATS_EVERY_N_FRAMES frames. */
export interface DetectionStats {
  /** Capture timestamp of the latest frame, in ms on the overlay's performance clock. */
  tMs: number
  /** Largest graph value (Step 8) over the frames since the last message, in flashes per
   *  second over a hazardous area, so a peak between messages is not lost. */
  graphValue: number
  /** Whether any frame since the last message had a hazard. */
  hazard: boolean
  /** The latest frame's detector outputs (Step 8). */
  type: HazardType
  frequencyHz: number
  flashSize: number
  areaFraction: number
  hotCells: number
  /** The concurrency rule in force (Step 5a), and the reversals it set aside since the
   *  last message: cells that reversed without it counting as a transition. */
  concurrency: ConcurrencyRule
  ignoredReversals: number
  /** Overlay state machine. */
  state: OverlayStateName
  /** What the overlay is doing now (state machine output), and whether it is drawn. */
  smoothing: {
    alpha: number
    dim: number
    opacity: number
    red: boolean
    drawn: boolean
    /** The method the overlay draws with now. 'smooth' although the setting says 'correct'
     *  means the correction pass is not available (its self-test failed). */
    method: MitigationMethod
  }
  /** The viewer check (src/core/viewerCheck.ts): the detector run on what the viewer sees
   *  while the overlay is drawn. */
  viewer: {
    checking: boolean
    /** Largest graph value of the seen picture since the last stats message. */
    graphValue: number
    /** Residual swing of the seen picture now, or null (see ViewerCheckResult). */
    residual: number | null
    /** Over the latest drawn episode. These persist after the overlay goes. */
    episodePeakGraph: number
    episodeFlagged: boolean
    /** Residual swing on the last frame of the episode where the detector still saw the
     *  hazard underneath: the steady state at the end of the strobe. */
    episodeResidual: number | null
  }
  /** Main-thread analysis cost per frame (the Phase 3 budget), and the medians of its
   *  parts: issue (upload, Pass A, start the read-back), copy (the finished grid out of
   *  its buffer) and detector (with the state machine). */
  cost: Timing
  issueMedianMs: number | null
  copyMedianMs: number | null
  detectorMedianMs: number | null
  /** Main-thread cost of the smoothing, medians: Pass B issue (every frame), Pass C issue
   *  (only while drawn) and the viewer check (CPU). */
  smoothMedianMs: number | null
  drawMedianMs: number | null
  viewerMedianMs: number | null
  /** Latency per stage, from each frame's capture timestamp. Chromium stamps captureTime
   *  late (Phase 0), so the first stage and the total are understated, and nothing here
   *  sees the compositor or the display: the slow-motion footage is the end-to-end truth.
   *  The grid wait and the total are over frames analysed while the overlay was not
   *  drawn; whileDrawn has the same for frames analysed while it was. */
  latency: {
    captureToCallback: Timing
    /** Upload, Pass A, the GPU queue and the read-back. */
    callbackToGrid: Timing
    /** Detector and state machine. */
    gridToDecision: Timing
    captureToDecision: Timing
    /** From the decision to the GPU finishing Pass C in the overlay canvas. The compositor
     *  and the display add more, which only the slow-motion footage sees. */
    decisionToDrawn: Timing
    captureToDrawn: Timing
  }
  /** Frames analysed while the overlay was drawn: the cost of drawing to detection. */
  whileDrawn: {
    callbackToGrid: Timing
    captureToDecision: Timing
    busySkips: number
    frames: number
  }
  /** Frames skipped because every read-back slot was still busy (the GPU was behind),
   *  while the overlay was not drawn. */
  busySkips: number
  framesAnalysed: number
}

/** A hazard started or ended, from the detector's per-frame hazard flag. */
export interface HazardEvent {
  kind: 'start' | 'end'
  /** Capture timestamp of the frame where it changed, in ms on the overlay's clock. */
  tMs: number
  /** The same moment as wall-clock ms since the epoch. */
  wallMs: number
  /** At start, this frame's values. At end, the peaks over the whole hazard (type is
   *  'red' if it was red at any point). */
  type: HazardType
  frequencyHz: number
  flashSize: number
  areaFraction: number
  graphValue: number
  /** How long the hazard lasted. Null at start. */
  durationMs: number | null
}

/** The API the preload script exposes to the renderers as window.api. */
export interface CalmFrameApi {
  // overlay renderer
  sendCaptureStats(stats: CaptureStats): void
  sendCaptureError(message: string): void
  sendSelfCheckResult(result: SelfCheckResult): void
  onSelfCheckRun(callback: () => void): void
  onCaptureRestart(callback: (size: CaptureSize) => void): void
  sendDetectionStats(stats: DetectionStats): void
  sendHazardEvent(event: HazardEvent): void
  sendGridSelfTest(result: GridSelfTestResult): void
  sendPipelineError(message: string): void
  sendSmoothSelfTest(result: SmoothSelfTestResult): void
  sendHeartbeat(heartbeat: Heartbeat): void
  sendStateChange(change: StateChange): void
  sendThumbnails(thumbnails: Thumbnails): void
  sendFlashEvent(event: FlashEventMessage): void
  onProtection(callback: (enabled: boolean, reason: string) => void): void
  onDebugFreeze(callback: (ms: number) => void): void
  startNativeCapture(): Promise<NativeCaptureStart>
  onNativeCaptureError(callback: (message: string) => void): void
  // every renderer
  getInit(): Promise<InitInfo>
  onSettings(callback: (settings: Settings) => void): void
  // dashboard and debug window
  updateSettings(patch: Partial<Settings>): void
  setProtection(enabled: boolean): Promise<boolean>
  onStatusBeat(callback: (beat: StatusBeat) => void): void
  onThumbnails(callback: (thumbnails: Thumbnails) => void): void
  onFlashEvent(callback: (event: FlashEventMessage) => void): void
  // debug window
  runSelfCheck(): void
  restartCapture(size: CaptureSize): void
  setDebugOnTop(onTop: boolean): void
  onCaptureStats(callback: (stats: CaptureStats) => void): void
  onSelfCheckResult(callback: (result: SelfCheckResult) => void): void
  onOverlayState(callback: (state: OverlayState) => void): void
  onDetectionStats(callback: (stats: DetectionStats) => void): void
  onHazardEvent(callback: (event: HazardEvent) => void): void
  onGridSelfTest(callback: (result: GridSelfTestResult) => void): void
  onSmoothSelfTest(callback: (result: SmoothSelfTestResult) => void): void
  onStateChange(callback: (change: StateChange) => void): void
}
