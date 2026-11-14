/**
 * The validator's analysis (docs/SPEC.md, "Validation and measurement"): each decoded frame
 * is area-averaged in linear light to the 96x54 grid on the CPU (the same averageToGrid the
 * overlay's GPU pass is checked against), then run through the real detector with the
 * frame's presentation time. The result is one row per second, the unit the IRIS
 * comparison works in ("Comparison with IRIS", step 4).
 *
 * One decode can feed several detector setups (say IRIS-compatible and WCAG area modes),
 * since the grid is the same for each.
 */

import { Detector, type DetectorOptions, type HazardType } from '../../src/core/detector'
import { averageToGrid } from '../../src/core/gridAverage'
import { GRID_CELLS, VALIDATE_SECOND_MS } from '../../src/shared/config'

/** One detector setup, named for the output files. */
export interface ModeConfig {
  name: string
  options: Pick<
    DetectorOptions,
    'areaMode' | 'trigger' | 'streakN' | 'extendedFailure' | 'concurrency'
  >
}

/** The detector's verdict over one second of the clip. */
export interface SecondRow {
  /** 0 for the first second of the clip. */
  second: number
  frames: number
  /** Largest graph value (Step 8) in the second: flashes per second over the area. */
  graphMax: number
  /** Any frame in the second had a hazard. */
  hazard: boolean
  /** 'red' if any hazard frame was red, else 'luminance' if any hazard, else 'none'. */
  type: HazardType
  /** Any frame in the second had the IRIS extended failure (only with that option). */
  extendedFailure: boolean
}

/** A second fails when any frame in it fails: a hazard or an extended failure. */
export const secondFails = (row: SecondRow): boolean => row.hazard || row.extendedFailure

/** The spec's two comparison setups: IRIS-compatible area mode with the strict trigger and
 *  the extended-failure rule, then the WCAG area mode with the strict trigger. */
export const COMPARISON_MODES: readonly ModeConfig[] = [
  { name: 'iris', options: { areaMode: 'iris', trigger: 'strict', extendedFailure: true } },
  { name: 'wcag', options: { areaMode: 'wcag', trigger: 'strict' } }
]

interface Run {
  config: ModeConfig
  detector: Detector
  rows: SecondRow[]
}

export class ClipAnalyser {
  private readonly grid = new Float32Array(GRID_CELLS * 4)
  private readonly runs: Run[]
  private lastT = -Infinity

  constructor(modes: readonly ModeConfig[]) {
    this.runs = modes.map((config) => ({
      config,
      // averageToGrid writes RGBA per cell.
      detector: new Detector({ ...config.options, inputChannels: 4 }),
      rows: []
    }))
  }

  /**
   * One decoded frame.
   * @param rgba sRGB RGBA8, row 0 at the top
   * @param tMs the frame's presentation time in ms from the start of the clip
   */
  frame(rgba: ArrayLike<number>, width: number, height: number, tMs: number): void {
    averageToGrid(rgba, width, height, this.grid)
    this.grid4(this.grid, tMs)
  }

  /** One frame given as the grid itself, linear RGBA per cell (tests, and callers that
   *  average elsewhere). */
  grid4(grid: Float32Array, tMs: number): void {
    if (!(tMs > this.lastT))
      throw new Error(`frame times must increase (${tMs} after ${this.lastT})`)
    this.lastT = tMs
    const second = Math.floor(tMs / VALIDATE_SECOND_MS)
    for (const run of this.runs) {
      const d = run.detector.step(grid, tMs)
      const row = rowFor(run.rows, second)
      row.frames++
      if (d.graphValue > row.graphMax) row.graphMax = d.graphValue
      // The detector's hazard flag includes the extended failure when that rule is on. The
      // CSV keeps them apart: hazard is the trigger firing, extended_failure the IRIS rule.
      if (d.redHazard) {
        row.hazard = true
        row.type = 'red'
      } else if (d.luminanceHazard) {
        row.hazard = true
        if (row.type === 'none') row.type = 'luminance'
      }
      if (d.extendedFailure) row.extendedFailure = true
    }
  }

  /** Rows per setup, by name. Seconds with no frame are filled in empty, so every second
   *  from 0 to the last appears. */
  results(): Map<string, SecondRow[]> {
    return new Map(this.runs.map((r) => [r.config.name, r.rows]))
  }
}

function rowFor(rows: SecondRow[], second: number): SecondRow {
  while (rows.length <= second) {
    rows.push({
      second: rows.length,
      frames: 0,
      graphMax: 0,
      hazard: false,
      type: 'none',
      extendedFailure: false
    })
  }
  return rows[second]
}

export const CSV_HEADER = 'second,frames,graph_max,hazard,type,extended_failure'

export function rowsToCsv(rows: readonly SecondRow[]): string {
  const lines = rows.map((r) =>
    [
      r.second,
      r.frames,
      r.graphMax.toFixed(1),
      r.hazard ? 'yes' : 'no',
      r.type,
      r.extendedFailure ? 'yes' : 'no'
    ].join(',')
  )
  return `${[CSV_HEADER, ...lines].join('\n')}\n`
}

export function csvToRows(text: string): SecondRow[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines[0] !== CSV_HEADER) throw new Error('not a validator CSV')
  return lines.slice(1).map((line) => {
    const [second, frames, graph, hazard, type, extended] = line.split(',')
    return {
      second: Number(second),
      frames: Number(frames),
      graphMax: Number(graph),
      hazard: hazard === 'yes',
      type: type as HazardType,
      extendedFailure: extended === 'yes'
    }
  })
}
