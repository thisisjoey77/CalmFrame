/**
 * Reading the IRIS port's per-frame results (iris-pse-detection 1.1.2, `framedata.csv`).
 * Each frame has a luminance result and a red result: 0 pass, 1 warning, 2 extended
 * failure, 3 failure (docs/SPEC.md, "Comparison with IRIS", step 2). A second fails if any
 * frame in it fails, extended failures included (step 4).
 */

import { VALIDATE_SECOND_MS } from '../../src/shared/config'

export const IRIS_PASS = 0
export const IRIS_WARNING = 1
export const IRIS_EXTENDED_FAIL = 2
export const IRIS_FAIL = 3

export interface IrisFrame {
  frame: number
  tMs: number
  luminance: number
  red: number
}

export interface IrisSecond {
  second: number
  frames: number
  /** Worst luminance and red result in the second. */
  luminance: number
  red: number
}

/** "HH:MM:SS.ffffff" to milliseconds. */
export function parseTimeStamp(s: string): number {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(s.trim())
  if (!m) throw new Error(`not an IRIS time stamp: ${s}`)
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
}

export function parseIrisCsv(text: string): IrisFrame[] {
  const lines = text.trim().split(/\r?\n/)
  const header = lines[0].split(',')
  const col = (name: string): number => {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`IRIS CSV has no ${name} column`)
    return i
  }
  const frame = col('Frame')
  const time = col('TimeStamp')
  const lum = col('LuminanceFrameResult')
  const red = col('RedFrameResult')
  return lines.slice(1).map((line) => {
    const f = line.split(',')
    return {
      frame: Number(f[frame]),
      tMs: parseTimeStamp(f[time]),
      luminance: Number(f[lum]),
      red: Number(f[red])
    }
  })
}

export function irisSeconds(frames: readonly IrisFrame[]): IrisSecond[] {
  const out: IrisSecond[] = []
  for (const f of frames) {
    const second = Math.floor(f.tMs / VALIDATE_SECOND_MS)
    while (out.length <= second) {
      out.push({ second: out.length, frames: 0, luminance: IRIS_PASS, red: IRIS_PASS })
    }
    const s = out[second]
    s.frames++
    s.luminance = Math.max(s.luminance, f.luminance)
    s.red = Math.max(s.red, f.red)
  }
  return out
}

export const irisSecondFails = (s: IrisSecond): boolean =>
  s.luminance >= IRIS_EXTENDED_FAIL || s.red >= IRIS_EXTENDED_FAIL

/** A word for the worst result in a second, for the report. */
export function irisWord(s: IrisSecond): string {
  const worst = Math.max(s.luminance, s.red)
  const kind = s.red >= s.luminance && s.red > IRIS_PASS ? 'red ' : ''
  if (worst >= IRIS_FAIL) return `${kind}fail`
  if (worst >= IRIS_EXTENDED_FAIL) return `${kind}extended fail`
  if (worst >= IRIS_WARNING) return `${kind}warning`
  return 'pass'
}
