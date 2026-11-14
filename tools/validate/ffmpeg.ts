/**
 * The ffmpeg calls the validator needs: find the binary, read a video's size, read each
 * frame's presentation time, decode frames to RGBA, and encode generated frames.
 *
 * Only ffmpeg itself is required (no ffprobe), so the copy bundled with the Python package
 * imageio-ffmpeg works: `pip install imageio-ffmpeg` installs it with no system change.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The IRIS virtualenv the README sets up: ~/.calmframe/iris-venv. */
export const DEFAULT_VENV = join(homedir(), '.calmframe', 'iris-venv')

export function venvExecutable(venv: string, name: string): string {
  return process.platform === 'win32'
    ? join(venv, 'Scripts', `${name}.exe`)
    : join(venv, 'bin', name)
}

const runs = (cmd: string, args: string[]): boolean => {
  const r = spawnSync(cmd, args, { stdio: 'ignore' })
  return r.status === 0
}

/**
 * ffmpeg, in this order: $CALMFRAME_FFMPEG, `ffmpeg` on the PATH, the copy bundled with
 * imageio-ffmpeg in the IRIS virtualenv (or the Python in $CALMFRAME_PYTHON).
 */
export function findFfmpeg(): string {
  const fromEnv = process.env['CALMFRAME_FFMPEG']
  if (fromEnv) return fromEnv
  if (runs('ffmpeg', ['-version'])) return 'ffmpeg'
  const python = process.env['CALMFRAME_PYTHON'] ?? venvExecutable(DEFAULT_VENV, 'python')
  if (existsSync(python) || python === process.env['CALMFRAME_PYTHON']) {
    const r = spawnSync(
      python,
      ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
      {
        encoding: 'utf8'
      }
    )
    const path = r.stdout?.trim()
    if (r.status === 0 && path) return path
  }
  throw new Error(
    'ffmpeg not found. Install it, set CALMFRAME_FFMPEG, or `pip install imageio-ffmpeg` in ~/.calmframe/iris-venv'
  )
}

export interface VideoInfo {
  width: number
  height: number
}

/** Size of the first video stream, from ffmpeg's own report on the file. */
export function probeVideo(ffmpeg: string, file: string): VideoInfo {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const text = r.stderr ?? ''
  const line = text.split(/\r?\n/).find((l) => /Stream #.*Video:/.test(l))
  const size = line && /[ ,](\d{2,5})x(\d{2,5})[ ,[]/.exec(line)
  if (!size) throw new Error(`could not read the video size of ${file}`)
  return { width: Number(size[1]), height: Number(size[2]) }
}

/**
 * Presentation time of every frame of the first video stream, in ms from the first,
 * in output order. One decode with ffmpeg's showinfo filter.
 */
export function framePresentationTimes(ffmpeg: string, file: string): number[] {
  const r = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-fps_mode',
      'passthrough',
      '-vf',
      'showinfo',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  if (r.status !== 0) throw new Error(`ffmpeg could not read ${file}: ${r.stderr?.slice(-500)}`)
  const times: number[] = []
  for (const line of (r.stderr ?? '').split(/\r?\n/)) {
    const m = /Parsed_showinfo.*\sn:\s*\d+\s.*pts_time:\s*(-?[\d.]+)/.exec(line)
    if (m) times.push(Number(m[1]) * 1000)
  }
  const first = times.length ? times[0] : 0
  return times.map((t) => t - first)
}

/**
 * Decode every frame of the first video stream to RGBA8 and hand each to onFrame, in
 * presentation order. The buffer is reused: read it before returning.
 * @returns the number of frames decoded
 */
export function decodeFrames(
  ffmpeg: string,
  file: string,
  info: VideoInfo,
  onFrame: (rgba: Uint8Array, index: number) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const frameBytes = info.width * info.height * 4
    const frame = new Uint8Array(frameBytes)
    let filled = 0
    let index = 0
    let failed = false
    const proc = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-'
    ])
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.stdout.on('data', (chunk: Buffer) => {
      if (failed) return
      let offset = 0
      try {
        while (offset < chunk.length) {
          const n = Math.min(frameBytes - filled, chunk.length - offset)
          frame.set(chunk.subarray(offset, offset + n), filled)
          filled += n
          offset += n
          if (filled === frameBytes) {
            onFrame(frame, index++)
            filled = 0
          }
        }
      } catch (error) {
        failed = true
        proc.kill()
        reject(error)
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (failed) return
      if (code !== 0) reject(new Error(`ffmpeg failed on ${file}: ${stderr.slice(-500)}`))
      else resolve(index)
    })
  })
}

/**
 * Encode frames to an H.264 MP4. frame(i) returns packed RGB24 for frame i.
 */
export function encodeClip(
  ffmpeg: string,
  out: string,
  width: number,
  height: number,
  fps: number,
  crf: number,
  count: number,
  frame: (i: number) => Uint8Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${width}x${height}`,
      '-r',
      String(fps),
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out
    ])
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg could not write ${out}: ${stderr.slice(-500)}`))
      else resolve()
    })
    let i = 0
    const pump = (): void => {
      while (i < count) {
        const ok = proc.stdin.write(frame(i++))
        if (!ok) {
          proc.stdin.once('drain', pump)
          return
        }
      }
      proc.stdin.end()
    }
    pump()
  })
}

/** Frame rate of the first video stream as ffmpeg reports it, or null if it does not. */
export function probeFps(ffmpeg: string, file: string): number | null {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const line = (r.stderr ?? '').split(/\r?\n/).find((l) => /Stream #.*Video:/.test(l))
  const fps = line && /([\d.]+) fps/.exec(line)
  const value = fps ? Number(fps[1]) : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

export interface ReadOptions {
  /** Every frame is scaled to fit this size, keeping its shape, with black bars to fill. */
  width: number
  height: number
  /** Frames are resampled to this constant rate, so a recording with an uneven frame rate
   *  (most screen recorders') comes out evenly timed. */
  fps: number
  /** Start this many seconds into the file. */
  startS?: number
  /** Stop after this many seconds. */
  durationS?: number
}

/**
 * Decode the first video stream to RGBA8 frames of a fixed size at a constant frame rate,
 * one at a time, for the offline render. The buffer is reused: use it before asking for the
 * next frame.
 */
export async function* readFrames(
  ffmpeg: string,
  file: string,
  options: ReadOptions
): AsyncGenerator<Uint8Array, void, void> {
  const { width, height, fps } = options
  const args = ['-hide_banner', '-loglevel', 'error']
  if (options.startS !== undefined) args.push('-ss', String(options.startS))
  args.push('-i', file)
  if (options.durationS !== undefined) args.push('-t', String(options.durationS))
  args.push(
    '-map',
    '0:v:0',
    '-vf',
    `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=area,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-'
  )
  const proc = spawn(ffmpeg, args)
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const closed = new Promise<number | null>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', resolve)
  })
  const frameBytes = width * height * 4
  const frame = new Uint8Array(frameBytes)
  let filled = 0
  let finished = false
  try {
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      let offset = 0
      while (offset < chunk.length) {
        const n = Math.min(frameBytes - filled, chunk.length - offset)
        frame.set(chunk.subarray(offset, offset + n), filled)
        filled += n
        offset += n
        if (filled === frameBytes) {
          filled = 0
          yield frame
        }
      }
    }
    finished = true
  } finally {
    // The caller stopped early, or something threw: do not leave ffmpeg running.
    if (!finished) proc.kill()
  }
  const code = await closed
  if (code !== 0) throw new Error(`ffmpeg could not read ${file}: ${stderr.slice(-500)}`)
}

/**
 * Encode RGBA8 frames, handed over one at a time, to an H.264 MP4 marked as BT.709, the
 * colour standard players assume for HD video.
 */
export class FrameWriter {
  private readonly proc: ReturnType<typeof spawn>
  private readonly done: Promise<void>
  private stderr = ''

  constructor(
    ffmpeg: string,
    out: string,
    width: number,
    height: number,
    fps: number,
    crf: number
  ) {
    this.proc = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-r',
      String(fps),
      '-i',
      '-',
      '-vf',
      'scale=out_color_matrix=bt709:out_range=tv',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-movflags',
      '+faststart',
      out
    ])
    this.proc.stderr?.on('data', (d: Buffer) => (this.stderr += d.toString()))
    this.done = new Promise<void>((resolve, reject) => {
      this.proc.on('error', reject)
      this.proc.on('close', (code) => {
        if (code !== 0)
          reject(new Error(`ffmpeg could not write ${out}: ${this.stderr.slice(-500)}`))
        else resolve()
      })
    })
    // A failed encoder closes its input; the real error is reported by close().
    this.proc.stdin?.on('error', () => undefined)
  }

  /** Hand over one frame. Resolves when ffmpeg is ready for the next. The bytes are copied. */
  write(rgba: Uint8Array): Promise<void> {
    const stdin = this.proc.stdin
    if (!stdin) return Promise.reject(new Error('the encoder has no input'))
    return new Promise((resolve) => {
      if (stdin.write(Buffer.from(rgba))) resolve()
      else stdin.once('drain', () => resolve())
    })
  }

  /** Finish the file. */
  close(): Promise<void> {
    this.proc.stdin?.end()
    return this.done
  }
}
