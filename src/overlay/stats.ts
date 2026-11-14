import { percentile as selectPercentile } from '../core/select'

/** Value at percentile p (0..1) of the samples, nearest-rank. Null when empty. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[rank]
}

/**
 * The most recent `capacity` samples, with nearest-rank percentiles. Push allocates
 * nothing, so it can run every frame; percentile() is for the stats cadence.
 */
export class SampleRing {
  private readonly values: Float64Array
  private readonly scratch: Float64Array
  private next = 0
  private size = 0

  constructor(readonly capacity: number) {
    this.values = new Float64Array(capacity)
    this.scratch = new Float64Array(capacity)
  }

  push(value: number): void {
    this.values[this.next] = value
    this.next = (this.next + 1) % this.capacity
    if (this.size < this.capacity) this.size++
  }

  clear(): void {
    this.next = 0
    this.size = 0
  }

  /** Value at percentile p (0..1), nearest-rank. Null when empty. */
  percentile(p: number): number | null {
    if (this.size === 0) return null
    this.scratch.set(this.values.subarray(0, this.size))
    return selectPercentile(this.scratch, this.size, p)
  }
}
