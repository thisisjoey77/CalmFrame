// Speed test for the native capture module, in plain Node (no Electron).
//
//   npm run native:build
//   node native/capture/speedtest.mjs [seconds] [repeatMs]
//
// Desktop Duplication only delivers a frame when the screen changed, so run it while
// something on screen moves every display frame (a moving bar, a video). Each received
// slot is released at once, so this measures the capture and the hand-over to JavaScript,
// not Electron's import.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const capture = require('./build/Release/calmframe_capture.node')

const seconds = Number(process.argv[2] ?? 10)
const repeatMs = Number(process.argv[3] ?? 0)
let repeats = 0
let frames = 0
const perSecond = []
const readyToJs = []
const presentToReady = []

const info = capture.start(
  (frame) => {
    frames++
    if (frame.repeat) repeats++
    presentToReady.push(frame.readyMs - frame.presentMs)
    readyToJs.push(capture.now() - frame.readyMs)
    capture.release(frame.slot)
  },
  (message) => console.error(`[capture error] ${message}`),
  { repeatMs }
)
console.log('started', info)

const percentile = (values, p) => {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

const tick = setInterval(() => {
  perSecond.push(frames)
  console.log(`${frames} fps (${repeats} repeats)`, JSON.stringify(capture.stats()))
  frames = 0
  repeats = 0
}, 1000)

setTimeout(() => {
  clearInterval(tick)
  const stats = capture.stats()
  capture.stop()
  const fps = perSecond.slice(1) // the first second includes start-up
  console.log('\nsummary')
  console.log(
    `  frames per second: median ${percentile(fps, 0.5)}, min ${Math.min(...fps)}, max ${Math.max(...fps)}`
  )
  console.log(
    `  present -> copy done: median ${percentile(presentToReady, 0.5).toFixed(2)} ms, p95 ${percentile(presentToReady, 0.95).toFixed(2)} ms`
  )
  console.log(
    `  copy done -> JavaScript: median ${percentile(readyToJs, 0.5).toFixed(2)} ms, p95 ${percentile(readyToJs, 0.95).toFixed(2)} ms`
  )
  console.log('  counters', JSON.stringify(stats))
}, seconds * 1000)
