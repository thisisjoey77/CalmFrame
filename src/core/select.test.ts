import { describe, expect, it } from 'vitest'
import { percentile, selectKth } from './select'

function randomArray(n: number, seed: number, distinct = 1000): Float64Array {
  const a = new Float64Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    a[i] = s % distinct
  }
  return a
}

describe('selectKth', () => {
  it('matches a full sort for every k, including many duplicates', () => {
    for (const [n, distinct] of [
      [1, 10],
      [2, 10],
      [17, 1000],
      [64, 3],
      [200, 1]
    ]) {
      const sorted = Array.from(randomArray(n, n * 7 + distinct, distinct)).sort((x, y) => x - y)
      for (let k = 0; k < n; k++) {
        expect(selectKth(randomArray(n, n * 7 + distinct, distinct), n, k)).toBe(sorted[k])
      }
    }
  })

  it('only looks at the first n entries', () => {
    const a = Float64Array.from([5, 1, 3, -100, -100])
    expect(selectKth(a, 3, 0)).toBe(1)
  })
})

describe('percentile (nearest rank)', () => {
  it('gives the lower median and the 90th percentile', () => {
    const values = (): Float64Array => Float64Array.from([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])
    expect(percentile(values(), 10, 0.5)).toBe(5)
    expect(percentile(values(), 10, 0.9)).toBe(9)
    expect(percentile(values(), 10, 1)).toBe(10)
  })

  it('returns 0 for no samples', () => {
    expect(percentile(new Float64Array(4), 0, 0.5)).toBe(0)
  })
})
