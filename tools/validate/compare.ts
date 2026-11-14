/**
 * CalmFrame against IRIS, one second at a time (docs/SPEC.md, "Comparison with IRIS"):
 * a two-by-two table (both fail, both pass, only IRIS, only CalmFrame), the percentage
 * agreement and the seconds that disagree, per clip and over the set. Run once with
 * CalmFrame in the IRIS-compatible area mode and once in the WCAG area mode.
 */

import { secondFails, type SecondRow } from './analyse'
import { irisSecondFails, irisWord, type IrisSecond } from './iris'

export interface Table {
  bothFail: number
  bothPass: number
  onlyIris: number
  onlyCalmFrame: number
}

export interface Disagreement {
  second: number
  calmFrame: string
  iris: string
}

export interface SecondComparison {
  table: Table
  disagreements: Disagreement[]
}

export const emptyTable = (): Table => ({ bothFail: 0, bothPass: 0, onlyIris: 0, onlyCalmFrame: 0 })

export function addTables(a: Table, b: Table): Table {
  return {
    bothFail: a.bothFail + b.bothFail,
    bothPass: a.bothPass + b.bothPass,
    onlyIris: a.onlyIris + b.onlyIris,
    onlyCalmFrame: a.onlyCalmFrame + b.onlyCalmFrame
  }
}

export const tableTotal = (t: Table): number =>
  t.bothFail + t.bothPass + t.onlyIris + t.onlyCalmFrame

/** Share of seconds on which the two agree, 0..1. NaN for an empty table. */
export const agreement = (t: Table): number => (t.bothFail + t.bothPass) / tableTotal(t)

/** CalmFrame's verdict on a second, in a word. */
export function calmFrameWord(row: SecondRow | undefined): string {
  if (!row || !secondFails(row)) return 'pass'
  if (row.hazard) return row.type === 'red' ? 'red hazard' : 'hazard'
  return 'extended fail'
}

/**
 * Compare second by second. A second missing on one side (a clip one tool read a frame
 * shorter) is skipped rather than counted as a pass.
 */
export function compareSeconds(
  ours: readonly SecondRow[],
  iris: readonly IrisSecond[]
): SecondComparison {
  const table = emptyTable()
  const disagreements: Disagreement[] = []
  const n = Math.min(ours.length, iris.length)
  for (let s = 0; s < n; s++) {
    const a = secondFails(ours[s])
    const b = irisSecondFails(iris[s])
    if (a && b) table.bothFail++
    else if (!a && !b) table.bothPass++
    else if (b) table.onlyIris++
    else table.onlyCalmFrame++
    if (a !== b)
      disagreements.push({ second: s, calmFrame: calmFrameWord(ours[s]), iris: irisWord(iris[s]) })
  }
  return { table, disagreements }
}

/** A whole clip's verdict: its worst second. */
export function clipVerdict(rows: readonly SecondRow[]): 'safe' | 'luminance' | 'red' | 'extended' {
  if (rows.some((r) => r.hazard && r.type === 'red')) return 'red'
  if (rows.some((r) => r.hazard)) return 'luminance'
  if (rows.some((r) => r.extendedFailure)) return 'extended'
  return 'safe'
}

export const irisClipFails = (iris: readonly IrisSecond[]): boolean => iris.some(irisSecondFails)

/** "92.7%" */
export const percent = (x: number): string =>
  Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : 'n/a'

/** The seconds of a disagreement list as compact ranges: "4, 6-9". */
export function secondRanges(seconds: readonly number[]): string {
  const out: string[] = []
  let i = 0
  while (i < seconds.length) {
    let j = i
    while (j + 1 < seconds.length && seconds[j + 1] === seconds[j] + 1) j++
    out.push(i === j ? `${seconds[i]}` : `${seconds[i]}-${seconds[j]}`)
    i = j + 1
  }
  return out.join(', ')
}
