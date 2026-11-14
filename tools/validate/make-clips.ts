/**
 * make-clips (docs/SPEC.md, Prompt 8, step 1): the synthetic clip set as 1080p60 MP4 files,
 * plus manifest.json with the expected result of each clip in each area mode.
 *
 *   node tools/validate/dist/tools/validate/make-clips.js [outDir]
 *
 * Default outDir: tools/validate/clips (git-ignored; the clips are rebuilt, not committed).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  VALIDATE_CLIP_CRF,
  VALIDATE_CLIP_FPS,
  VALIDATE_CLIP_LEAD_IN_MS,
  VALIDATE_CLIP_MS
} from '../../src/shared/config'
import {
  CLIPS,
  CLIP_FRAMES,
  CLIP_SIZE,
  LOW_GREY,
  SWING_005_HIGH,
  SWING_02_HIGH,
  greyLuminance,
  paintRgb24,
  type ClipSpec,
  type FrameImage
} from './clips'
import { encodeClip, findFfmpeg } from './ffmpeg'

/** Run from the repo root, as the npm scripts do. */
export const DEFAULT_CLIP_DIR = resolve(process.cwd(), 'tools', 'validate', 'clips')

export interface Manifest {
  generatedAt: string
  width: number
  height: number
  fps: number
  durationMs: number
  leadInMs: number
  levels: Record<string, { srgb: number; luminance: number }>
  clips: { id: string; title: string; file: string; expected: ClipSpec['expected'] }[]
}

/** Distinct images kept painted; strobes need two to four. A fade needs a new one each
 *  frame, so past this many, frames are painted fresh and not kept. */
const CACHE_LIMIT = 8

async function makeClip(ffmpeg: string, clip: ClipSpec, file: string): Promise<void> {
  const { width, height } = CLIP_SIZE
  const cache = new Map<string, Uint8Array>()
  const paint = (image: FrameImage): Uint8Array => {
    const key = JSON.stringify(image)
    const hit = cache.get(key)
    if (hit) return hit
    // A buffer handed to ffmpeg is never painted again, since the pipe may still hold it.
    const buf = new Uint8Array(width * height * 3)
    paintRgb24(image, width, height, buf)
    if (cache.size < CACHE_LIMIT) cache.set(key, buf)
    return buf
  }
  await encodeClip(
    ffmpeg,
    file,
    width,
    height,
    VALIDATE_CLIP_FPS,
    VALIDATE_CLIP_CRF,
    CLIP_FRAMES,
    (i) => paint(clip.frame(i))
  )
}

export async function makeClips(
  outDir = DEFAULT_CLIP_DIR,
  ffmpeg = findFfmpeg()
): Promise<Manifest> {
  mkdirSync(outDir, { recursive: true })
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    width: CLIP_SIZE.width,
    height: CLIP_SIZE.height,
    fps: VALIDATE_CLIP_FPS,
    durationMs: VALIDATE_CLIP_MS,
    leadInMs: VALIDATE_CLIP_LEAD_IN_MS,
    levels: Object.fromEntries(
      [
        ['lowGrey', LOW_GREY],
        ['swing0.05High', SWING_005_HIGH],
        ['swing0.2High', SWING_02_HIGH]
      ].map(([name, code]) => [
        name,
        { srgb: code as number, luminance: greyLuminance(code as number) }
      ])
    ),
    clips: []
  }
  for (const clip of CLIPS) {
    const file = `${clip.id}.mp4`
    const t0 = Date.now()
    await makeClip(ffmpeg, clip, join(outDir, file))
    console.log(`[make-clips] ${file} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    manifest.clips.push({ id: clip.id, title: clip.title, file, expected: clip.expected })
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (require.main === module) {
  makeClips(process.argv[2] ? resolve(process.argv[2]) : undefined).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
