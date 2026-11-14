/**
 * GPU Passes B and C: the smoothing filter and the overlay's picture. docs/SPEC.md,
 * "Mitigation math" and "The per-frame loop", steps 6 and 7.
 *
 * Pass B keeps S, the smoothed screen in linear light, in two half-float textures at
 * capture resolution, used alternately: each frame reads one and writes the other. It
 * draws only into its own framebuffers. WebGL presents a canvas to the compositor only
 * after a draw into the canvas's own drawing buffer (WebGL spec, "The Drawing Buffer"), so
 * Pass B never adds a frame to the GPU process that all of Electron's windows share. That
 * is how the filter stays warm on every frame while the overlay is invisible (Phase 3
 * results).
 *
 * Pass C draws d * S into the overlay canvas at the given opacity. It is the only pass
 * that presents, so the caller runs it only while the overlay is visible, and clears the
 * canvas once when it stops.
 */

import { checkError, linkProgram, setNearestClamp } from './glUtil'
import { DISPLAY_FS, FULLSCREEN_VS, STATE_FS } from './shaders'

export class SmoothPass {
  /** Size of the state: the size of the frames it was filtered from. */
  width = 0
  height = 0

  private readonly stateProgram: WebGLProgram
  private readonly displayProgram: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly uAlpha: WebGLUniformLocation | null
  private readonly uTarget: WebGLUniformLocation | null
  private readonly uDim: WebGLUniformLocation | null
  private readonly uOpacity: WebGLUniformLocation | null
  private readonly uDesat: WebGLUniformLocation | null
  private states: WebGLTexture[] = []
  private framebuffers: WebGLFramebuffer[] = []
  /** Which of the two textures holds the current S. */
  private current = 0
  private seeded = false
  private drawFence: WebGLSync | null = null

  /**
   * @param source the texture Pass A uploads each frame into (sRGB-encoded RGBA8)
   * @throws if the GPU cannot render to half-float textures; the caller fails open
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly source: WebGLTexture
  ) {
    requireHalfFloatTarget(gl)

    this.stateProgram = linkProgram(gl, FULLSCREEN_VS, STATE_FS)
    gl.useProgram(this.stateProgram)
    gl.uniform1i(gl.getUniformLocation(this.stateProgram, 'u_src'), 0)
    gl.uniform1i(gl.getUniformLocation(this.stateProgram, 'u_prev'), 1)
    this.uAlpha = gl.getUniformLocation(this.stateProgram, 'u_alpha')

    this.displayProgram = linkProgram(gl, FULLSCREEN_VS, DISPLAY_FS)
    gl.useProgram(this.displayProgram)
    gl.uniform1i(gl.getUniformLocation(this.displayProgram, 'u_state'), 0)
    this.uTarget = gl.getUniformLocation(this.displayProgram, 'u_target')
    this.uDim = gl.getUniformLocation(this.displayProgram, 'u_dim')
    this.uOpacity = gl.getUniformLocation(this.displayProgram, 'u_opacity')
    this.uDesat = gl.getUniformLocation(this.displayProgram, 'u_desat')

    this.vao = gl.createVertexArray()
    checkError(gl, 'Passes B and C setup')
  }

  /** Whether S holds anything yet. */
  get ready(): boolean {
    return this.seeded
  }

  /** Seed S from the next frame again, e.g. after a capture restart. */
  reset(): void {
    this.seeded = false
  }

  /**
   * Pass B: fold the frame Pass A just uploaded into S. The size comes from that frame,
   * and a new size reallocates the state and seeds it from this frame.
   * @param alpha this frame's filter step; the first frame after a reset seeds S instead
   */
  update(width: number, height: number, alpha: number): void {
    const gl = this.gl
    if (width !== this.width || height !== this.height) this.allocate(width, height)
    const next = 1 - this.current
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[next])
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.stateProgram)
    gl.uniform1f(this.uAlpha, this.seeded ? alpha : 1)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.states[this.current])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    // Unbind the state just read, so a later pass can render into it.
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.current = next
    this.seeded = true
  }

  /**
   * Pass C: draw d * S at the given opacity, blended `desaturation` of the way toward grey.
   * @param target an offscreen framebuffer the size of the state (the startup self-test),
   *        or null for the overlay canvas. The canvas's drawing buffer follows the state
   *        size, and CSS stretches it over the screen.
   */
  draw(
    dim: number,
    opacity: number,
    desaturation: number,
    target: WebGLFramebuffer | null = null
  ): void {
    if (!this.seeded) return
    const gl = this.gl
    let w = this.width
    let h = this.height
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
    gl.useProgram(this.displayProgram)
    gl.uniform2f(this.uTarget, w, h)
    gl.uniform1f(this.uDim, dim)
    gl.uniform1f(this.uOpacity, opacity)
    gl.uniform1f(this.uDesat, desaturation)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.states[this.current])
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    if (target !== null) gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Make the overlay canvas fully transparent. */
  clear(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /**
   * Put a fence after the drawing just issued, to time when the GPU finishes it. One at a
   * time: while an earlier fence is pending, this does nothing.
   * @returns whether a fence was placed
   */
  fenceDraw(): boolean {
    if (this.drawFence !== null) return false
    const gl = this.gl
    this.drawFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    return true
  }

  get drawPending(): boolean {
    return this.drawFence !== null
  }

  /** True once the fenced drawing has finished, and then the fence is gone. A fence's
   *  status only updates between tasks. */
  drawFinished(): boolean {
    const gl = this.gl
    const fence = this.drawFence
    if (fence === null || gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
      return false
    }
    gl.deleteSync(fence)
    this.drawFence = null
    return true
  }

  /** Drop a pending draw fence without timing it. */
  cancelDrawFence(): void {
    if (this.drawFence !== null) this.gl.deleteSync(this.drawFence)
    this.drawFence = null
  }

  private allocate(width: number, height: number): void {
    const gl = this.gl
    for (const t of this.states) gl.deleteTexture(t)
    for (const f of this.framebuffers) gl.deleteFramebuffer(f)
    this.states = []
    this.framebuffers = []
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height)
      setNearestClamp(gl)
      const framebuffer = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(
          `smoothing state ${width}x${height} framebuffer incomplete (status 0x${status.toString(16)})`
        )
      }
      this.states.push(texture)
      this.framebuffers.push(framebuffer)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.width = width
    this.height = height
    this.current = 0
    this.seeded = false
    checkError(gl, `allocating the ${width}x${height} smoothing state`)
  }
}

const NO_FLOAT_TARGET =
  'this GPU cannot render to half-float textures (RGBA16F), which the smoothing filter needs'

/**
 * Startup check that S can be held in a half-float render target ("Three implementation
 * requirements", floating-point state). WebGL2 makes RGBA16F renderable only with
 * EXT_color_buffer_float, so check both the extension and an actual framebuffer.
 */
function requireHalfFloatTarget(gl: WebGL2RenderingContext): void {
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error(`${NO_FLOAT_TARGET} (EXT_color_buffer_float missing)`)
  }
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 1, 1)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.bindTexture(gl.TEXTURE_2D, null)
  gl.deleteFramebuffer(framebuffer)
  gl.deleteTexture(texture)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`${NO_FLOAT_TARGET} (framebuffer status 0x${status.toString(16)})`)
  }
}
