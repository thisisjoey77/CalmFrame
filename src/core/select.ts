/**
 * In-place order statistics for the detector's median and 90th percentile (Step 8).
 * Quickselect on a preallocated scratch array, so nothing is allocated per frame.
 */

/** Rearranges a[0..n) so a[k] holds the k-th smallest value, and returns it. */
export function selectKth(a: Float64Array, n: number, k: number): number {
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    // Median of three as the pivot keeps sorted and constant inputs fast.
    const mid = (lo + hi) >> 1
    if (a[mid] < a[lo]) swap(a, mid, lo)
    if (a[hi] < a[lo]) swap(a, hi, lo)
    if (a[hi] < a[mid]) swap(a, hi, mid)
    const pivot = a[mid]
    let i = lo
    let j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) {
        swap(a, i, j)
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  return a[k]
}

/**
 * Nearest-rank percentile of a[0..n): the smallest value with at least p of the samples
 * at or below it. p = 0.5 gives the lower median. Returns 0 for no samples. Reorders a.
 */
export function percentile(a: Float64Array, n: number, p: number): number {
  if (n <= 0) return 0
  const k = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))
  return selectKth(a, n, k)
}

function swap(a: Float64Array, i: number, j: number): void {
  const t = a[i]
  a[i] = a[j]
  a[j] = t
}
