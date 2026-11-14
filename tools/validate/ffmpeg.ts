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
