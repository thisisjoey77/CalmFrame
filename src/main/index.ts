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
  DEBUG_FREEZE_ACCELERATOR,
  DEBUG_FREEZE_MS,
  DEBUG_LOG_INTERVAL_MS,
  FPS_SWEEP_LEAD_MS,
  FPS_SWEEP_MEASURE_MS,
  FPS_SWEEP_WARMUP_MS,
  KILL_SWITCH_ACCELERATOR,
  OVERLAY_BOTTOM_INSET,
  WATCHDOG_MS
} from '../shared/config'
import {
  IPC,
  type CaptureSize,
  type CaptureStats,
  type DetectionStats,
  type GridSelfTestResult,
  type HazardEvent,
  type OverlayState,
  type SelfCheckResult,
  type SmoothSelfTestResult,
  type StateChange
} from '../shared/messages'

type Page = 'dashboard' | 'overlay'

let overlayWin: BrowserWindow | null = null
let debugWin: BrowserWindow | null = null

/** Debug-only: cycle through DEBUG_CAPTURE_SIZES and log the frame rate of each. */
const fpsSweep = process.env['CALMFRAME_FPS_SWEEP'] === '1'
/** Debug-only: show the Phase 0 red tint on the overlay, and run the capture-leak check. */
const debugTint = process.env['CALMFRAME_DEBUG_TINT'] === '1'

/** The overlay sends its self-tests once at startup, possibly before the debug window has
 *  loaded, so main keeps them and replays them. */
let gridSelfTest: GridSelfTestResult | null = null
let smoothSelfTest: SmoothSelfTestResult | null = null

/** Protection on: the overlay is shown and may smooth. Off is the Disabled state ("On fast,
 *  off slow"): hidden until the user re-enables it with the kill switch. */
let protectionOn = true
/** When the latest heartbeat arrived (Date.now()), or null before the first. */
let lastHeartbeatAt: number | null = null
/** Fires WATCHDOG_MS after the latest heartbeat. Armed by the first heartbeat, so a slow
 *  startup (page load, self-tests) can't trip it; the overlay draws nothing before then. */
let watchdogTimer: ReturnType<typeof setTimeout> | null = null

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
    disableProtection(`overlay renderer gone (${details.reason})`)
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
    if (smoothSelfTest) win.webContents.send(IPC.smoothSelfTest, smoothSelfTest)
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

/**
 * Fail open, or the user's off switch: hide the overlay at once, then tell the renderer to
 * go to Disabled. A frozen renderer gets the message when it recovers, and stays hidden
 * until the user re-enables protection.
 */
function disableProtection(reason: string): void {
  protectionOn = false
  hideOverlay(`Protection off: ${reason}`)
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(IPC.protection, false, reason)
  }
}

/** The user's on switch. Refused while the renderer is not sending heartbeats, since a
 *  frozen overlay must not be shown again. */
function enableProtection(reason: string): void {
  if (lastHeartbeatAt === null || Date.now() - lastHeartbeatAt > WATCHDOG_MS) {
    console.log('[protection] not switched back on: the overlay renderer is not responding')
    sendOverlayState({ visible: false, reason: 'Protection off: overlay not responding' })
    return
  }
  protectionOn = true
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(IPC.protection, true, reason)
  }
  showOverlay(reason)
}

/** Watchdog ("Safety mechanisms"): no heartbeat for WATCHDOG_MS hides the overlay and sets
 *  Disabled, because a frozen opaque overlay would block the whole screen. */
function onHeartbeat(): void {
  lastHeartbeatAt = Date.now()
  if (watchdogTimer !== null) clearTimeout(watchdogTimer)
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null
    const silent = lastHeartbeatAt === null ? 'unknown' : String(Date.now() - lastHeartbeatAt)
    if (protectionOn) disableProtection(`watchdog, no heartbeat for ${silent} ms`)
    else console.log(`[watchdog] no heartbeat for ${silent} ms (protection already off)`)
  }, WATCHDOG_MS)
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
    disableProtection(`capture error: ${message}`)
  })

  ipcMain.on(IPC.pipelineError, (_event, message: string) => {
    console.error(`[pipeline] error: ${message}`)
    disableProtection(`pipeline error: ${message}`)
  })

  ipcMain.on(IPC.heartbeat, () => onHeartbeat())

  ipcMain.on(IPC.smoothSelfTest, (_event, result: SmoothSelfTestResult) => {
    smoothSelfTest = result
    debugWin?.webContents.send(IPC.smoothSelfTest, result)
    logSafely(
      'smooth self-test',
      () => `[smooth self-test] ${result.pass ? 'PASS' : 'FAIL'}: ${result.detail}`
    )
  })

  ipcMain.on(IPC.stateChange, (_event, change: StateChange) => {
    debugWin?.webContents.send(IPC.stateChange, change)
    logSafely('state', () => {
      const when = new Date(change.wallMs).toISOString().slice(11, 23)
      const why =
        change.frequencyHz > 0
          ? `${change.reason}; f ${fmt(change.frequencyHz, 1)} Hz, dL ${fmt(change.flashSize, 2)}`
          : change.reason
      const red = change.red ? ', red desaturation' : ''
      return `[state] ${when} UTC (t ${fmt(change.tMs, 1)} ms) ${change.from} -> ${change.to} (${why}): alpha ${fmt(change.alpha, 3)}, d ${fmt(change.dim, 2)}, opacity ${fmt(change.opacity, 2)}${red}`
    })
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
    const w = stats.whileDrawn
    const sm = stats.smoothing
    const v = stats.viewer
    const pair = (t: { median: number | null; p95: number | null }): string =>
      `${fmt(t.median, 1)}/${fmt(t.p95, 1)}`
    logSafely(
      'detect',
      () =>
        `[detect] graph ${fmt(stats.graphValue, 1)} | ${stats.hazard ? `HAZARD ${stats.type}` : 'safe'} | ` +
        `f ${fmt(stats.frequencyHz, 1)} Hz, dL ${fmt(stats.flashSize, 2)}, area ${fmt(stats.areaFraction, 2)}, ` +
        `hot ${stats.hotCells} | state ${stats.state}, alpha ${fmt(sm.alpha, 3)}, d ${fmt(sm.dim, 2)}, ` +
        `opacity ${fmt(sm.opacity, 2)}${sm.drawn ? ' (drawn)' : ''} | ` +
        `seen: ${v.checking ? `graph ${fmt(v.graphValue, 1)}, residual ${fmt(v.residual, 3)}` : 'overlay not drawn'} | ` +
        `cost median ${fmt(stats.cost.median, 2)} ms, p95 ${fmt(stats.cost.p95, 2)} ms ` +
        `(issue ${fmt(stats.issueMedianMs, 2)}, copy ${fmt(stats.copyMedianMs, 2)}, detector ${fmt(stats.detectorMedianMs, 2)}; ` +
        `pass B ${fmt(stats.smoothMedianMs, 2)}, pass C ${fmt(stats.drawMedianMs, 2)}, viewer ${fmt(stats.viewerMedianMs, 2)}) | ` +
        `latency median/p95 ms: capture>callback ${pair(l.captureToCallback)}, ` +
        `callback>grid ${pair(l.callbackToGrid)} (drawn ${pair(w.callbackToGrid)}), ` +
        `grid>decision ${pair(l.gridToDecision)}, ` +
        `total ${pair(l.captureToDecision)} (drawn ${pair(w.captureToDecision)}), ` +
        `decision>drawn ${pair(l.decisionToDrawn)}, capture>drawn ${pair(l.captureToDrawn)} | ` +
        `busy skips ${stats.busySkips} (drawn ${w.busySkips} of ${w.frames})`
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

  // Kill switch ("Safety mechanisms"): to Disabled and hidden at once, and back on.
  const registered = globalShortcut.register(KILL_SWITCH_ACCELERATOR, () => {
    if (protectionOn) disableProtection('kill switch')
    else enableProtection('kill switch')
  })
  console.log(`[kill switch] ${KILL_SWITCH_ACCELERATOR} registered: ${registered}`)

  // Hidden debug command, dev builds only: freeze the overlay renderer to test the watchdog.
  if (is.dev) {
    const freezeRegistered = globalShortcut.register(DEBUG_FREEZE_ACCELERATOR, () => {
      console.log(`[debug] freezing the overlay renderer for ${DEBUG_FREEZE_MS} ms`)
      overlayWin?.webContents.send(IPC.debugFreeze, DEBUG_FREEZE_MS)
    })
    console.log(`[debug] freeze ${DEBUG_FREEZE_ACCELERATOR} registered: ${freezeRegistered}`)
  }

  if (fpsSweep) void runFpsSweep()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// Windows is the only target, so quit when the last window closes.
app.on('window-all-closed', () => {
  app.quit()
})
