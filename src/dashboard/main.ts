// Debug window for the Phase 0 spike. Phase 5 replaces it with the real dashboard.
import {
  CAPTURE_MAX_HEIGHT,
  DEBUG_PREVIEW_FPS,
  DEBUG_CAPTURE_SIZES,
  DEBUG_PREVIEW_MAX_WIDTH,
  PHASE0_MIN_FPS
} from '../shared/config'
import type { CaptureStats, SelfCheckResult } from '../shared/messages'
import { openScreenStream } from '../overlay/capture'

const api = window.api
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function setCell(id: string, text: string, cls?: 'ok' | 'bad' | 'warn'): void {
  const el = $(id)
  el.textContent = text
  el.className = cls ?? ''
}

// Preview: a separate, slow capture so the user can see what capture sees.
const preview = $<HTMLVideoElement>('preview')
let previewStream: MediaStream | null = null

async function startPreview(): Promise<void> {
  try {
    previewStream = await openScreenStream(
      DEBUG_PREVIEW_FPS,
      DEBUG_PREVIEW_MAX_WIDTH,
      CAPTURE_MAX_HEIGHT
    )
    preview.srcObject = previewStream
    await preview.play()
  } catch (error) {
    preview.replaceWith(Object.assign(document.createElement('p'), { textContent: String(error) }))
  }
}

function stopPreview(): void {
  previewStream?.getTracks().forEach((t) => t.stop())
  previewStream = null
  preview.srcObject = null
}

$<HTMLInputElement>('preview-on').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) void startPreview()
  else stopPreview()
})

api.onCaptureStats((s: CaptureStats) => {
  setCell(
    'fps',
    `${s.fps} fps (needs ≥ ${PHASE0_MIN_FPS} on moving content)`,
    s.fps >= PHASE0_MIN_FPS ? 'ok' : 'warn'
  )
  setCell(
    'delay',
    s.delayMedianMs === null
      ? 'n/a: frames carry no captureTime'
      : `median ${s.delayMedianMs.toFixed(1)} ms, p95 ${s.delayP95Ms?.toFixed(1)} ms`
  )
  setCell('size', `${s.width} × ${s.height}`)
  const st = s.settings
  setCell(
    'settings',
    `${st.width ?? '?'} × ${st.height ?? '?'} @ ${st.frameRate ?? '?'} fps, cursor: ${st.cursor ?? 'not reported'}`
  )
  setCell('skipped', `${s.skippedFrames} of ${s.framesTotal}`)
})

api.onOverlayState((o) => {
  setCell('overlay', `${o.visible ? 'shown' : 'hidden'} (${o.reason})`, o.visible ? 'ok' : 'warn')
})

const verdictText: Record<SelfCheckResult['verdict'], [string, 'ok' | 'bad' | 'warn']> = {
  pass: ['PASS: overlay is excluded from capture', 'ok'],
  'tint-leak': ['FAIL: the tint is in the capture', 'bad'],
  black: ['FAIL?: capture is black where the overlay sits', 'bad'],
  inconclusive: ['INCONCLUSIVE: pause video and rerun', 'warn'],
  error: ['ERROR', 'bad']
}

api.onSelfCheckResult((r) => {
  const [text, cls] = verdictText[r.verdict]
  setCell('selfcheck-verdict', text, cls)
  $('selfcheck-detail').textContent = r.detail
})

$('selfcheck-run').addEventListener('click', () => {
  setCell('selfcheck-verdict', 'running…')
  $('selfcheck-detail').textContent = ''
  api.runSelfCheck()
})

// Size-cap selector: reopens the overlay's capture with a different max size.
const sizes = $('sizes')
DEBUG_CAPTURE_SIZES.forEach((size, i) => {
  const label = document.createElement('label')
  label.style.display = 'inline-block'
  label.style.marginRight = '12px'
  const input = Object.assign(document.createElement('input'), {
    type: 'radio',
    name: 'capture-size',
    checked: i === 0
  })
  input.addEventListener('change', () => api.restartCapture(size))
  label.append(input, ` ${size.maxWidth} × ${size.maxHeight}`)
  sizes.append(label)
})

$<HTMLInputElement>('on-top').addEventListener('change', (e) => {
  api.setDebugOnTop((e.target as HTMLInputElement).checked)
})

// The FPS sweep loads this page with #nopreview so the preview capture doesn't skew it.
if (location.hash === '#nopreview') {
  $<HTMLInputElement>('preview-on').checked = false
} else {
  void startPreview()
}
