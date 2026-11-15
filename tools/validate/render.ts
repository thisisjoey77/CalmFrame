/**
 * render: turn a video file into demo footage of what CalmFrame's viewer would see.
 *
 * Screen recorders cannot see the overlay (it is excluded from capture on purpose), so a
 * recording of the live app shows the raw screen. This command reads a recording, runs
 * every frame through the app's own detector, state machine and filter arithmetic
 * (renderer.ts), and writes a video with the protected picture next to the original.
 * It is a simulation, not a recording of the live overlay, and the picture says so.
 *
 *   node tools/validate/dist/tools/validate/render.js <video> [options]
 *
 * The options are the app's settings, with the app's defaults:
 *   --sensitivity 2|3|4|strict     the sensitivity slider (3)
 *   --ignore-movement on|off       "Ignore movement" (on)
 *   --keep-motion-sharp on|off     "Keep motion sharp" (on)
 *   --flash-limit 3..10            the flash limit, per second (3, the WCAG limit)
 * and one the app does not have yet:
 *   --game-mode on|off|hold        experimental (off), with the overlay always up. It
 *                                  replaces the method --keep-motion-sharp chooses.
 *                                  on: calm by dimming in big zones, never lifting toward
 *                                  white. hold: follow the scrolling scene and hold each
 *                                  piece of it at its usual look, so only the frames that
 *                                  flash are changed.
 * and how to draw it:
 *   --layout big-small|equal|protected-only   (big-small)
 *   --info graph|full              what is written into the picture besides the two labels:
 *                                  the graph alone (default), or also the status, the
 *                                  settings used and a line saying it is an offline render
 *   --seen-line on|off             a second, green line on the graph (off): flashes per
 *                                  second in the calmed picture, measured on its pixels,
 *                                  over the original's bars, with a key above the graph
 *   --delay-frames 0..6            frames the overlay's picture is late (1)
 *   --fps N                        (the source's, at most 60)
 *   --start S, --duration S        render part of the file, in seconds
 *   --out file.mp4                 (<video name>.calmframe.mp4 next to the source)
 *
 * It prints a short report and saves it next to the video.
 */

import { writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  DEFAULT_FLASH_LIMIT,
  FLASH_LIMIT_MAX,
  FLASH_LIMIT_MIN,
  RENDER_CRF,
  RENDER_DEFAULT_DELAY_FRAMES,
  RENDER_FALLBACK_FPS,
  RENDER_MAX_DELAY_FRAMES,
  RENDER_MAX_FPS
} from '../../src/shared/config'
import {
  DEFAULT_SETTINGS,
  SENSITIVITY_POSITIONS,
  parseFlashLimit,
  parseSensitivity,
  type Settings
} from '../../src/shared/settings'
import { FrameWriter, findFfmpeg, probeFps, readFrames } from './ffmpeg'
import {
  ClipRenderer,
  INFO_LEVELS,
  LAYOUT_NAMES,
  describeLimit,
  describeSettings,
  layoutFor,
  type GameMode,
  type InfoLevel,
  type LayoutName,
  type RenderSummary
} from './renderer'

export const USAGE = `usage: render <video> [--out file.mp4]
  [--sensitivity 2|3|4|strict] [--ignore-movement on|off] [--keep-motion-sharp on|off]
  [--game-mode on|off|hold]
  [--flash-limit ${FLASH_LIMIT_MIN}..${FLASH_LIMIT_MAX}] [--layout ${LAYOUT_NAMES.join('|')}] [--info ${INFO_LEVELS.join('|')}]
  [--seen-line on|off]
  [--delay-frames 0..${RENDER_MAX_DELAY_FRAMES}] [--fps N] [--start seconds] [--duration seconds]`

export interface RenderArgs {
  file: string
  out: string | null
  settings: Settings
  gameMode: GameMode
  layout: LayoutName
  info: InfoLevel
  /** The graph's second line, the calmed picture's flashes per second (--seen-line). */
  seenLine: boolean
  delayFrames: number
  fps: number | null
  startS: number | null
  durationS: number | null
}

const FLAGS = new Set([
  '--out',
  '--sensitivity',
  '--ignore-movement',
  '--keep-motion-sharp',
  '--game-mode',
  '--flash-limit',
  '--layout',
  '--info',
  '--seen-line',
  '--delay-frames',
  '--fps',
  '--start',
  '--duration'
])

function onOff(flag: string, value: string): boolean {
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`${flag} takes on or off, got "${value}"`)
}

function numberIn(flag: string, value: string, lo: number, hi: number, whole: boolean): number {
  const n = Number(value)
  if (
    value.trim() === '' ||
    !Number.isFinite(n) ||
    n < lo ||
    n > hi ||
    (whole && !Number.isInteger(n))
  ) {
    const kind = whole ? 'a whole number' : 'a number'
    throw new Error(
      `${flag} takes ${kind} from ${lo} to ${hi === Infinity ? 'any size' : hi}, got "${value}"`
    )
  }
  return n
}

/** The command line as render options. Throws, with words for the user, on anything it
 *  does not understand, so a typo never renders with settings nobody asked for. */
export function parseRenderArgs(argv: readonly string[]): RenderArgs {
  const values = new Map<string, string>()
  const files: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      files.push(arg)
      continue
    }
    if (!FLAGS.has(arg)) throw new Error(`unknown option ${arg}\n${USAGE}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`${arg} needs a value\n${USAGE}`)
    values.set(arg, value)
  }
  if (files.length !== 1) throw new Error(`give one video file\n${USAGE}`)

  const settings: Settings = { ...DEFAULT_SETTINGS }
  const sensitivity = values.get('--sensitivity')
  if (sensitivity !== undefined) {
    const parsed = parseSensitivity(
      sensitivity === 'strict'
        ? { trigger: 'strict' }
        : { trigger: 'early', streakN: Number(sensitivity) }
    )
    if (!parsed) {
      const choices = SENSITIVITY_POSITIONS.map((s) =>
        s.trigger === 'strict' ? 'strict' : String(s.streakN)
      ).join(', ')
      throw new Error(`--sensitivity takes one of ${choices}, got "${sensitivity}"`)
    }
    settings.sensitivity = parsed
  }
  const movement = values.get('--ignore-movement')
  if (movement !== undefined) {
    settings.concurrency = onOff('--ignore-movement', movement) ? 'one-way' : 'off'
  }
  const sharp = values.get('--keep-motion-sharp')
  if (sharp !== undefined) {
    settings.mitigation = onOff('--keep-motion-sharp', sharp) ? 'correct' : 'smooth'
  }
  const limit = values.get('--flash-limit')
  if (limit !== undefined) {
    const parsed = parseFlashLimit(Number(limit))
    if (parsed === null || limit.trim() === '') {
      throw new Error(
        `--flash-limit takes a whole number from ${FLASH_LIMIT_MIN} to ${FLASH_LIMIT_MAX}, got "${limit}"`
      )
    }
    settings.flashLimit = parsed
  }

  const game = values.get('--game-mode')
  let gameMode: GameMode = 'off'
  if (game === 'hold') gameMode = 'hold'
  else if (game === 'on') gameMode = 'dim'
  else if (game !== undefined && game !== 'off') {
    throw new Error(`--game-mode takes on, off or hold, got "${game}"`)
  }

  const layout = values.get('--layout') ?? 'big-small'
  if (!LAYOUT_NAMES.includes(layout as LayoutName)) {
    throw new Error(`--layout takes one of ${LAYOUT_NAMES.join(', ')}, got "${layout}"`)
  }
  const info = values.get('--info') ?? 'graph'
  if (!INFO_LEVELS.includes(info as InfoLevel)) {
    throw new Error(`--info takes one of ${INFO_LEVELS.join(', ')}, got "${info}"`)
  }
  const seenLine = values.get('--seen-line')
  const delay = values.get('--delay-frames')
  const fps = values.get('--fps')
  const start = values.get('--start')
  const duration = values.get('--duration')
  return {
    file: files[0],
    out: values.get('--out') ?? null,
    settings,
    gameMode,
    layout: layout as LayoutName,
    info: info as InfoLevel,
    seenLine: seenLine === undefined ? false : onOff('--seen-line', seenLine),
    delayFrames:
      delay === undefined
        ? RENDER_DEFAULT_DELAY_FRAMES
        : numberIn('--delay-frames', delay, 0, RENDER_MAX_DELAY_FRAMES, true),
    fps: fps === undefined ? null : numberIn('--fps', fps, 1, RENDER_MAX_FPS, false),
    startS: start === undefined ? null : numberIn('--start', start, 0, Infinity, false),
    durationS:
      duration === undefined ? null : numberIn('--duration', duration, 0.1, Infinity, false)
  }
}

/** Where the render goes when --out is not given: next to the source. */
export function defaultOutput(file: string): string {
  return join(dirname(file), `${basename(file, extname(file))}.calmframe.mp4`)
}

/** The report, in plain words: printed, and saved next to the video. */
export function reportText(
  args: RenderArgs,
  out: string,
  fps: number,
  summary: RenderSummary
): string {
  const lower = (lines: string[]): string => lines.join(', ').toLowerCase()
  const s = summary
  const lines = [
    `CalmFrame offline render of ${basename(args.file)}`,
    `Wrote ${out}`,
    `${s.frames} frames at ${fps} fps, ${s.durationS.toFixed(1)} s, layout ${args.layout}${args.seenLine ? ", graph with the calmed picture's line" : ''}`,
    `Settings: ${lower(describeSettings(args.settings, args.delayFrames, args.gameMode))}, ${describeLimit(args.settings.flashLimit).toLowerCase()}`,
    '',
    `The overlay was on for ${s.overlayS.toFixed(1)} s of ${s.durationS.toFixed(1)} s, in ${s.episodes} ${s.episodes === 1 ? 'stretch' : 'stretches'}.`,
    '',
    'Seconds flagged, out of ' + Math.ceil(s.durationS) + ':',
    `  at the WCAG limit (strict trigger, limit ${DEFAULT_FLASH_LIMIT}):  original ${s.standard.original}, protected picture ${s.standard.protectedPane}`,
    `  with these settings:                         original ${s.withSettings.original}, protected picture ${s.withSettings.protectedPane}`,
    `  the finished video as a whole, at the WCAG limit: ${s.standard.wholeVideo}`,
    '',
    'The protected picture still shows the first flash or two of each burst, as the live app',
    'does, so "with these settings" is rarely 0 for it. This is a simulation made with the',
    "app's own detection and filter code, not a recording of the live overlay.",
    'Before publishing, run the finished video through IRIS and add a flashing-content warning.'
  ]
  if (args.settings.flashLimit !== DEFAULT_FLASH_LIMIT) {
    lines.push(
      `Note: the flash limit was raised to ${args.settings.flashLimit}. That is not the WCAG limit; say so wherever this footage is shown.`
    )
  }
  return `${lines.join('\n')}\n`
}

async function main(argv: string[]): Promise<void> {
  const args = parseRenderArgs(argv)
  const file = resolve(args.file)
  const out = resolve(args.out ?? defaultOutput(file))
  if (out === file) throw new Error('the output would overwrite the source: choose another --out')
  const ffmpeg = findFfmpeg()
  const sourceFps = probeFps(ffmpeg, file)
  const fps = args.fps ?? Math.min(RENDER_MAX_FPS, Math.round(sourceFps ?? RENDER_FALLBACK_FPS))
  if (args.fps === null && sourceFps === null) {
    console.warn(`[render] could not read the frame rate; using ${fps} fps (set --fps to choose)`)
  }

  const layout = layoutFor(args.layout, args.info)
  const renderer = new ClipRenderer(
    layout,
    args.settings,
    fps,
    args.delayFrames,
    args.gameMode,
    args.seenLine
  )
  const writer = new FrameWriter(ffmpeg, out, layout.width, layout.height, fps, RENDER_CRF)
  const frames = readFrames(ffmpeg, file, {
    width: layout.protectedPane.w,
    height: layout.protectedPane.h,
    fps,
    startS: args.startS ?? undefined,
    durationS: args.durationS ?? undefined
  })
  console.log(`[render] ${basename(file)} at ${fps} fps -> ${out}`)
  const t0 = Date.now()
  let count = 0
  let lastLog = t0
  try {
    for await (const frame of frames) {
      await writer.write(renderer.frame(frame))
      count++
      if (Date.now() - lastLog >= 5000) {
        lastLog = Date.now()
        const rate = count / ((lastLog - t0) / 1000)
        console.log(
          `[render] ${(count / fps).toFixed(1)} s of video done (${rate.toFixed(1)} frames a second)`
        )
      }
    }
  } finally {
    await writer.close()
  }
  if (count === 0) throw new Error(`no frames were read from ${file}`)
  const report = reportText(args, out, fps, renderer.summary())
  const reportFile = `${out.slice(0, -extname(out).length)}.txt`
  writeFileSync(reportFile, report, 'utf8')
  console.log(
    `\n${report}\n[render] done in ${((Date.now() - t0) / 1000).toFixed(0)} s. Report saved as ${reportFile}`
  )
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  })
}
