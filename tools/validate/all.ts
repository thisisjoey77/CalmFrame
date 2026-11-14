/**
 * The whole comparison in one command (`npm run validate:all`): make the clips if they are
 * missing, run IRIS on each, run CalmFrame's validator on each, then write
 * measurements/iris-comparison.md and .csv.
 *
 * IRIS comes from the virtualenv the README sets up (~/.calmframe/iris-venv, or the `iris`
 * command in $CALMFRAME_IRIS). Its results are cached next to the clips; pass --fresh to
 * rebuild the clips and run everything again.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { compareAll } from './compare-iris'
import { DEFAULT_VENV, findFfmpeg, venvExecutable } from './ffmpeg'
import { makeClips, type Manifest } from './make-clips'
import { validateFile, writeResults } from './validate'

const ROOT = process.cwd()
const CLIP_DIR = resolve(ROOT, 'tools/validate/clips')
const IRIS_DIR = resolve(CLIP_DIR, 'iris')
const OUR_DIR = resolve(ROOT, 'measurements/validate')
const REPORT = resolve(ROOT, 'measurements/iris-comparison')

function irisCommand(): string {
  const fromEnv = process.env['CALMFRAME_IRIS']
  if (fromEnv) return fromEnv
  const inVenv = venvExecutable(DEFAULT_VENV, 'iris')
  if (existsSync(inVenv)) return inVenv
  return 'iris'
}

function irisVersion(): string {
  const python = process.env['CALMFRAME_PYTHON'] ?? venvExecutable(DEFAULT_VENV, 'python')
  const r = spawnSync(
    python,
    ['-c', "import importlib.metadata as m; print(m.version('iris-pse-detection'))"],
    { encoding: 'utf8' }
  )
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

async function main(): Promise<void> {
  const fresh = process.argv.includes('--fresh')
  const ffmpeg = findFfmpeg()
  if (fresh) rmSync(CLIP_DIR, { recursive: true, force: true })
  let manifest: Manifest
  if (existsSync(join(CLIP_DIR, 'manifest.json'))) {
    manifest = JSON.parse(readFileSync(join(CLIP_DIR, 'manifest.json'), 'utf8')) as Manifest
    console.log(`[all] using the ${manifest.clips.length} clips in ${CLIP_DIR}`)
  } else {
    manifest = await makeClips(CLIP_DIR, ffmpeg)
  }

  const iris = irisCommand()
  mkdirSync(IRIS_DIR, { recursive: true })
  for (const clip of manifest.clips) {
    const out = join(IRIS_DIR, clip.file, 'framedata.csv')
    if (existsSync(out)) continue
    const t0 = Date.now()
    // -c points at a folder with no appsettings.json, so IRIS runs with its defaults.
    const r = spawnSync(iris, [join(CLIP_DIR, clip.file), '-o', IRIS_DIR, '-c', IRIS_DIR], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    if (r.status !== 0 || !existsSync(out)) {
      throw new Error(
        `IRIS failed on ${clip.file}: ${(r.stderr || r.stdout || String(r.error)).slice(-800)}`
      )
    }
    console.log(`[all] IRIS ${clip.file} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }

  for (const clip of manifest.clips) {
    const file = join(CLIP_DIR, clip.file)
    const result = await validateFile(file, undefined, ffmpeg)
    writeResults(OUR_DIR, file, result.rows)
    console.log(
      `[all] CalmFrame ${basename(file)}: ${result.frames} frames in ${(result.ms / 1000).toFixed(1)} s`
    )
  }

  compareAll(CLIP_DIR, OUR_DIR, IRIS_DIR, REPORT, {
    irisVersion: irisVersion(),
    generatedAt: new Date().toISOString()
  })
  console.log(`[all] wrote ${REPORT}.md and ${REPORT}.csv`)
}

main().catch((error) => {
  console.error(String(error))
  process.exit(1)
})
