import {
  app,
  shell,
  screen,
  session,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  BrowserWindow
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
  DEBUG_CAPTURE_SIZES,
  DEBUG_LOG_INTERVAL_MS,
  FPS_SWEEP_LEAD_MS,
  FPS_SWEEP_MEASURE_MS,
  FPS_SWEEP_WARMUP_MS,
  KILL_SWITCH_ACCELERATOR,
  OVERLAY_BOTTOM_INSET
} from '../shared/config'
import {
  IPC,
  type CaptureSize,
  type CaptureStats,
  type DetectionStats,
  type GridSelfTestResult,
  type HazardEvent,
  type OverlayState,
  type SelfCheckResult
} from '../shared/messages'

type Page = 'dashboard' | 'overlay'

let overlayWin: BrowserWindow | null = null
let debugWin: BrowserWindow | null = null

/** Debug-only: cycle through DEBUG_CAPTURE_SIZES and log the frame rate of each. */
const fpsSweep = process.env['CALMFRAME_FPS_SWEEP'] === '1'
/** Debug-only: show the Phase 0 red tint on the overlay, and run the capture-leak check. */
const debugTint = process.env['CALMFRAME_DEBUG_TINT'] === '1'

/** The overlay sends its Pass A self-test once at startup, possibly before the debug
 *  window has loaded, so main keeps it and replays it. */
let gridSelfTest: GridSelfTestResult | null = null

/** Load one of the renderer pages: the Vite dev server in dev, the built file otherwise. */
function loadPage(win: BrowserWindow, page: Page, hash = ''): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devUrl) {
    win.loadURL(`${devUrl}/${page}/index.html${hash ? `#${hash}` : ''}`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page}/index.html`), { hash })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Log a line built from a renderer message without ever throwing. An exception in an IPC
 * handler shows a modal error dialog in the main process, and a renderer that is reloaded
 * with newer code can send fields this build doesn't know. A log line is not worth that.
 */
function logSafely(tag: string, build: () => string): void {
  try {
    console.log(build())
  } catch (error) {
    console.warn(`[${tag}] could not format a message: ${String(error)}`)
  }
}

/** A number for a log line; '?' when it is missing. */
function fmt(v: number | null | undefined, digits: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '?'
}
let sweepSamples: number[] | null = null

async function runFpsSweep(): Promise<void> {
  console.log(
    `[sweep] starting in ${FPS_SWEEP_LEAD_MS / 1000} s, debug preview off, motion test on`
  )
  await sleep(FPS_SWEEP_LEAD_MS)
  const results: string[] = []
  for (const size of DEBUG_CAPTURE_SIZES) {
    overlayWin?.webContents.send(IPC.captureRestart, size)
    await sleep(FPS_SWEEP_WARMUP_MS)
    sweepSamples = []
    await sleep(FPS_SWEEP_MEASURE_MS)
    const s = sweepSamples
    sweepSamples = null
    const mean = s.length ? s.reduce((a, v) => a + v, 0) / s.length : 0
    const line = `${size.maxWidth}x${size.maxHeight}: mean ${mean.toFixed(1)} fps, min ${Math.min(...s)}, max ${Math.max(...s)} (${s.length} samples)`
    console.log(`[sweep] ${line}`)
    results.push(line)
  }
  overlayWin?.webContents.send(IPC.captureRestart, {
    maxWidth: CAPTURE_MAX_WIDTH,
    maxHeight: CAPTURE_MAX_HEIGHT
  })
  console.log(`[sweep] done:\n  ${results.join('\n  ')}`)
}

const preloadPath = join(__dirname, '../preload/index.js')

/**
 * The overlay: transparent, frameless, click-through, always on top, sized to the
 * primary display and excluded from capture (spec: "Overlay window requirements").
 */
function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay().bounds
  // Full display minus a 1-DIP bottom inset, so Windows doesn't treat the overlay as a
  // fullscreen app and hide the taskbar (see OVERLAY_BOTTOM_INSET).
  const bounds = { ...display, height: display.height - OVERLAY_BOTTOM_INSET }
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)

  win.once('ready-to-show', () => {
    win.showInactive()
    // Windows clamps a new window to the work area (screen minus taskbar), which left
    // the taskbar strip uncovered over fullscreen apps. Re-apply the intended bounds.
    win.setBounds(bounds)
    // Applied again once shown, in case the first call raced window creation.
    win.setContentProtection(true)
    const b = win.getBounds()
    console.log(
      `[overlay] shown at ${b.width}x${b.height}+${b.x}+${b.y} (DIP; display ${display.width}x${display.height}), scale ${screen.getPrimaryDisplay().scaleFactor}, content protected: ${win.isContentProtected()}`
    )
    sendOverlayState({ visible: true, reason: 'started' })
  })

  // Fail open: if the overlay renderer dies, hide the overlay.
  win.webContents.on('render-process-gone', (_event, details) => {
    hideOverlay(`overlay renderer gone (${details.reason})`)
  })

  loadPage(win, 'overlay', debugTint ? 'tint' : '')
  return win
}

/** Ordinary debug window (becomes the dashboard in Phase 5). */
function createDebugWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 600,
    height: 980,
    show: false,
    title: 'CalmFrame debug',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.on('did-finish-load', () => {
    if (gridSelfTest) win.webContents.send(IPC.gridSelfTest, gridSelfTest)
  })
  win.on('closed', () => {
    debugWin = null
    app.quit()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadPage(win, 'dashboard', fpsSweep ? 'sweep' : '')
  return win
}

function sendOverlayState(state: OverlayState): void {
  debugWin?.webContents.send(IPC.overlayState, state)
}

function hideOverlay(reason: string): void {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.hide()
  console.log(`[overlay] hidden: ${reason}`)
  sendOverlayState({ visible: false, reason })
}

function showOverlay(reason: string): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.showInactive()
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  console.log(`[overlay] shown: ${reason}`)
  sendOverlayState({ visible: true, reason })
}

/** Grant the primary screen to getDisplayMedia (spec: "Capture requirements"). */
function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const primaryId = String(screen.getPrimaryDisplay().id)
        const source = sources.find((s) => s.display_id === primaryId) ?? sources[0]
        if (!source) {
          console.error('[capture] no screen sources found')
          callback(null)
          return
        }
        callback({ video: source })
      })
      .catch((error) => {
        console.error('[capture] getSources failed', error)
        callback(null)
      })
  })
}

function installIpc(): void {
  let lastLog = 0
  let lastSettings = ''
  ipcMain.on(IPC.captureStats, (_event, stats: CaptureStats) => {
    debugWin?.webContents.send(IPC.captureStats, stats)
    sweepSamples?.push(stats.fps)
    const settings = JSON.stringify(stats.settings)
    if (settings !== lastSettings) {
      lastSettings = settings
      console.log(`[capture] applied settings ${settings}`)
    }
    const now = Date.now()
    if (now - lastLog >= DEBUG_LOG_INTERVAL_MS) {
      lastLog = now
      logSafely('capture', () => {
        const delay =
          stats.delayMedianMs === null
            ? 'delay n/a (no captureTime)'
            : `delay median ${fmt(stats.delayMedianMs, 1)} ms, p95 ${fmt(stats.delayP95Ms, 1)} ms`
        return `[capture] ${stats.fps} fps | ${delay} | ${stats.width}x${stats.height} | skipped ${stats.skippedFrames}/${stats.framesTotal}`
      })
    }
  })

  ipcMain.on(IPC.captureError, (_event, message: string) => {
    console.error(`[capture] error: ${message}`)
    hideOverlay(`capture error: ${message}`)
  })

  ipcMain.on(IPC.pipelineError, (_event, message: string) => {
    console.error(`[pipeline] error: ${message}`)
    hideOverlay(`detection off: ${message}`)
  })

  ipcMain.on(IPC.gridSelfTest, (_event, result: GridSelfTestResult) => {
    gridSelfTest = result
    debugWin?.webContents.send(IPC.gridSelfTest, result)
    logSafely(
      'grid self-test',
      () => `[grid self-test] ${result.pass ? 'PASS' : 'FAIL'}: ${result.detail}`
    )
  })

  let lastDetectLog = 0
  ipcMain.on(IPC.detectionStats, (_event, stats: DetectionStats) => {
    debugWin?.webContents.send(IPC.detectionStats, stats)
    const now = Date.now()
    if (now - lastDetectLog < DEBUG_LOG_INTERVAL_MS) return
    lastDetectLog = now
    const l = stats.latency
    logSafely(
      'detect',
      () =>
        `[detect] graph ${fmt(stats.graphValue, 1)} | ${stats.hazard ? `HAZARD ${stats.type}` : 'safe'} | ` +
        `f ${fmt(stats.frequencyHz, 1)} Hz, dL ${fmt(stats.flashSize, 2)}, area ${fmt(stats.areaFraction, 2)}, ` +
        `hot ${stats.hotCells} | state ${stats.state} | cost median ${fmt(stats.cost.median, 2)} ms, ` +
        `p95 ${fmt(stats.cost.p95, 2)} ms (issue ${fmt(stats.issueMedianMs, 2)}, copy ${fmt(stats.copyMedianMs, 2)}, detector ${fmt(stats.detectorMedianMs, 2)}) | ` +
        `latency median/p95 ms: capture>callback ${fmt(l.captureToCallback.median, 1)}/${fmt(l.captureToCallback.p95, 1)}, ` +
        `callback>grid ${fmt(l.callbackToGrid.median, 1)}/${fmt(l.callbackToGrid.p95, 1)}, ` +
        `grid>decision ${fmt(l.gridToDecision.median, 1)}/${fmt(l.gridToDecision.p95, 1)}, ` +
        `total ${fmt(l.captureToDecision.median, 1)}/${fmt(l.captureToDecision.p95, 1)} | busy skips ${stats.busySkips}`
    )
  })

  ipcMain.on(IPC.hazardEvent, (_event, event: HazardEvent) => {
    debugWin?.webContents.send(IPC.hazardEvent, event)
    logSafely('hazard', () => {
      const when = new Date(event.wallMs).toISOString().slice(11, 23)
      const values = `${event.type}, ${fmt(event.frequencyHz, 1)} Hz, dL ${fmt(event.flashSize, 2)}, area ${fmt(event.areaFraction, 2)}, graph ${fmt(event.graphValue, 1)}`
      return event.kind === 'start'
        ? `[hazard] START ${when} UTC (capture t ${fmt(event.tMs, 1)} ms): ${values}`
        : `[hazard] END   ${when} UTC (capture t ${fmt(event.tMs, 1)} ms) after ${fmt((event.durationMs ?? 0) / 1000, 2)} s, peaks: ${values}`
    })
  })

  ipcMain.on(IPC.selfCheckRun, () => {
    overlayWin?.webContents.send(IPC.selfCheckRun)
  })

  ipcMain.on(IPC.captureRestart, (_event, size: CaptureSize) => {
    console.log(`[capture] restarting with max ${size.maxWidth}x${size.maxHeight}`)
    overlayWin?.webContents.send(IPC.captureRestart, size)
  })

  ipcMain.on(IPC.selfCheckResult, (_event, result: SelfCheckResult) => {
    debugWin?.webContents.send(IPC.selfCheckResult, result)
    logSafely('self-check', () => `[self-check] ${result.verdict.toUpperCase()}: ${result.detail}`)
    result.cycles.forEach((c, i) => {
      logSafely(
        'self-check',
        () =>
          `[self-check]   cycle ${i + 1}: red ratio off ${fmt(c.hidden.redRatio, 3)} -> on ${fmt(c.shown.redRatio, 3)}, black share on ${fmt(c.shown.blackFraction, 2)}`
      )
    })
  })

  // Stacking test for the open question in CLAUDE.md: debug window above the overlay,
  // and excluded from capture so it doesn't appear in its own preview.
  ipcMain.on(IPC.debugSetOnTop, (_event, onTop: boolean) => {
    if (!debugWin) return
    debugWin.setContentProtection(onTop)
    debugWin.setAlwaysOnTop(onTop, 'screen-saver')
    if (onTop) debugWin.moveTop()
    console.log(`[debug] above overlay + content protected: ${onTop}`)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.calmframe.app')

  // F12 opens DevTools in dev; Ctrl+R reload is disabled in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  installDisplayMediaHandler()
  installIpc()

  debugWin = createDebugWindow()
  overlayWin = createOverlayWindow()

  const registered = globalShortcut.register(KILL_SWITCH_ACCELERATOR, () => {
    if (overlayWin?.isVisible()) hideOverlay('kill switch')
    else showOverlay('kill switch')
  })
  console.log(`[kill switch] ${KILL_SWITCH_ACCELERATOR} registered: ${registered}`)

  if (fpsSweep) void runFpsSweep()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// Windows is the only target, so quit when the last window closes.
app.on('window-all-closed', () => {
  app.quit()
})
