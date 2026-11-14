/**
 * IPC channel names and message shapes shared by main, preload and the renderers.
 * Only small stats objects cross IPC. Frames never do (CLAUDE.md working rules).
 */

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
  captureRestart: 'capture-restart'
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

/** The API the preload script exposes to the renderers as window.api. */
export interface CalmFrameApi {
  // overlay renderer
  sendCaptureStats(stats: CaptureStats): void
  sendCaptureError(message: string): void
  sendSelfCheckResult(result: SelfCheckResult): void
  onSelfCheckRun(callback: () => void): void
  onCaptureRestart(callback: (size: CaptureSize) => void): void
  // debug window
  runSelfCheck(): void
  restartCapture(size: CaptureSize): void
  setDebugOnTop(onTop: boolean): void
  onCaptureStats(callback: (stats: CaptureStats) => void): void
  onSelfCheckResult(callback: (result: SelfCheckResult) => void): void
  onOverlayState(callback: (state: OverlayState) => void): void
}
