/** Value at percentile p (0..1) of the samples, nearest-rank. Null when empty. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[rank]
}
