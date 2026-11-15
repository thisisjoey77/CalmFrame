/**
 * How far the picture's content moved since the last frame: the scroll of a side-scrolling
 * game, and any screen shake on top of it. Experimental, and so far only in the offline
 * render. docs/SPEC.md, "Game mode: hold the usual look".
 *
 * It compares where the edges are, not how bright the picture is, because a flash changes
 * the brightness of a frame and leaves its edges where they were. Two steps:
 *
 * 1. Coarse. The strength of the edges is summed along columns in a few horizontal bands,
 *    and along rows in a few vertical bands. The shift that best lines these profiles up
 *    with the previous frame's gives a first answer for each axis.
 * 2. Fine. The edge picture is compared with the previous one at whole-pixel shifts,
 *    starting from the coarse answer and from the recent scroll, climbing to the best
 *    match. A parabola through the best match and its neighbours gives the fraction.
 *
 * When no shift matches well (a blank frame, a cut, a frame the flash has washed out), the
 * scroll is taken to be the median of the recent trusted answers: a game scrolls at a
 * steady speed.
 */

import {
  SCROLL_BANDS_X,
  SCROLL_BANDS_Y,
  SCROLL_CLIMB_STEPS,
  SCROLL_HISTORY,
  SCROLL_MARGIN,
  SCROLL_MAX_X,
  SCROLL_MAX_Y,
  SCROLL_MIN_CORRELATION,
  SCROLL_REFERENCE_WIDTH,
  SCROLL_STRIDE
} from '../shared/config'

/** A profile or picture with less variance than this has no edges to compare. */
const MIN_VARIANCE = 1e-6

export class ScrollEstimator {
  /** This frame: how far the content moved left and up since the last frame, in pixels. */
  dx = 0
  dy = 0
  /** Correlation of the fine step's best match, -1 to 1. Under SCROLL_MIN_CORRELATION the
   *  answer above is the recent median, not a measurement. */
  correlation = 0

  private readonly maxX: number
  private readonly maxY: number
  private readonly margin: number
  private readonly reach: number
  private readonly stride: number
  private edges: Float32Array
  private previousEdges: Float32Array
  private profileX: Float32Array
  private profileY: Float32Array
  private previousProfileX: Float32Array
  private previousProfileY: Float32Array
  private readonly historyX: number[] = []
  private readonly historyY: number[] = []
  private usualX = 0
  private usualY = 0
  private primed = false
  private readonly scores = new Map<number, number>()

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    const k = width / SCROLL_REFERENCE_WIDTH
    this.margin = Math.max(3, Math.round(SCROLL_MARGIN * k))
    this.reach = this.margin - 2
    this.maxX = Math.max(1, Math.min(this.reach, Math.round(SCROLL_MAX_X * k)))
    this.maxY = Math.max(1, Math.min(this.reach, Math.round(SCROLL_MAX_Y * k)))
    this.stride = Math.max(1, Math.round(SCROLL_STRIDE * k))
    if (width <= 4 * this.margin || height <= 4 * this.margin) {
      throw new Error(`A ${width}x${height} picture is too small to measure scrolling in`)
    }
    this.edges = new Float32Array(width * height)
    this.previousEdges = new Float32Array(width * height)
    this.profileX = new Float32Array(SCROLL_BANDS_X * width)
    this.profileY = new Float32Array(SCROLL_BANDS_Y * height)
    this.previousProfileX = new Float32Array(SCROLL_BANDS_X * width)
    this.previousProfileY = new Float32Array(SCROLL_BANDS_Y * height)
  }

  /** @param luma one brightness value per pixel, row-major, on any scale (sRGB-encoded) */
  step(luma: ArrayLike<number>): void {
    const { width, height } = this
    if (luma.length < width * height) {
      throw new Error(`Expected ${width * height} values, got ${luma.length}`)
    }
    const e = this.previousEdges
    this.previousEdges = this.edges
    this.edges = e
    const px = this.previousProfileX
    this.previousProfileX = this.profileX
    this.profileX = px
    const py = this.previousProfileY
    this.previousProfileY = this.profileY
    this.profileY = py
    this.measure(luma)
    if (!this.primed) {
      this.primed = true
      return
    }

    const coarseX = bestShift(
      this.profileX,
      this.previousProfileX,
      SCROLL_BANDS_X,
      width,
      this.maxX
    )
    const coarseY = bestShift(
      this.profileY,
      this.previousProfileY,
      SCROLL_BANDS_Y,
      height,
      this.maxY
    )
    const starts = [
      [Math.round(coarseX), Math.round(coarseY)],
      [Math.round(this.usualX), Math.round(this.usualY)],
      [Math.round(this.usualX), 0],
      [Math.round(coarseX), Math.round(this.usualY)]
    ]
    this.scores.clear()
    let best = -2
    let bestX = 0
    let bestY = 0
    for (const [startX, startY] of starts) {
      let x = startX
      let y = startY
      let v = this.score(x, y)
      for (let step = 0; step < SCROLL_CLIMB_STEPS; step++) {
        let moved = false
        for (const [ox, oy] of NEIGHBOURS) {
          const w = this.score(x + ox, y + oy)
          if (w > v) {
            v = w
            x += ox
            y += oy
            moved = true
          }
        }
        if (!moved) break
      }
      if (v > best) {
        best = v
        bestX = x
        bestY = y
      }
    }
    this.correlation = best
    if (best < SCROLL_MIN_CORRELATION) {
      this.dx = this.usualX
      this.dy = this.usualY
      return
    }
    this.dx = bestX + vertex(this.score(bestX - 1, bestY), best, this.score(bestX + 1, bestY))
    this.dy = bestY + vertex(this.score(bestX, bestY - 1), best, this.score(bestX, bestY + 1))
    this.historyX.push(this.dx)
    this.historyY.push(this.dy)
    if (this.historyX.length > SCROLL_HISTORY) {
      this.historyX.shift()
      this.historyY.shift()
    }
    this.usualX = median(this.historyX)
    this.usualY = median(this.historyY)
  }

  /** This frame's edge picture, and its profiles along each axis. */
  private measure(luma: ArrayLike<number>): void {
    const { width, height, edges, profileX, profileY } = this
    profileX.fill(0)
    profileY.fill(0)
    const bandHeight = height / SCROLL_BANDS_X
    const bandWidth = width / SCROLL_BANDS_Y
    for (let y = 0; y < height - 1; y++) {
      const band = Math.min(SCROLL_BANDS_X - 1, Math.floor(y / bandHeight)) * width
      for (let x = 0; x < width - 1; x++) {
        const p = y * width + x
        const across = Math.abs(luma[p + 1] - luma[p])
        const down = Math.abs(luma[p + width] - luma[p])
        edges[p] = across + down
        profileX[band + x] += across
        profileY[Math.min(SCROLL_BANDS_Y - 1, Math.floor(x / bandWidth)) * height + y] += down
      }
    }
  }

  /** Correlation of this frame's edges with the previous frame's, shifted by (sx, sy):
   *  now(x, y) against before(x + sx, y + sy). -1 outside the reach. */
  private score(sx: number, sy: number): number {
    const { reach } = this
    if (sx < -reach || sx > reach || sy < -reach || sy > reach) return -1
    const key = (sx + reach) * (2 * reach + 1) + sy + reach
    const known = this.scores.get(key)
    if (known !== undefined) return known
    const { width, height, margin, stride, edges, previousEdges } = this
    let sa = 0
    let sb = 0
    let saa = 0
    let sbb = 0
    let sab = 0
    let n = 0
    for (let y = margin; y < height - margin; y += stride) {
      const rowNow = y * width
      const rowBefore = (y + sy) * width + sx
      for (let x = margin; x < width - margin; x += stride) {
        const a = edges[rowNow + x]
        const b = previousEdges[rowBefore + x]
        sa += a
        sb += b
        saa += a * a
        sbb += b * b
        sab += a * b
        n++
      }
    }
    const va = saa - (sa * sa) / n
    const vb = sbb - (sb * sb) / n
    const value =
      va > MIN_VARIANCE && vb > MIN_VARIANCE ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -1
    this.scores.set(key, value)
    return value
  }
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
]

/** Where a parabola through three equally spaced scores peaks, relative to the middle one. */
function vertex(left: number, centre: number, right: number): number {
  const curve = left - 2 * centre + right
  return curve < -1e-9 ? (0.5 * (left - right)) / curve : 0
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * The shift s that best lines profile `now` up with `before` (now[x] against
 * before[x + s]), by correlation summed over the bands, each weighted by how much edge it
 * holds. Whole shifts from -max to max, refined with a parabola.
 * @param length values per band
 */
function bestShift(
  now: Float32Array,
  before: Float32Array,
  bands: number,
  length: number,
  max: number
): number {
  const scores = new Float64Array(2 * max + 1)
  let top = -Infinity
  let topShift = 0
  for (let s = -max; s <= max; s++) {
    const lo = Math.max(0, -s)
    const hi = Math.min(length - 1, length - 1 - s)
    const n = hi - lo
    let total = 0
    let weight = 0
    for (let band = 0; band < bands && n >= length / 2; band++) {
      const o = band * length
      let sa = 0
      let sb = 0
      for (let x = lo; x < hi; x++) {
        sa += now[o + x]
        sb += before[o + x + s]
      }
      sa /= n
      sb /= n
      let sab = 0
      let saa = 0
      let sbb = 0
      for (let x = lo; x < hi; x++) {
        const u = now[o + x] - sa
        const v = before[o + x + s] - sb
        sab += u * v
        saa += u * u
        sbb += v * v
      }
      if (saa > MIN_VARIANCE && sbb > MIN_VARIANCE) {
        const w = Math.sqrt(Math.min(saa, sbb))
        total += (w * sab) / Math.sqrt(saa * sbb)
        weight += w
      }
    }
    const value = weight > 0 ? total / weight : -1
    scores[s + max] = value
    if (value > top) {
      top = value
      topShift = s
    }
  }
  if (topShift <= -max || topShift >= max) return topShift
  return (
    topShift +
    vertex(scores[topShift - 1 + max], scores[topShift + max], scores[topShift + 1 + max])
  )
}
