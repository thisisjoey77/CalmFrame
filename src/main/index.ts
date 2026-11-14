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
  type OverlayState,
  type SelfCheckResult
} from '../shared/messages'

type Page = 'dashboard' | 'overlay'

let overlayWin: BrowserWindow | null = null
let debugWin: BrowserWindow | null = null

/** Debug-only: cycle through DEBUG_CAPTURE_SIZES and log the frame rate of each. */
const fpsSweep = process.env['CALMFRAME_FPS_SWEEP'] === '1'

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

  loadPage(win, 'overlay')
  return win
}

/** Ordinary debug window (becomes the dashboard in Phase 5). */
function createDebugWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 760,
    show: false,
    title: 'CalmFrame debug',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
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
      const delay =
        stats.delayMedianMs === null
          ? 'delay n/a (no captureTime)'
          : `delay median ${stats.delayMedianMs.toFixed(1)} ms, p95 ${stats.delayP95Ms?.toFixed(1)} ms`
      console.log(
        `[capture] ${stats.fps} fps | ${delay} | ${stats.width}x${stats.height} | skipped ${stats.skippedFrames}/${stats.framesTotal}`
      )
    }
  })

  ipcMain.on(IPC.captureError, (_event, message: string) => {
    console.error(`[capture] error: ${message}`)
    hideOverlay(`capture error: ${message}`)
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
    console.log(`[self-check] ${result.verdict.toUpperCase()}: ${result.detail}`)
    result.cycles.forEach((c, i) => {
      console.log(
        `[self-check]   cycle ${i + 1}: red ratio off ${c.hidden.redRatio.toFixed(3)} -> on ${c.shown.redRatio.toFixed(3)}, black share on ${c.shown.blackFraction.toFixed(2)}`
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
