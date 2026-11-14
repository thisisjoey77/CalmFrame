/**
 * A dashboard thumbnail: the 96x54 grid (sRGB RGBA8, from the overlay) drawn on a canvas
 * no larger than 240x135 device pixels and an eighth of the screen each way
 * (thumbnailDeviceSize), so even at full contrast a flashing thumbnail stays under the WCAG
 * area limit. Sized in device pixels: at 150% scaling, 240 device pixels are 160 CSS pixels.
 */

import { GRID_COLS, GRID_ROWS } from '../shared/config'
import { thumbnailDeviceSize } from '../core/thumbnail'

export class GridThumbnail {
  private readonly ctx: CanvasRenderingContext2D
  private readonly small = document.createElement('canvas')
  private readonly smallCtx: CanvasRenderingContext2D
  private readonly image = new ImageData(GRID_COLS, GRID_ROWS)
  private dpr = 0
  private screenW = 0
  private screenH = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly emptyColor: string
  ) {
    const ctx = canvas.getContext('2d')
    this.small.width = GRID_COLS
    this.small.height = GRID_ROWS
    const smallCtx = this.small.getContext('2d')
    if (!ctx || !smallCtx) throw new Error('no 2D canvas context for a thumbnail')
    this.ctx = ctx
    this.smallCtx = smallCtx
    this.clear()
  }

  /** Follow the window to a screen with another size or scale factor. */
  private fit(): void {
    const dpr = window.devicePixelRatio || 1
    if (dpr === this.dpr && screen.width === this.screenW && screen.height === this.screenH) {
      return
    }
    this.dpr = dpr
    this.screenW = screen.width
    this.screenH = screen.height
    const size = thumbnailDeviceSize(
      Math.round(screen.width * dpr),
      Math.round(screen.height * dpr)
    )
    this.canvas.width = size.width
    this.canvas.height = size.height
    this.canvas.style.width = `${size.width / dpr}px`
    this.canvas.style.height = `${size.height / dpr}px`
  }

  draw(rgba: Uint8Array): void {
    this.fit()
    this.image.data.set(rgba.subarray(0, this.image.data.length))
    this.smallCtx.putImageData(this.image, 0, 0)
    this.ctx.imageSmoothingEnabled = true
    this.ctx.imageSmoothingQuality = 'high'
    this.ctx.drawImage(this.small, 0, 0, this.canvas.width, this.canvas.height)
  }

  clear(): void {
    this.fit()
    this.ctx.fillStyle = this.emptyColor
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
  }
}
