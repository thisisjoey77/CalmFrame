/**
 * Live detection: the analysis half of the per-frame loop (docs/SPEC.md, "The per-frame
 * loop", steps 2 to 5). Pass A to the grid, the detector, then the state machine.
 *
 * Each frame callback uploads the frame and starts Pass A with an asynchronous read-back.
 * The grid is collected as soon as the GPU signals it (polled between tasks), and the
 * detector runs on it with that frame's own capture timestamp, in capture order.
 *
 * Runs in the overlay renderer. Only stats every few frames and hazard start/end events
 * leave this module. Frames never cross IPC.
 */

import { ANALYSIS_STATS_WINDOW } from '../shared/config'
import type { DetectionStats, HazardEvent } from '../shared/messages'
import { Detector, type DetectorResult, type HazardType } from '../core/detector'
import { OverlayStateMachine } from '../core/stateMachine'
import type { GridPass, GridReadback } from './gridPass'
import { SampleRing } from './stats'

export interface AnalysisSink {
  hazardEvent(event: HazardEvent): void
  /** Analysis failed outside a frame callback. The caller fails open. */
  failed(error: unknown): void
}

export class LiveAnalysis {
  // The GPU reads back RGBA, so the detector takes four values per cell.
  private detector = new Detector({ inputChannels: 4 })
  private machine = new OverlayStateMachine()
  private captureFps = 0
  private stopped = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  // Timing over recent frames. Main-thread cost is issue + copy + detector.
  private readonly totalMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly issueMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly copyMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly detectorMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private readonly waitMs = new SampleRing(ANALYSIS_STATS_WINDOW)
  private forced = 0

  private last: DetectorResult | null = null
  private lastT = 0
  private frames = 0

  // Since the last stats message.
  private periodGraphMax = 0
  private periodHazard = false

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
    private readonly sink: AnalysisSink
  ) {}

  /**
   * Start analysing one captured frame. Its result arrives once the GPU is done.
   * @param tMs the frame's capture timestamp (performance clock)
   * @param captureFps measured capture rate, for the filter's frames per half-cycle
   */
  frame(video: HTMLVideoElement, tMs: number, captureFps: number): void {
    if (this.stopped) return
    this.captureFps = captureFps
    this.pass.collect(this.onGrid)
    this.pass.analyse(video, tMs, this.onGrid)
    this.schedulePoll()
  }

  /** Stop for good (fail open): drop read-backs in flight and stop polling. */
  stop(): void {
    this.stopped = true
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.pass.cancel()
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
      state: this.machine.state,
      analysisMedianMs: this.totalMs.percentile(0.5),
      analysisP95Ms: this.totalMs.percentile(0.95),
      issueMedianMs: this.issueMs.percentile(0.5),
      copyMedianMs: this.copyMs.percentile(0.5),
      detectorMedianMs: this.detectorMs.percentile(0.5),
      readbackWaitMedianMs: this.waitMs.percentile(0.5),
      readbackWaitP95Ms: this.waitMs.percentile(0.95),
      forcedReadbacks: this.forced,
      framesAnalysed: this.frames
    }
    this.periodGraphMax = 0
    this.periodHazard = false
    return out
  }

  /**
   * Forget all history, e.g. when the capture restarts. A hazard in progress is ended at
   * the last frame seen, so the log never shows a start without an end.
   */
  reset(): void {
    this.pass.cancel()
    if (this.hazardOn) this.endHazard(this.lastT)
    this.detector = new Detector({ inputChannels: 4 })
    this.machine = new OverlayStateMachine()
    for (const ring of [this.totalMs, this.issueMs, this.copyMs, this.detectorMs, this.waitMs]) {
      ring.clear()
    }
    this.forced = 0
    this.last = null
    this.frames = 0
    this.periodGraphMax = 0
    this.periodHazard = false
  }

  /** One finished grid: detector, state machine, bookkeeping. */
  private readonly onGrid = (grid: Float32Array, info: GridReadback): void => {
    const t0 = performance.now()
    const d = this.detector.step(grid, info.tMs)
    this.machine.step(info.tMs, d, this.captureFps)
    const detectorMs = performance.now() - t0

    this.totalMs.push(info.issueMs + info.copyMs + detectorMs)
    this.issueMs.push(info.issueMs)
    this.copyMs.push(info.copyMs)
    this.detectorMs.push(detectorMs)
    this.waitMs.push(info.waitMs)
    if (info.forced) this.forced++
    this.frames++
    this.last = d
    this.lastT = info.tMs
    if (d.graphValue > this.periodGraphMax) this.periodGraphMax = d.graphValue
    if (d.hazard) this.periodHazard = true
    this.trackHazard(d, info.tMs)
  }

  private schedulePoll(): void {
    if (this.stopped || this.pollTimer !== null || this.pass.pending === 0) return
    this.pollTimer = setTimeout(this.poll, 0)
  }

  private readonly poll = (): void => {
    this.pollTimer = null
    if (this.stopped) return
    try {
      this.pass.collect(this.onGrid)
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
