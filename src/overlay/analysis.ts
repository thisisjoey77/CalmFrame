/**
 * The overlay's per-frame loop (docs/SPEC.md, "The per-frame loop"): Pass A to the grid,
 * the detector and the state machine (Phase 3), then the smoothing filter and the
 * overlay's picture (Phase 4).
 *
 * The order within a frame is chosen so that mitigation never delays detection:
 * 1. Frame callback. Upload the frame, draw Pass A, start its asynchronous read-back and
 *    fence it. Then Pass B folds the same frame into S with the latest alpha. Pass B is
 *    issued after the fence, so the read-back never waits for it. It draws only
 *    offscreen, so it presents nothing to the compositor.
 * 2. When the grid is back: the detector, the state machine and the viewer check.
 * 3. Then, only while the overlay is visible, Pass C draws d * S at the new opacity. When
 *    the opacity reaches 0 it clears the canvas once and stops drawing.
 *
 * So each frame is filtered with the alpha decided on the frame before it. Pass B can't
 * wait for its own frame's decision without adding the GPU round trip to the picture. The
 * core tests (viewerCheck.test.ts) show that the one-frame lag lets no flash through.
 *
 * Latency is measured per stage from the capture timestamp: captured -> frame callback ->
 * grid ready -> decision -> overlay drawn. The grid wait is kept separately for frames
 * analysed while the overlay was drawn, so the cost of drawing to detection is visible.
 *
 * With "Keep motion sharp" ticked (trail #10, "Stretch: correct brightness per region"), step
 * 3 draws the experimental correction pass instead: the current frame with each region's
 * brightness scaled to its running average. Its targets are updated in step 1 next to
 * Pass B, with the same alpha, on every frame whichever method is drawn, so switching
 * between the two never starts cold. Detection, the state machine and the viewer check are
 * the same for both.
 *
 * Runs in the overlay renderer. Only stats and the 96x54 thumbnails every few frames,
 * hazard and flash events, and state changes leave this module. Frames never cross IPC.
 */

import {
  ALPHA_WARM,
  ANALYSIS_STATS_WINDOW,
  DEFAULT_CONCURRENCY_RULE,
  DEFAULT_MITIGATION_METHOD,
  GRID_CELLS,
  HOLD_MS,
  RED_DESATURATION,
  type MitigationMethod
} from '../shared/config'
import type {
  DetectionStats,
  FlashEventMessage,
  HazardEvent,
  StateChange,
  Thumbnails,
  Timing
} from '../shared/messages'
import type { detectorOptionsFor } from '../shared/settings'
import { Detector, type DetectorResult, type HazardType } from '../core/detector'
import { FlashEventTracker, type FlashEvent } from '../core/events'
import { OverlayStateMachine, type OverlayStateName, type StateOutput } from '../core/stateMachine'
import { encodeGridRgba8 } from '../core/thumbnail'
import { ViewerCheck, type ViewerCheckResult } from '../core/viewerCheck'
import type { CorrectPass } from './correctPass'
import type { FrameImage, GridPass, GridReadback } from './gridPass'
import type { SmoothPass } from './smoothPass'
import { SampleRing } from './stats'

/** The detector options the user's settings choose: trigger, N and the concurrency rule. */
export type DetectorSettings = ReturnType<typeof detectorOptionsFor>

export interface AnalysisSink {
  hazardEvent(event: HazardEvent): void
  flashEvent(event: FlashEventMessage): void
  stateChange(change: StateChange): void
  /** Analysis failed outside a frame callback. The caller fails open. */
  failed(error: unknown): void
}

function timing(ring: SampleRing): Timing {
  return { median: ring.percentile(0.5), p95: ring.percentile(0.95) }
}

/** Why the state machine moved, for the log. */
function reasonFor(from: OverlayStateName, to: OverlayStateName): string {
  if (to === 'active') return from === 'release' ? 'hazard during the fade' : 'hazard'
  if (to === 'release') return `no hazard for ${HOLD_MS / 1000} s`
  if (to === 'safe') return 'fade complete'
  return ''
}

export class LiveAnalysis {
  /** The sensitivity slider and the Step 5a switch ("Ignore movement"; off is the detector
   *  as it was before the rule). */
  private options: DetectorSettings
  // The GPU reads back RGBA, so the detector and the viewer check take four values per cell.
  private detector: Detector
  private machine = new OverlayStateMachine()
  private readonly viewer = new ViewerCheck(4)
  private readonly events = new FlashEventTracker()
  // Thumbnails for the dashboard, encoded when stats are sent.
  private readonly rawThumb = new Uint8Array(GRID_CELLS * 4)
  private readonly seenThumb = new Uint8Array(GRID_CELLS * 4)
  private captureFps = 0
  private stopped = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  /** How a hazard is drawn: the user's "Keep motion sharp" setting. */
  private method: MitigationMethod = DEFAULT_MITIGATION_METHOD
  /** Protection switched on (main's kill switch and watchdog switch it off). */
  private enabled = true
  /** The latest state machine output, which Passes B and C use. */
  private alpha = ALPHA_WARM
  private dim = 1
  private opacity = 0
  private red = false
  /** The canvas currently shows the smoothed copy (Pass C ran since the last clear). */
  private drawn = false

  // Main-thread cost per frame: issue + copy + detector (the Phase 3 budget), and the
  // smoothing's own parts.
  private readonly costMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly issueMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly copyMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly detectorMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly smoothMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly drawMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly viewerMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  // Latency per stage, from the capture timestamp. Grid wait and total are split by
  // whether the overlay was drawn when the grid came back.
  private readonly toCallback = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly toGrid = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly toGridDrawn = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly toDecision = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly total = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly totalDrawn = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly toDrawn = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly captureToDrawn = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly rings = [
    this.costMs,
    this.issueMs,
    this.copyMs,
    this.detectorMs,
    this.smoothMs,
    this.drawMs,
    this.viewerMs,
    this.toCallback,
    this.toGrid,
    this.toGridDrawn,
    this.toDecision,
    this.total,
    this.totalDrawn,
    this.toDrawn,
    this.captureToDrawn
  ]
  private busySkips = 0
  private busySkipsDrawn = 0
  private framesDrawn = 0

  // The latest decision (when, and its frame's capture timestamp), and the one whose
  // Pass C is fenced for timing.
  private lastDecidedAt = 0
  private lastDecidedT = 0
  private fencedDecidedAt = 0
  private fencedT = 0

  private last: DetectorResult | null = null
  private lastT = 0
  private frames = 0

  // Since the last stats message.
  private periodGraphMax = 0
  private periodHazard = false
  private periodIgnored = 0
  private periodViewerGraph = 0

  // Viewer check, now and over the latest drawn episode.
  private viewerChecking = false
  private viewerResidual: number | null = null
  private episodePeakGraph = 0
  private episodeFlagged = false
  private episodeResidual: number | null = null

  // The hazard in progress, for its end event.
  private hazardOn = false
  private hazardStartT = 0
  private peakType: HazardType = 'none'
  private peakFrequency = 0
  private peakFlashSize = 0
  private peakArea = 0
  private peakGraph = 0

  constructor(
    private readonly pass: GridPass,
    private readonly smooth: SmoothPass,
    private readonly sink: AnalysisSink,
    options: DetectorSettings,
    /** The experimental correction pass, or null if it could not start or failed its
     *  self-test. Without it, every hazard is drawn with the smoothing filter. */
    private readonly correct: CorrectPass | null = null
  ) {
    this.options = { ...options }
    this.detector = this.makeDetector()
  }

  /** The state machine's state, for the heartbeat. */
  get state(): OverlayStateName {
    return this.machine.state
  }

  /**
   * One captured frame: hand over any finished grids, start Pass A on this frame, then
   * fold it into S with Pass B. If the GPU is still busy with earlier frames, this one is
   * skipped rather than waited for, by both passes.
   * @param tMs the frame's capture timestamp (performance clock)
   * @param captureFps measured capture rate, for the filter's frames per half-cycle
   */
  frame(image: FrameImage, tMs: number, captureFps: number): void {
    if (this.stopped) return
    this.captureFps = captureFps
    const decided = this.pass.collect(this.onGrid)
    const alpha = this.alpha
    if (this.pass.analyse(image, tMs, alpha)) {
      const t0 = performance.now()
      this.smooth.update(this.pass.width, this.pass.height, alpha)
      this.correct?.update(alpha)
      this.smoothMs.push(performance.now() - t0)
    } else if (this.drawn) {
      this.busySkipsDrawn++
    } else {
      this.busySkips++
    }
    if (decided > 0) this.present()
    if (this.smooth.drawFinished()) this.recordDrawn()
    this.schedulePoll()
  }

  /**
   * Protection on or off. Off is the Disabled state: nothing drawn, the filter kept warm.
   * @param reason for the log, e.g. 'kill switch' or 'watchdog'
   */
  setEnabled(enabled: boolean, reason: string): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    const from = this.machine.state
    if (enabled) this.machine.enable()
    else this.machine.disable()
    // Both leave the machine at its safe values: warm alpha, full brightness, invisible.
    this.alpha = ALPHA_WARM
    this.dim = 1
    this.opacity = 0
    this.red = false
    if (!this.stopped) this.present()
    const tMs = performance.now()
    this.sink.stateChange({
      tMs,
      wallMs: performance.timeOrigin + tMs,
      from,
      to: this.machine.state,
      alpha: this.alpha,
      dim: this.dim,
      opacity: this.opacity,
      red: this.red,
      reason,
      frequencyHz: 0,
      flashSize: 0
    })
  }

  /**
   * Apply the user's detector settings: the sensitivity slider's trigger and N, and the
   * concurrency rule (Step 5a). If they changed, the detector starts again with no
   * history, so a hazard in progress ends and has to be found again under the new
   * settings. The state machine carries on with its usual hold and fade, which outlasts
   * the time a running strobe needs to trigger again.
   */
  configure(options: DetectorSettings): void {
    const o = this.options
    if (
      options.trigger === o.trigger &&
      options.streakN === o.streakN &&
      options.concurrency === o.concurrency
    ) {
      return
    }
    this.options = { ...options }
    this.detector = this.makeDetector()
  }

  /**
   * The user's "Keep motion sharp" setting: which pass draws a hazard. It takes effect on
   * the next frame drawn, also in the middle of a hazard, and changes nothing else.
   */
  setMitigation(method: MitigationMethod): void {
    if (method === this.method) return
    this.method = method
    const missing = method === 'correct' && this.correct === null
    console.log(
      `[mitigation] ${method}${missing ? ' asked for, but the correction pass is not available: smoothing instead' : ''}`
    )
  }

  /** The method the overlay draws with: the setting, unless the correction pass is missing. */
  private get drawMethod(): MitigationMethod {
    return this.method === 'correct' && this.correct !== null ? 'correct' : 'smooth'
  }

  private makeDetector(): Detector {
    return new Detector({ inputChannels: 4, ...this.options })
  }

  /** The dashboard's thumbnails from the latest analysed frame: the grid the detector saw
   *  and, while the overlay is drawn, the grid the viewer saw. */
  thumbnails(): Thumbnails {
    encodeGridRgba8(this.pass.grid, 4, this.rawThumb)
    if (!this.viewerChecking) return { raw: this.rawThumb, seen: null }
    encodeGridRgba8(this.viewer.seenGrid, 3, this.seenThumb)
    return { raw: this.rawThumb, seen: this.seenThumb }
  }

  /** Stop for good (fail open): drop GPU work in flight, stop polling and leave the
   *  canvas transparent. */
  stop(): void {
    this.stopped = true
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.pass.cancel()
    this.smooth.cancelDrawFence()
    this.smooth.clear()
    this.drawn = false
  }

  /** Stats since the last call, for the debug window. */
  stats(): DetectionStats {
    const d = this.last
    const out: DetectionStats = {
      tMs: this.lastT,
      graphValue: this.periodGraphMax,
      hazard: this.periodHazard,
      type: d?.type ?? 'none',
      frequencyHz: d?.frequencyHz ?? 0,
      flashSize: d?.flashSize ?? 0,
      areaFraction: d?.areaFraction ?? 0,
      hotCells: d?.hotCells ?? 0,
      concurrency: this.options.concurrency ?? DEFAULT_CONCURRENCY_RULE,
      ignoredReversals: this.periodIgnored,
      state: this.machine.state,
      smoothing: {
        alpha: this.alpha,
        dim: this.dim,
        opacity: this.opacity,
        red: this.red,
        drawn: this.drawn,
        method: this.drawMethod
      },
      viewer: {
        checking: this.viewerChecking,
        graphValue: this.periodViewerGraph,
        residual: this.viewerResidual,
        episodePeakGraph: this.episodePeakGraph,
        episodeFlagged: this.episodeFlagged,
        episodeResidual: this.episodeResidual
      },
      cost: timing(this.costMs),
      issueMedianMs: this.issueMs.percentile(0.5),
      copyMedianMs: this.copyMs.percentile(0.5),
      detectorMedianMs: this.detectorMs.percentile(0.5),
      smoothMedianMs: this.smoothMs.percentile(0.5),
      drawMedianMs: this.drawMs.percentile(0.5),
      viewerMedianMs: this.viewerMs.percentile(0.5),
      latency: {
        captureToCallback: timing(this.toCallback),
        callbackToGrid: timing(this.toGrid),
        gridToDecision: timing(this.toDecision),
        captureToDecision: timing(this.total),
        decisionToDrawn: timing(this.toDrawn),
        captureToDrawn: timing(this.captureToDrawn)
      },
      whileDrawn: {
        callbackToGrid: timing(this.toGridDrawn),
        captureToDecision: timing(this.totalDrawn),
        busySkips: this.busySkipsDrawn,
        frames: this.framesDrawn
      },
      busySkips: this.busySkips,
      framesAnalysed: this.frames
    }
    this.periodGraphMax = 0
    this.periodHazard = false
    this.periodIgnored = 0
    this.periodViewerGraph = 0
    return out
  }

  /**
   * Forget all history, e.g. when the capture restarts. A hazard in progress is ended at
   * the last frame seen, so the log never shows a start without an end. Protection stays
   * as it was.
   */
  reset(): void {
    this.pass.cancel()
    this.smooth.cancelDrawFence()
    this.smooth.reset()
    this.correct?.reset()
    if (this.drawn) {
      this.smooth.clear()
      this.drawn = false
    }
    if (this.hazardOn) this.endHazard(this.lastT)
    const open = this.events.flush()
    if (open) this.sendFlashEvent(open)
    this.detector = this.makeDetector()
    this.machine = new OverlayStateMachine()
    if (!this.enabled) this.machine.disable()
    this.viewer.reset()
    this.alpha = ALPHA_WARM
    this.dim = 1
    this.opacity = 0
    this.red = false
    for (const ring of this.rings) ring.clear()
    this.busySkips = 0
    this.busySkipsDrawn = 0
    this.framesDrawn = 0
    this.last = null
    this.frames = 0
    this.periodGraphMax = 0
    this.periodHazard = false
    this.periodIgnored = 0
    this.periodViewerGraph = 0
  }

  /** One finished grid: detector, state machine, viewer check, bookkeeping. */
  private readonly onGrid = (grid: Float32Array, info: GridReadback): void => {
    const t0 = performance.now()
    const d = this.detector.step(grid, info.tMs)
    const from = this.machine.state
    const out = this.machine.step(info.tMs, d, this.captureFps)
    this.alpha = out.alpha
    this.dim = out.dim
    this.opacity = out.opacity
    this.red = out.red
    const decidedAt = performance.now()
    const detectorMs = decidedAt - t0
    this.lastDecidedAt = decidedAt
    this.lastDecidedT = info.tMs

    // What the viewer sees: this frame filtered with the alpha Pass B used on it (its tag),
    // drawn with this decision's d and opacity.
    const v = this.viewer.step(
      grid,
      info.tMs,
      { alpha: info.tag, dim: out.dim, opacity: this.enabled ? out.opacity : 0, red: out.red },
      d.hotMask
    )
    this.viewerMs.push(performance.now() - decidedAt)
    this.trackViewer(v, d.hazard)

    this.costMs.push(info.issueMs + info.copyMs + detectorMs)
    this.issueMs.push(info.issueMs)
    this.copyMs.push(info.copyMs)
    this.detectorMs.push(detectorMs)
    this.toCallback.push(info.startedAt - info.tMs)
    this.toDecision.push(decidedAt - info.readyAt)
    if (this.drawn) {
      this.toGridDrawn.push(info.readyAt - info.startedAt)
      this.totalDrawn.push(decidedAt - info.tMs)
      this.framesDrawn++
    } else {
      this.toGrid.push(info.readyAt - info.startedAt)
      this.total.push(decidedAt - info.tMs)
    }

    if (out.changed) this.reportChange(from, out, d, info.tMs)

    this.frames++
    this.last = d
    this.lastT = info.tMs
    if (d.graphValue > this.periodGraphMax) this.periodGraphMax = d.graphValue
    if (d.hazard) this.periodHazard = true
    this.periodIgnored += d.ignoredReversals
    this.trackHazard(d, info.tMs)
    const event = this.events.step(
      info.tMs,
      d.hazard,
      d.type,
      d.frequencyHz,
      this.enabled && out.opacity > 0
    )
    if (event) this.sendFlashEvent(event)
  }

  private sendFlashEvent(e: FlashEvent): void {
    this.sink.flashEvent({ ...e, startWallMs: performance.timeOrigin + e.startT })
  }

  /**
   * Pass C, after a batch of decisions: draw the smoothed copy while the overlay is
   * visible, or clear the canvas once when it stops being visible. Never draws otherwise,
   * so an invisible overlay presents nothing.
   */
  private present(): void {
    if (this.enabled && this.opacity > 0 && this.smooth.ready) {
      const t0 = performance.now()
      const desaturation = this.red ? RED_DESATURATION : 0
      // The correction pass reads the frame, its grid and the targets that the latest
      // frame callback left on the GPU, which all belong to one captured frame.
      if (this.correct !== null && this.drawMethod === 'correct' && this.correct.ready) {
        this.correct.draw(this.pass.width, this.pass.height, this.dim, this.opacity, desaturation)
      } else {
        this.smooth.draw(this.dim, this.opacity, desaturation)
      }
      if (this.smooth.fenceDraw()) {
        this.fencedDecidedAt = this.lastDecidedAt
        this.fencedT = this.lastDecidedT
      }
      this.drawMs.push(performance.now() - t0)
      this.drawn = true
    } else if (this.drawn) {
      this.smooth.cancelDrawFence()
      this.smooth.clear()
      this.drawn = false
    }
  }

  /** The fenced Pass C has finished on the GPU. */
  private recordDrawn(): void {
    const now = performance.now()
    this.toDrawn.push(now - this.fencedDecidedAt)
    this.captureToDrawn.push(now - this.fencedT)
  }

  private reportChange(
    from: OverlayStateName,
    out: StateOutput,
    d: DetectorResult,
    tMs: number
  ): void {
    this.sink.stateChange({
      tMs,
      wallMs: performance.timeOrigin + tMs,
      from,
      to: out.state,
      alpha: out.alpha,
      dim: out.dim,
      opacity: out.opacity,
      red: out.red,
      reason: reasonFor(from, out.state),
      frequencyHz: d.frequencyHz,
      flashSize: d.flashSize
    })
  }

  private trackViewer(v: ViewerCheckResult, inputHazard: boolean): void {
    if (v.checking && !this.viewerChecking) {
      this.episodePeakGraph = 0
      this.episodeFlagged = false
      this.episodeResidual = null
    }
    this.viewerChecking = v.checking
    this.viewerResidual = v.residual
    if (!v.checking) return
    if (v.graphValue > this.periodViewerGraph) this.periodViewerGraph = v.graphValue
    if (v.graphValue > this.episodePeakGraph) this.episodePeakGraph = v.graphValue
    if (v.hazard) this.episodeFlagged = true
    if (inputHazard && v.residual !== null) this.episodeResidual = v.residual
  }

  private schedulePoll(): void {
    if (this.stopped || this.pollTimer !== null) return
    if (this.pass.pending === 0 && !this.smooth.drawPending) return
    this.pollTimer = setTimeout(this.poll, 0)
  }

  private readonly poll = (): void => {
    this.pollTimer = null
    if (this.stopped) return
    try {
      if (this.pass.collect(this.onGrid) > 0) this.present()
      if (this.smooth.drawFinished()) this.recordDrawn()
    } catch (error) {
      this.sink.failed(error)
      return
    }
    this.schedulePoll()
  }

  private trackHazard(d: DetectorResult, tMs: number): void {
    if (d.hazard && !this.hazardOn) {
      this.hazardOn = true
      this.hazardStartT = tMs
      this.peakType = d.type
      this.peakFrequency = d.frequencyHz
      this.peakFlashSize = d.flashSize
      this.peakArea = d.areaFraction
      this.peakGraph = d.graphValue
      this.sink.hazardEvent({
        kind: 'start',
        tMs,
        wallMs: performance.timeOrigin + tMs,
        type: d.type,
        frequencyHz: d.frequencyHz,
        flashSize: d.flashSize,
        areaFraction: d.areaFraction,
        graphValue: d.graphValue,
        durationMs: null
      })
    } else if (d.hazard) {
      if (d.type === 'red') this.peakType = 'red'
      this.peakFrequency = Math.max(this.peakFrequency, d.frequencyHz)
      this.peakFlashSize = Math.max(this.peakFlashSize, d.flashSize)
      this.peakArea = Math.max(this.peakArea, d.areaFraction)
      this.peakGraph = Math.max(this.peakGraph, d.graphValue)
    } else if (this.hazardOn) {
      this.endHazard(tMs)
    }
  }

  private endHazard(tMs: number): void {
    this.hazardOn = false
    this.sink.hazardEvent({
      kind: 'end',
      tMs,
      wallMs: performance.timeOrigin + tMs,
      type: this.peakType,
      frequencyHz: this.peakFrequency,
      flashSize: this.peakFlashSize,
      areaFraction: this.peakArea,
      graphValue: this.peakGraph,
      durationMs: tMs - this.hazardStartT
    })
  }
}
