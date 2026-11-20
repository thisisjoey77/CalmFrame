/**
 * GPU correction pass: the experimental second way to calm a hazard, behind the dashboard's
 * "Keep motion sharp" tick box. docs/SPEC.md, "Stretch: correct brightness per region".
 *
 * It keeps one small piece of state, the target mean of every grid cell, in two 96x54 float
 * textures used alternately. update() folds the latest frame's grid into the targets, in
 * the same frame callback as Pass A and Pass B and with the same alpha. draw() shows the
 * current frame with each region scaled from its mean to its target.
 *
 * The frame, its grid and the targets on the GPU always belong to the same captured frame:
 * Pass A uploads the frame and draws its grid, and update() follows at once. A skipped
 * frame skips all three. So the correction a frame is drawn with was worked out from that
 * frame, and no read-back sits in the picture's path.
 *
 * Like Pass B, update() draws only offscreen, so it presents nothing. draw() presents, so
 * the caller runs it only while the overlay is visible.
 */

import { GRID_COLS, GRID_ROWS } from '../shared/config'
import { checkError, linkProgram, setNearestClamp } from './glUtil'
import { CORRECT_FS, FULLSCREEN_VS, TARGET_FS } from './shaders'

export class CorrectPass {
  private readonly targetProgram: WebGLProgram
  private readonly drawProgram: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly uAlpha: WebGLUniformLocation | null
  private readonly uTarget: WebGLUniformLocation | null
  private readonly uDim: WebGLUniformLocation | null
  private readonly uOpacity: WebGLUniformLocation | null
  private readonly uDesat: WebGLUniformLocation | null
  private readonly targets: WebGLTexture[] = []
  private readonly framebuffers: WebGLFramebuffer[] = []
  /** Which of the two textures holds the current targets. */
  private current = 0
  private seeded = false

  /**
   * @param source the texture Pass A uploads each frame into (sRGB-encoded RGBA8)
   * @param grid Pass A's grid of that frame (GridPass.gridTexture)
   * @throws if the targets cannot be rendered to; the caller then keeps the smoothing filter
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly source: WebGLTexture,
    private readonly grid: WebGLTexture
  ) {
    this.targetProgram = linkProgram(gl, FULLSCREEN_VS, TARGET_FS)
    gl.useProgram(this.targetProgram)
    gl.uniform1i(gl.getUniformLocation(this.targetProgram, 'u_grid'), 0)
    gl.uniform1i(gl.getUniformLocation(this.targetProgram, 'u_prev'), 1)
    this.uAlpha = gl.getUniformLocation(this.targetProgram, 'u_alpha')

    this.drawProgram = linkProgram(gl, FULLSCREEN_VS, CORRECT_FS)
    gl.useProgram(this.drawProgram)
    gl.uniform1i(gl.getUniformLocation(this.drawProgram, 'u_src'), 0)
    gl.uniform1i(gl.getUniformLocation(this.drawProgram, 'u_grid'), 1)
    gl.uniform1i(gl.getUniformLocation(this.drawProgram, 'u_goal'), 2)
    this.uTarget = gl.getUniformLocation(this.drawProgram, 'u_target')
    this.uDim = gl.getUniformLocation(this.drawProgram, 'u_dim')
    this.uOpacity = gl.getUniformLocation(this.drawProgram, 'u_opacity')
    this.uDesat = gl.getUniformLocation(this.drawProgram, 'u_desat')

    this.vao = gl.createVertexArray()

    // The same float format as Pass A's grid. Rendering to it needs EXT_color_buffer_float,
    // which GridPass has already required.
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, GRID_COLS, GRID_ROWS)
      setNearestClamp(gl)
      const framebuffer = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(
          `correction targets framebuffer incomplete (status 0x${status.toString(16)})`
        )
      }
      this.targets.push(texture)
      this.framebuffers.push(framebuffer)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    checkError(gl, 'correction pass setup')
  }

  /** Whether the targets hold anything yet. */
  get ready(): boolean {
    return this.seeded
  }

  /** Seed the targets from the next frame again, e.g. after a capture restart. */
  reset(): void {
    this.seeded = false
  }

  /**
   * Fold the grid Pass A has just drawn into the targets.
   * @param alpha this frame's filter step; the first frame after a reset seeds instead
   */
  update(alpha: number): void {
    const gl = this.gl
    const next = 1 - this.current
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[next])
    gl.viewport(0, 0, GRID_COLS, GRID_ROWS)
    gl.useProgram(this.targetProgram)
    gl.uniform1f(this.uAlpha, this.seeded ? alpha : 1)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.current])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.grid)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    // Unbind what was read, so later passes can render into those textures.
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.current = next
    this.seeded = true
  }

  /**
   * Draw the corrected frame, times d, at the given opacity, blended `desaturation` of the
   * way toward grey.
   * @param width size of the frame Pass A last uploaded
   * @param target an offscreen framebuffer of that size (the startup self-test), or null
   *        for the overlay canvas, whose drawing buffer follows the frame size
   */
  draw(
    width: number,
    height: number,
    dim: number,
    opacity: number,
    desaturation: number,
    target: WebGLFramebuffer | null = null
  ): void {
    if (!this.seeded) return
    const gl = this.gl
    let w = width
    let h = height
    if (target === null) {
      const canvas = gl.canvas
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      w = gl.drawingBufferWidth
      h = gl.drawingBufferHeight
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.drawProgram)
    gl.uniform2f(this.uTarget, w, h)
    gl.uniform1f(this.uDim, dim)
    gl.uniform1f(this.uOpacity, opacity)
    gl.uniform1f(this.uDesat, desaturation)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.current])
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.grid)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    // Unbind the grid and the targets: both are render targets of other passes.
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    if (target !== null) gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
}
