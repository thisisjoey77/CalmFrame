/**
 * Synthetic grid sequences for the core tests: strobes, cuts and fades at 60 fps, by
 * frequency, the two levels, area and colour. The ground truth is known by construction,
 * the same idea as the validator's test clips ("Validation and measurement").
 */

import { CAPTURE_FPS, GRID_COLS, GRID_ROWS } from '../../shared/config'
import type { AreaWindow } from '../area'
import type { Detector, DetectorResult, HazardType } from '../detector'

/** A rectangle of cells. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Mix between the low state (0) and the high state (1) for one frame. `frame` and `tMs`
 * count from the start of the waveform, after the lead-in.
 */
export type Waveform = (frame: number, tMs: number) => number

/** Square strobe that starts high, so its first frame is a transition out of the lead-in.
 *  Each half-cycle lasts fps / (2 f) frames, so use 30/n Hz at 60 fps. */
export function squareWave(frequencyHz: number, fps = CAPTURE_FPS): Waveform {
  const halfFrames = fps / (2 * frequencyHz)
  return (frame) => (Math.floor(frame / halfFrames) % 2 === 0 ? 1 : 0)
}

/** A single cut from low to high. */
export const singleCut: Waveform = () => 1

/** `count` pulses of `onFrames` high frames, `offFrames` low frames apart: a cut to white
 *  and back, or lightning. */
export function pulses(count: number, onFrames: number, offFrames: number): Waveform {
  const period = onFrames + offFrames
  return (frame) => (frame < count * period && frame % period < onFrames ? 1 : 0)
}

/** Smooth loop from low to high and back, one cycle per period. */
export function fadeLoop(periodMs: number): Waveform {
  return (_frame, tMs) => 0.5 - 0.5 * Math.cos((2 * Math.PI * tMs) / periodMs)
}

/** Steady low. */
export const steady: Waveform = () => 0

export interface SequenceOptions {
  waveform: Waveform
  /** Linear level of each state: Y (= R = G = B) for grey, the R channel for red. */
  low: number
  high: number
  /** Length of the waveform, after the lead-in. */
  durationMs: number
  /** Steady low state before the waveform starts. Default 0. */
  leadInMs?: number
  /** 'grey', or 'red' for red against black (R only). Default 'grey'. */
  colour?: 'grey' | 'red'
  /** Cells that flash. Default: the whole grid. */
  region?: Rect
  /** Grey level of cells outside the region. Default: the low level. */
  background?: number
  /** Default CAPTURE_FPS (60). */
  fps?: number
  /** Timestamp of the first frame, ms. Default 0. */
  startMs?: number
}

export interface SyntheticFrame {
  /** Linear RGB per cell. The same buffer is reused for every frame. */
  rgb: Float32Array
  tMs: number
  /** Index from the first frame, lead-in included. */
  frame: number
  /** Index within the waveform; negative during the lead-in. */
  waveFrame: number
}

export function* syntheticFrames(options: SequenceOptions): Generator<SyntheticFrame> {
  const fps = options.fps ?? CAPTURE_FPS
  const frameMs = 1000 / fps
  const leadInFrames = Math.round(((options.leadInMs ?? 0) * fps) / 1000)
  const waveFrames = Math.round((options.durationMs * fps) / 1000)
  const startMs = options.startMs ?? 0
  const red = options.colour === 'red'
  const background = options.background ?? options.low
  const region = options.region ?? { x: 0, y: 0, w: GRID_COLS, h: GRID_ROWS }

  const inside = new Uint8Array(GRID_COLS * GRID_ROWS)
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) inside[y * GRID_COLS + x] = 1
  }

  const rgb = new Float32Array(GRID_COLS * GRID_ROWS * 3)
  for (let frame = 0; frame < leadInFrames + waveFrames; frame++) {
    const waveFrame = frame - leadInFrames
    const mix = waveFrame < 0 ? 0 : options.waveform(waveFrame, waveFrame * frameMs)
    const level = options.low + (options.high - options.low) * mix
    for (let i = 0, j = 0; i < inside.length; i++, j += 3) {
      if (inside[i]) {
        rgb[j] = level
        rgb[j + 1] = red ? 0 : level
        rgb[j + 2] = red ? 0 : level
      } else {
        rgb[j] = rgb[j + 1] = rgb[j + 2] = background
      }
    }
    yield { rgb, tMs: startMs + frame * frameMs, frame, waveFrame }
  }
}

/**
 * Luminance of the screen at a point and a time. x runs 0..GRID_COLS across and y runs
 * 0..GRID_ROWS down, in cells, so 1 is 20 px on a 1920x1080 screen.
 */
export type Scene = (x: number, y: number, tMs: number) => number

export interface SceneOptions {
  scene: Scene
  durationMs: number
  /** Default CAPTURE_FPS (60). Ignored when `times` is given. */
  fps?: number
  /** Capture timestamps in ms, increasing, for uneven capture. */
  times?: readonly number[]
  /** Point samples per cell in each direction, averaged. Default 4. */
  subSamples?: number
}

/**
 * Grey frames of a scene that moves, such as a scrolling page or a dragged window. Each
 * cell is the average of subSamples x subSamples points, so content that moves by part of
 * a cell changes the cell by part of its contrast, as area averaging does.
 */
export function* sceneFrames(options: SceneOptions): Generator<SyntheticFrame> {
  const fps = options.fps ?? CAPTURE_FPS
  const sub = options.subSamples ?? 4
  const count = options.times?.length ?? Math.round((options.durationMs * fps) / 1000)
  const rgb = new Float32Array(GRID_COLS * GRID_ROWS * 3)
  for (let frame = 0; frame < count; frame++) {
    const tMs = options.times ? options.times[frame] : (frame * 1000) / fps
    for (let gy = 0, j = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++, j += 3) {
        let sum = 0
        for (let sy = 0; sy < sub; sy++) {
          for (let sx = 0; sx < sub; sx++) {
            sum += options.scene(gx + (sx + 0.5) / sub, gy + (sy + 0.5) / sub, tMs)
          }
        }
        rgb[j] = rgb[j + 1] = rgb[j + 2] = sum / (sub * sub)
      }
    }
    yield { rgb, tMs, frame, waveFrame: frame }
  }
}

/** Capture timestamps at about 40 fps from a 60 Hz screen: gaps of one display frame and
 *  two, alternating. The demo laptop's capture looks like this (Phase 3 results). */
export function unevenTimes(durationMs: number): number[] {
  const displayMs = 1000 / CAPTURE_FPS
  const times: number[] = []
  for (let n = 0, k = 0; n * displayMs < durationMs; n += 1 + (k++ % 2)) times.push(n * displayMs)
  return times
}

/** A w x h rectangle centred on the grid. */
export function centredRect(w: number, h: number): Rect {
  return { x: Math.floor((GRID_COLS - w) / 2), y: Math.floor((GRID_ROWS - h) / 2), w, h }
}

/** A centred patch with the window's shape covering about `fraction` of one window. */
export function patchOfWindow(fraction: number, window: AreaWindow): Rect {
  const scale = Math.sqrt(fraction)
  return centredRect(Math.round(window.cols * scale), Math.round(window.rows * scale))
}

/** A centred patch with the grid's shape covering about `fraction` of the whole grid. */
export function patchOfGrid(fraction: number): Rect {
  const scale = Math.sqrt(fraction)
  return centredRect(Math.round(GRID_COLS * scale), Math.round(GRID_ROWS * scale))
}

/** The scalar parts of a detector result for one frame. */
export interface FrameRecord {
  frame: number
  waveFrame: number
  tMs: number
  hazard: boolean
  type: HazardType
  luminanceHazard: boolean
  redHazard: boolean
  extendedFailure: boolean
  frequencyHz: number
  flashSize: number
  areaFraction: number
  graphValue: number
  hotCells: number
  luminanceTransitions: number
  redTransitions: number
  ignoredReversals: number
}

export interface RunSummary {
  frames: FrameRecord[]
  everHazard: boolean
  firstHazard: FrameRecord | undefined
  /** Frames where at least one cell recorded a luminance transition. */
  luminanceTransitionFrames: FrameRecord[]
  redTransitionFrames: FrameRecord[]
}

function record(f: SyntheticFrame, r: DetectorResult): FrameRecord {
  return {
    frame: f.frame,
    waveFrame: f.waveFrame,
    tMs: f.tMs,
    hazard: r.hazard,
    type: r.type,
    luminanceHazard: r.luminanceHazard,
    redHazard: r.redHazard,
    extendedFailure: r.extendedFailure,
    frequencyHz: r.frequencyHz,
    flashSize: r.flashSize,
    areaFraction: r.areaFraction,
    graphValue: r.graphValue,
    hotCells: r.hotCells,
    luminanceTransitions: r.luminanceTransitions,
    redTransitions: r.redTransitions,
    ignoredReversals: r.ignoredReversals
  }
}

/** Runs a sequence through a detector and keeps every frame's result. */
export function runDetector(detector: Detector, options: SequenceOptions): RunSummary {
  return runFrames(detector, syntheticFrames(options))
}

/** Runs any frames through a detector and keeps every frame's result. */
export function runFrames(detector: Detector, source: Iterable<SyntheticFrame>): RunSummary {
  const frames: FrameRecord[] = []
  for (const f of source) frames.push(record(f, detector.step(f.rgb, f.tMs)))
  return {
    frames,
    everHazard: frames.some((r) => r.hazard),
    firstHazard: frames.find((r) => r.hazard),
    luminanceTransitionFrames: frames.filter((r) => r.luminanceTransitions > 0),
    redTransitionFrames: frames.filter((r) => r.redTransitions > 0)
  }
}
