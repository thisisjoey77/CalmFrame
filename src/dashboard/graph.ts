/**
 * Scrolling graph of the detector's graph value (docs/SPEC.md, Step 8): flashes per second
 * over a hazardous area, against the limit line at 3. Plotted by capture time, so the
 * x axis is real time even when frames are dropped. Used by the dashboard and the debug
 * window.
 *
 * Kept calm on purpose: it sits on the screen being analysed, so it uses thin lines and
 * muted colours, and nothing in it blinks.
 */

import { GRAPH_LIMIT_FLASHES_PER_SEC } from '../shared/config'

interface Sample {
  t: number
  value: number
  hazard: boolean
}

export interface GraphOptions {
  /** Time span shown, in ms. */
  windowMs: number
  /** The smallest top of the y axis, in flashes per second. It grows to fit a peak. */
  minYMax: number
  /** Label size in CSS pixels. Default 10. */
  fontPx?: number
  /** Width of the series line in CSS pixels. Default 1.5. */
  lineWidth?: number
}

const COLORS = {
  background: '#1b1f24',
  grid: '#30363d',
  label: '#b5bec8',
  limit: '#d29922',
  safe: '#58a6ff',
  hazard: '#f47067'
}

export class ScrollingGraph {
  private samples: Sample[] = []
  private readonly ctx: CanvasRenderingContext2D
  private readonly fontPx: number
  private readonly lineWidth: number

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: GraphOptions
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2D canvas context for the graph')
    this.ctx = ctx
    this.fontPx = options.fontPx ?? 10
    this.lineWidth = options.lineWidth ?? 1.5
  }

  /** Add a sample at capture time tMs and drop the ones that scrolled off. */
  push(tMs: number, value: number, hazard: boolean): void {
    // Capture timestamps only move forward; a jump back means a new time base.
    const lastT = this.samples.length ? this.samples[this.samples.length - 1].t : -Infinity
    if (tMs < lastT) this.samples = []
    this.samples.push({ t: tMs, value, hazard })
    const oldest = tMs - this.options.windowMs
    while (this.samples.length > 1 && this.samples[1].t < oldest) this.samples.shift()
  }

  draw(): void {
    const { canvas, ctx } = this
    const { windowMs, minYMax } = this.options
    // Match the backing store to the displayed size so lines stay crisp.
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW === 0 || cssH === 0) return
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const font = this.fontPx
    const pad = { left: font * 3, right: 8, top: 8, bottom: font + 8 }
    const w = cssW - pad.left - pad.right
    const h = cssH - pad.top - pad.bottom
    const peak = this.samples.reduce((m, s) => Math.max(m, s.value), 0)
    const yMax = Math.max(minYMax, Math.ceil(peak) + 1)
    const newest = this.samples.length ? this.samples[this.samples.length - 1].t : 0
    const x = (t: number): number => pad.left + w * (1 - (newest - t) / windowMs)
    const y = (v: number): number => pad.top + h * (1 - v / yMax)

    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, cssW, cssH)

    ctx.font = `${font}px "Segoe UI", system-ui, sans-serif`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.lineWidth = 1
    for (const v of [0, yMax / 2, yMax]) {
      ctx.strokeStyle = COLORS.grid
      ctx.beginPath()
      ctx.moveTo(pad.left, Math.round(y(v)) + 0.5)
      ctx.lineTo(pad.left + w, Math.round(y(v)) + 0.5)
      ctx.stroke()
      ctx.fillStyle = COLORS.label
      ctx.fillText(String(v), pad.left - 6, y(v))
    }

    // The limit: more than 3 flashes per second over a hazardous area.
    const limitY = y(GRAPH_LIMIT_FLASHES_PER_SEC)
    ctx.strokeStyle = COLORS.limit
    ctx.lineWidth = Math.max(1, this.lineWidth - 0.5)
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(pad.left, limitY)
    ctx.lineTo(pad.left + w, limitY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = COLORS.limit
    ctx.textAlign = 'left'
    ctx.fillText(`limit ${GRAPH_LIMIT_FLASHES_PER_SEC}/s`, pad.left + 4, limitY - font * 0.8)

    ctx.fillStyle = COLORS.label
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(`-${windowMs / 1000} s`, pad.left, cssH - 4)
    ctx.textAlign = 'right'
    ctx.fillText('now', pad.left + w, cssH - 4)

    // The series, one segment at a time so hazard stretches take their own colour, clipped
    // to the plot so the segment scrolling off the left edge doesn't cover the labels.
    ctx.save()
    ctx.beginPath()
    ctx.rect(pad.left, 0, w, cssH)
    ctx.clip()
    ctx.lineWidth = this.lineWidth
    ctx.lineJoin = 'round'
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
