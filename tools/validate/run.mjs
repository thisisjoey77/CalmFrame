// Build the validator tools, then run one of them with the arguments given:
//   node tools/validate/run.mjs <tool> [arguments]
//
// The npm scripts go through this instead of `npm run validate:build && node ...`. On
// Windows, npm escapes the extra arguments for whatever the script's first command is. When
// that is another npm command (a .cmd file), they are escaped twice, and a file path with a
// space in it reaches the tool as `My^ clip.mp4`. Starting the script with node avoids it.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const [tool, ...args] = process.argv.slice(2)
if (!tool || !/^[a-z-]+$/.test(tool)) {
  console.error('usage: node tools/validate/run.mjs <tool> [arguments]')
  process.exit(1)
}

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const build = spawnSync(process.execPath, [tsc, '-p', join(here, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit'
})
if (build.status !== 0) process.exit(build.status ?? 1)

const run = spawnSync(
  process.execPath,
  [join(here, 'dist/tools/validate', `${tool}.js`), ...args],
  { stdio: 'inherit' }
)
process.exit(run.status ?? 1)
