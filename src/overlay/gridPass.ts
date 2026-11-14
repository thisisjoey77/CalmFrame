/**
 * GPU Pass A: upload a captured frame, linearise it and area-average it to the 96x54 grid,
 * then read the grid back. docs/SPEC.md, "The per-frame loop", steps 2 and 3.
 *
 * Live frames are read back asynchronously: readPixels into a pixel buffer, a fence, and a
 * copy once the GPU has signalled it. A synchronous readPixels waited a whole vsync (about
 * 17 ms) whenever another window of the app animated, which blocked the overlay's main
 * thread and cost captured frames. The startup self-test still reads synchronously.
 *
 * Phase 4 adds Passes B and C on the same context, reading the uploaded frame from
 * `source`.
 */

import { GRID_CELLS, GRID_COLS, GRID_READBACK_SLOTS, GRID_ROWS } from '../shared/config'
import { FULLSCREEN_VS, GRID_FS } from './shaders'

/** Timing of one finished read-back, handed over with its grid. Reused between calls. */
export interface GridReadback {
  /** Capture timestamp of the frame the grid came from. */
  tMs: number
  /** Main-thread time to upload the frame, draw Pass A and start the read-back. */
  issueMs: number
  /** From starting the read-back to collecting it: GPU latency, not main-thread time. */
  waitMs: number
  /** Main-thread time to copy the finished grid out of its buffer. */
  copyMs: number
  /** All slots were busy, so this copy waited for the GPU. */
  forced: boolean
}

export type GridConsumer = (grid: Float32Array, info: GridReadback) => void

interface Slot {
  buffer: WebGLBuffer
  sync: WebGLSync | null
  tMs: number
  issueMs: number
  issuedAt: number
}

export class GridPass {
  /** Linear R, G, B and A = 1 per cell, row-major, row 0 at the top. Overwritten by run()
   *  and collect(). */
  readonly grid = new Float32Array(GRID_CELLS * 4)
  /** The latest uploaded frame, sRGB-encoded RGBA8. */
  readonly source: WebGLTexture
  /** Size of the latest uploaded frame. */
  width = 0
  height = 0

  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly gridTexture: WebGLTexture
  private readonly framebuffer: WebGLFramebuffer
  /** Read-backs in flight, oldest first, and the slots free for the next one. */
  private readonly inFlight: Slot[] = []
  private readonly free: Slot[] = []
  private readonly info: GridReadback = {
    tMs: 0,
    issueMs: 0,
    waitMs: 0,
    copyMs: 0,
    forced: false
  }

  constructor(private readonly gl: WebGL2RenderingContext) {
    // Rendering to (and reading back) a float texture needs this extension in WebGL2.
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float is not supported, so the grid cannot be float')
    }

    this.program = linkProgram(gl, FULLSCREEN_VS, GRID_FS)
    gl.useProgram(this.program)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_src'), 0)
    this.vao = gl.createVertexArray()

    this.source = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    // texelFetch ignores filtering, but a texture without mipmaps is only complete with a
    // non-mipmap minification filter.
    setNearestClamp(gl)

    this.gridTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.gridTexture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, GRID_COLS, GRID_ROWS)
    setNearestClamp(gl)

    this.framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.gridTexture,
      0
    )
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`grid framebuffer incomplete (status 0x${status.toString(16)})`)
    }

    for (let i = 0; i < GRID_READBACK_SLOTS; i++) {
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.grid.byteLength, gl.STREAM_READ)
      this.free.push({ buffer, sync: null, tMs: 0, issueMs: 0, issuedAt: 0 })
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)

    // Uploads keep the source's top row at texel row 0 and its colours untouched.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    checkError(gl, 'Pass A setup')
  }

  /** Read-backs started and not yet collected. */
  get pending(): number {
    return this.inFlight.length
  }

  /**
   * Upload the video's current frame. The size is read from the frame every time and
   * texImage2D reallocates the texture, so a capture-size change is picked up at once.
   */
  uploadVideo(video: HTMLVideoElement): void {
    const gl = this.gl
    this.width = video.videoWidth
    this.height = video.videoHeight
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
  }

  /** Upload generated sRGB RGBA8 pixels, row 0 at the top (startup self-test). */
  uploadPixels(pixels: Uint8Array, width: number, height: number): void {
    const gl = this.gl
    this.width = width
    this.height = height
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  }

  /**
   * Live frame: upload it, draw Pass A and start reading the grid back, without waiting.
   * The grid arrives later through collect(). If every slot is busy, the oldest is
   * collected first, waiting for the GPU if it must.
   * @param tMs the frame's capture timestamp, handed back with its grid
   */
  analyse(video: HTMLVideoElement, tMs: number, onGrid: GridConsumer): void {
    if (this.free.length === 0) this.collect(onGrid, true)
    const gl = this.gl
    const t0 = performance.now()
    this.uploadVideo(video)
    this.draw()
    const slot = this.free.pop() as Slot
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
    gl.readPixels(0, 0, GRID_COLS, GRID_ROWS, gl.RGBA, gl.FLOAT, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    // Submit now, so the fence can signal while this thread does other work.
    gl.flush()
    const t1 = performance.now()
    slot.tMs = tMs
    slot.issueMs = t1 - t0
    slot.issuedAt = t1
    this.inFlight.push(slot)
  }

  /**
   * Hand every finished read-back to onGrid, oldest first, so grids arrive in capture
   * order. A fence's status only updates between tasks, so call this from a later task
   * than analyse(). With force, the oldest is collected even if unfinished (a stall).
   * @returns how many grids were handed over
   */
  collect(onGrid: GridConsumer, force = false): number {
    const gl = this.gl
    let n = 0
    while (this.inFlight.length > 0) {
      const slot = this.inFlight[0]
      const ready =
        slot.sync !== null && gl.getSyncParameter(slot.sync, gl.SYNC_STATUS) === gl.SIGNALED
      const forced = !ready && force && n === 0
      if (!ready && !forced) break
      const c0 = performance.now()
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.grid)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      const c1 = performance.now()
      this.inFlight.shift()
      this.release(slot)
      const info = this.info
      info.tMs = slot.tMs
      info.issueMs = slot.issueMs
      info.waitMs = c0 - slot.issuedAt
      info.copyMs = c1 - c0
      info.forced = forced
      n++
      onGrid(this.grid, info)
    }
    return n
  }

  /** Drop every read-back in flight, e.g. when the capture restarts. */
  cancel(): void {
    while (this.inFlight.length > 0) this.release(this.inFlight.shift() as Slot)
  }

  /**
   * Area-average the uploaded frame to the grid and read it back into `grid`, waiting for
   * the GPU. For the startup self-test; live frames use analyse() and collect().
   */
  run(): Float32Array {
    const gl = this.gl
    this.draw()
    // Row 0 of the result is framebuffer row 0, which the shader fills from the top of the
    // image.
    gl.readPixels(0, 0, GRID_COLS, GRID_ROWS, gl.RGBA, gl.FLOAT, this.grid)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return this.grid
  }

  /** Draw Pass A into the grid target, leaving that framebuffer bound for the read. */
  private draw(): void {
    const gl = this.gl
    if (this.width < GRID_COLS || this.height < GRID_ROWS) {
      throw new Error(`frame ${this.width}x${this.height} is smaller than the grid`)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.viewport(0, 0, GRID_COLS, GRID_ROWS)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  private release(slot: Slot): void {
    if (slot.sync) this.gl.deleteSync(slot.sync)
    slot.sync = null
    this.free.push(slot)
  }
}

function setNearestClamp(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('createShader failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`shader compile failed: ${log}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`)
  }
  return program
}

function checkError(gl: WebGL2RenderingContext, where: string): void {
  const error = gl.getError()
  if (error !== gl.NO_ERROR) throw new Error(`WebGL error 0x${error.toString(16)} in ${where}`)
}
