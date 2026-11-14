/**
 * IPC channel names and message shapes shared by main, preload and the renderers.
 * Only small stats objects cross IPC. Frames never do (CLAUDE.md working rules).
 */

import type { HazardType } from '../core/detector'
import type { OverlayStateName } from '../core/stateMachine'

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
  pipelineError: 'pipeline-error'
} as const

export interface CaptureSize {
  maxWidth: number
  maxHeight: number
}

export interface CaptureStats {
  /** Frame callbacks in the last rolling second. */
  fps: number
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
  /** Overlay state machine. Phase 3 only reports it; Phase 4 acts on it. */
  state: OverlayStateName
  /** Main-thread analysis cost per frame (the Phase 3 budget), and the medians of its
   *  parts: issue (upload, Pass A, start the read-back), copy (the finished grid out of
   *  its buffer) and detector (with the state machine). */
  cost: Timing
  issueMedianMs: number | null
  copyMedianMs: number | null
  detectorMedianMs: number | null
  /** Latency per stage, from each frame's capture timestamp. Chromium stamps captureTime
   *  late (Phase 0), so the first stage and the total are understated, and nothing here
   *  sees the compositor or the display: the slow-motion footage is the end-to-end truth.
   *  Phase 4 adds decision -> overlay drawn. */
  latency: {
    captureToCallback: Timing
    /** Upload, Pass A, the GPU queue and the read-back. */
    callbackToGrid: Timing
    /** Detector and state machine. */
    gridToDecision: Timing
    captureToDecision: Timing
  }
  /** Frames skipped because every read-back slot was still busy (the GPU was behind). */
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
}
