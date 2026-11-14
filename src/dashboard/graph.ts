/**
 * Scrolling graph of the detector's graph value (docs/SPEC.md, Step 8): flashes per second
 * over a hazardous area, against the limit line at 3. Plotted by capture time, so the
 * x axis is real time even when frames are dropped.
 *
 * Kept calm on purpose: it sits on the screen being analysed, so it uses thin lines and
 * muted colours, and nothing in it blinks.
 */

import {
  DEBUG_GRAPH_MIN_Y_MAX,
  DEBUG_GRAPH_WINDOW_MS,
  GRAPH_LIMIT_FLASHES_PER_SEC
} from '../shared/config'

interface Sample {
  t: number
  value: number
  hazard: boolean
}

const COLORS = {
  background: '#1b1f24',
  grid: '#30363d',
  label: '#9aa4ae',
  limit: '#d29922',
  safe: '#58a6ff',
  hazard: '#f47067'
}

const PAD = { left: 30, right: 8, top: 8, bottom: 18 }

export class ScrollingGraph {
  private samples: Sample[] = []
  private readonly ctx: CanvasRenderingContext2D

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2D canvas context for the graph')
    this.ctx = ctx
  }

  /** Add a sample at capture time tMs and drop the ones that scrolled off. */
  push(tMs: number, value: number, hazard: boolean): void {
    // Capture timestamps only move forward; a jump back means a new time base.
    const lastT = this.samples.length ? this.samples[this.samples.length - 1].t : -Infinity
    if (tMs < lastT) this.samples = []
    this.samples.push({ t: tMs, value, hazard })
    const oldest = tMs - DEBUG_GRAPH_WINDOW_MS
    while (this.samples.length > 1 && this.samples[1].t < oldest) this.samples.shift()
  }

  draw(): void {
    const { canvas, ctx } = this
    // Match the backing store to the displayed size so lines stay crisp.
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const w = cssW - PAD.left - PAD.right
    const h = cssH - PAD.top - PAD.bottom
    const peak = this.samples.reduce((m, s) => Math.max(m, s.value), 0)
    const yMax = Math.max(DEBUG_GRAPH_MIN_Y_MAX, Math.ceil(peak) + 1)
    const newest = this.samples.length ? this.samples[this.samples.length - 1].t : 0
    const x = (t: number): number => PAD.left + w * (1 - (newest - t) / DEBUG_GRAPH_WINDOW_MS)
    const y = (v: number): number => PAD.top + h * (1 - v / yMax)

    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, cssW, cssH)

    ctx.font = '10px "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.lineWidth = 1
    for (const v of [0, yMax / 2, yMax]) {
      ctx.strokeStyle = COLORS.grid
      ctx.beginPath()
      ctx.moveTo(PAD.left, Math.round(y(v)) + 0.5)
      ctx.lineTo(PAD.left + w, Math.round(y(v)) + 0.5)
      ctx.stroke()
      ctx.fillStyle = COLORS.label
      ctx.fillText(String(v), PAD.left - 4, y(v))
    }

    // The limit: more than 3 flashes per second over a hazardous area.
    ctx.strokeStyle = COLORS.limit
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(PAD.left, y(GRAPH_LIMIT_FLASHES_PER_SEC))
    ctx.lineTo(PAD.left + w, y(GRAPH_LIMIT_FLASHES_PER_SEC))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = COLORS.limit
    ctx.textAlign = 'left'
    ctx.fillText(
      `limit ${GRAPH_LIMIT_FLASHES_PER_SEC}/s`,
      PAD.left + 4,
      y(GRAPH_LIMIT_FLASHES_PER_SEC) - 7
    )

    ctx.fillStyle = COLORS.label
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(`-${DEBUG_GRAPH_WINDOW_MS / 1000} s`, PAD.left, cssH - 4)
    ctx.textAlign = 'right'
    ctx.fillText('now', PAD.left + w, cssH - 4)

    // The series, one segment at a time so hazard stretches take their own colour, clipped
    // to the plot so the segment scrolling off the left edge doesn't cover the labels.
    ctx.save()
    ctx.beginPath()
    ctx.rect(PAD.left, 0, w, cssH)
    ctx.clip()
    ctx.lineWidth = 1.5
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1]
      const b = this.samples[i]
      ctx.strokeStyle = b.hazard ? COLORS.hazard : COLORS.safe
      ctx.beginPath()
      ctx.moveTo(x(a.t), y(a.value))
      ctx.lineTo(x(b.t), y(b.value))
      ctx.stroke()
    }
    ctx.restore()
  }
}
