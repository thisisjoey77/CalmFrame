/**
 * validate (docs/SPEC.md, Prompt 8, step 2): decode a video with ffmpeg, area-average each
 * frame in linear light to the 96x54 grid on the CPU, run the detector with each frame's
 * presentation time, and write one CSV row per second: largest graph value, hazard yes or
 * no, type, and the extended-failure flag.
 *
 *   node tools/validate/dist/tools/validate/validate.js <video>... [--out dir]
 *        [--area wcag|iris|calibrated] [--trigger early|strict] [--n 2|3|4] [--extended]
 *
 * With no detector options it runs the spec's two comparison setups from one decode:
 * IRIS-compatible area mode with the strict trigger and the extended-failure rule
 * (<name>.iris.csv), and WCAG area mode with the strict trigger (<name>.wcag.csv).
 * With options it runs that one setup (<name>.custom.csv).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { AreaMode, TriggerMode } from '../../src/shared/config'
import {
  COMPARISON_MODES,
  ClipAnalyser,
  rowsToCsv,
  type ModeConfig,
  type SecondRow
} from './analyse'
import { decodeFrames, findFfmpeg, framePresentationTimes, probeVideo } from './ffmpeg'

export interface ValidateResult {
  frames: number
  ms: number
  rows: Map<string, SecondRow[]>
}

/** Run the detector setups over one video file. */
export async function validateFile(
  file: string,
  modes: readonly ModeConfig[] = COMPARISON_MODES,
  ffmpeg = findFfmpeg()
): Promise<ValidateResult> {
  const t0 = Date.now()
  const info = probeVideo(ffmpeg, file)
  const times = framePresentationTimes(ffmpeg, file)
  const analyser = new ClipAnalyser(modes)
  const frames = await decodeFrames(ffmpeg, file, info, (rgba, i) => {
    if (i >= times.length) throw new Error(`${file}: more frames decoded than timed (${i + 1})`)
    analyser.frame(rgba, info.width, info.height, times[i])
  })
  if (frames !== times.length) {
    throw new Error(`${file}: decoded ${frames} frames but timed ${times.length}`)
  }
  return { frames, ms: Date.now() - t0, rows: analyser.results() }
}

/** The per-second CSVs for one file, named <video name>.<mode>.csv. */
export function writeResults(
  outDir: string,
  file: string,
  rows: Map<string, SecondRow[]>
): string[] {
  mkdirSync(outDir, { recursive: true })
  const name = basename(file, extname(file))
  const written: string[] = []
  for (const [mode, r] of rows) {
    const path = join(outDir, `${name}.${mode}.csv`)
    writeFileSync(path, rowsToCsv(r))
    written.push(path)
  }
  return written
}

/** Detector setups from the command line; the spec's two when none is given. */
export function modesFromArgs(args: readonly string[]): ModeConfig[] {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const area = value('--area') as AreaMode | undefined
  const trigger = value('--trigger') as TriggerMode | undefined
  const n = value('--n')
  const extended = args.includes('--extended')
  if (!area && !trigger && !n && !extended) return [...COMPARISON_MODES]
  if (area && !['wcag', 'iris', 'calibrated'].includes(area))
    throw new Error(`unknown --area ${area}`)
  if (trigger && !['early', 'strict'].includes(trigger))
    throw new Error(`unknown --trigger ${trigger}`)
  if (area === 'calibrated')
    throw new Error('--area calibrated needs a screen size and distance; not supported here')
  return [
    {
      name: 'custom',
      options: {
        areaMode: area ?? 'wcag',
        trigger: trigger ?? 'strict',
        streakN: n ? Number(n) : undefined,
        extendedFailure: extended
      }
    }
  ]
}

async function main(argv: string[]): Promise<void> {
  const flagsWithValue = new Set(['--out', '--area', '--trigger', '--n'])
  const files: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (flagsWithValue.has(argv[i])) i++
    else if (!argv[i].startsWith('--')) files.push(argv[i])
  }
  if (files.length === 0)
    throw new Error(
      'usage: validate <video>... [--out dir] [--area ...] [--trigger ...] [--extended]'
    )
  const outIndex = argv.indexOf('--out')
  const outDir = resolve(outIndex >= 0 ? argv[outIndex + 1] : 'measurements/validate')
  const modes = modesFromArgs(argv)
  const ffmpeg = findFfmpeg()
  for (const file of files) {
    const result = await validateFile(resolve(file), modes, ffmpeg)
    const written = writeResults(outDir, file, result.rows)
    console.log(
      `[validate] ${basename(file)}: ${result.frames} frames in ${(result.ms / 1000).toFixed(1)} s -> ${written.map((w) => basename(w)).join(', ')}`
    )
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(String(error))
    process.exit(1)
  })
}
