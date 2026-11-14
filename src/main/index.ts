import {
  app,
  shell,
  screen,
  session,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  BrowserWindow,
  type Rectangle
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
  DASHBOARD_HEIGHT,
  DASHBOARD_MARGIN,
  DASHBOARD_MIN_HEIGHT,
  DASHBOARD_MIN_WIDTH,
  DASHBOARD_WIDTH,
  DEBUG_CAPTURE_SIZES,
  DEBUG_FREEZE_ACCELERATOR,
  DEBUG_FREEZE_MS,
  DEBUG_LOG_INTERVAL_MS,
  FPS_SWEEP_LEAD_MS,
  FPS_SWEEP_MEASURE_MS,
  FPS_SWEEP_WARMUP_MS,
  KILL_SWITCH_ACCELERATOR,
  NATIVE_CAPTURE_ENV,
  OVERLAY_BOTTOM_INSET,
  SETTINGS_FILE_NAME,
  STATUS_REFRESH_MS,
  WATCHDOG_MS
} from '../shared/config'
import { flashEventText } from '../shared/eventText'
import {
  IPC,
  type CaptureSize,
  type CaptureStats,
  type DetectionStats,
  type FlashEventMessage,
  type GridSelfTestResult,
  type HazardEvent,
  type Heartbeat,
  type InitInfo,
  type NativeCaptureStart,
  type OverlayState,
  type SelfCheckResult,
  type SmoothSelfTestResult,
  type StateChange,
  type StatusBeat,
  type Thumbnails
} from '../shared/messages'
import type { Settings } from '../shared/settings'
import { KILL_SWITCH_LABEL, STATUS_LABEL, deriveStatus, type StatusView } from '../shared/status'
import { NativeCapture } from './nativeCapture'
import { SettingsStore } from './settingsStore'
import { CalmTray } from './tray'

type Page = 'dashboard' | 'overlay' | 'debug'

let overlayWin: BrowserWindow | null = null
let dashboardWin: BrowserWindow | null = null
let debugWin: BrowserWindow | null = null
let tray: CalmTray | null = null
let store: SettingsStore | null = null

/** When the app started. The dashboard's event log counts from here. */
const startedAtWallMs = Date.now()
/** Set when the app is really quitting, so closing the dashboard is no longer a hide. */
let quitting = false

/** Debug-only: cycle through DEBUG_CAPTURE_SIZES and log the frame rate of each. */
const fpsSweep = process.env['CALMFRAME_FPS_SWEEP'] === '1'
/** Capture with the native module (trail #9) unless CALMFRAME_NATIVE_CAPTURE=0. The FPS
 *  sweep measures Chromium's capture at each size cap, so it always uses Chromium's. */
const nativeCaptureRequested = process.env[NATIVE_CAPTURE_ENV] !== '0' && !fpsSweep
const nativeCapture = new NativeCapture()
/** Debug-only: show the Phase 0 red tint on the overlay, and run the capture-leak check. */
const debugTint = process.env['CALMFRAME_DEBUG_TINT'] === '1'
/** Debug-only: also open the Phase 0 to 4 debug window (capture tools, per-stage latency).
 *  The FPS sweep needs its moving bar, so the sweep opens it too. */
const debugWindowOn = process.env['CALMFRAME_DEBUG_WINDOW'] === '1' || fpsSweep

/** The overlay sends its self-tests once at startup, possibly before the debug window has
 *  loaded, so main keeps them and replays them. */
let gridSelfTest: GridSelfTestResult | null = null
let smoothSelfTest: SmoothSelfTestResult | null = null

/** Protection on: the overlay is shown and may smooth. Off is the Disabled state ("On fast,
 *  off slow"): hidden until the user switches it back on. This is the switch, not the
 *  status: the status is derived from heartbeats (src/shared/status.ts). Protection starts
 *  on at every launch. */
let protectionOn = true
/** Why protection was last switched off, in words for the status line. Null while on. */
let offReason: string | null = null
/** The latest heartbeat, and when it arrived (Date.now()), or null before the first. */
let lastHeartbeat: Heartbeat | null = null
let lastHeartbeatAt: number | null = null
/** Fires WATCHDOG_MS after the latest heartbeat. Armed by the first heartbeat, so a slow
 *  startup (page load, self-tests) can't trip it; the overlay draws nothing before then. */
let watchdogTimer: ReturnType<typeof setTimeout> | null = null
/** The status the tray shows, re-derived every STATUS_REFRESH_MS. */
let trayView: StatusView | null = null

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

const alive = (win: BrowserWindow | null): win is BrowserWindow =>
  win !== null && !win.isDestroyed()

/** Send to the windows that show what the overlay is doing: the dashboard and, when it is
 *  open, the debug window. */
function sendToUi(channel: string, ...args: unknown[]): void {
  for (const win of [dashboardWin, debugWin]) {
    if (alive(win)) win.webContents.send(channel, ...args)
  }
}

function sendToDebug(channel: string, ...args: unknown[]): void {
  if (alive(debugWin)) debugWin.webContents.send(channel, ...args)
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
    // The dashboard sits above the overlay (Phase 5), whichever window was ready first.
    raiseDashboard()
  })

  // Fail open: if the overlay renderer dies, hide the overlay.
  win.webContents.on('render-process-gone', (_event, details) => {
    nativeCapture.stop()
    disableProtection(`The overlay stopped (${details.reason})`)
  })
  // A reload or a closed window must not leave the native module sending to nobody.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) nativeCapture.stop()
  })
  win.webContents.on('destroyed', () => nativeCapture.stop())

  loadPage(win, 'overlay', debugTint ? 'tint' : '')
  return win
}

/** Where the dashboard goes: where it was left, if that is still on a screen, else the top
 *  right of the primary display's work area. */
function dashboardBounds(): Rectangle {
  const saved = store?.settings.dashboardBounds ?? null
  if (saved && titleBarOnScreen(saved)) return saved
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(DASHBOARD_WIDTH, area.width - 2 * DASHBOARD_MARGIN)
  const height = Math.min(DASHBOARD_HEIGHT, area.height - 2 * DASHBOARD_MARGIN)
  return {
    x: area.x + area.width - width - DASHBOARD_MARGIN,
    y: area.y + DASHBOARD_MARGIN,
    width,
    height
  }
}

/** Enough of the window's top edge is inside some display's work area to grab it. */
function titleBarOnScreen(b: Rectangle): boolean {
  const grab = { width: 100, height: 24 }
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
    const h = Math.min(b.y + grab.height, a.y + a.height) - Math.max(b.y, a.y)
    return w >= grab.width && h >= grab.height
  })
}

/**
 * The dashboard (Phase 5). Above the overlay and excluded from capture, so it stays sharp
 * and live while the rest of the screen is smoothed, and neither the detector nor its own
 * protected preview sees it. Closing it hides it to the tray; Quit is in the tray menu.
 */
function createDashboardWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...dashboardBounds(),
    minWidth: DASHBOARD_MIN_WIDTH,
    minHeight: DASHBOARD_MIN_HEIGHT,
    show: false,
    title: 'CalmFrame',
    autoHideMenuBar: true,
    backgroundColor: '#14181d',
    alwaysOnTop: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })
  win.setContentProtection(true)

  win.once('ready-to-show', () => {
    win.show()
    raiseDashboard()
    const b = win.getBounds()
    console.log(
      `[dashboard] shown at ${b.width}x${b.height}+${b.x}+${b.y} (DIP), above the overlay: ${win.isAlwaysOnTop()}, content protected: ${win.isContentProtected()}`
    )
  })
  // Applied again whenever it is shown, as for the overlay.
  win.on('show', () => win.setContentProtection(true))
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
    console.log('[dashboard] hidden to the tray')
  })
  win.on('closed', () => {
    dashboardWin = null
  })
  // 'move' and 'resize' rather than 'moved' and 'resized', which Windows only sends at the
  // end of a drag with the mouse, not for snapping with Win+arrow keys. The store writes
  // the file once, a moment after the last change.
  const saveBounds = (): void => {
    if (!win.isMinimized()) store?.update({ dashboardBounds: win.getBounds() })
  }
  win.on('move', saveBounds)
  win.on('resize', saveBounds)
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[dashboard] renderer gone (${details.reason}), reloading`)
    if (!win.isDestroyed()) loadPage(win, 'dashboard')
  })
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadPage(win, 'dashboard')
  return win
}

/** Put the dashboard above the overlay: always on top at the overlay's level, set after
 *  the overlay's, which puts it higher in that band. */
function raiseDashboard(): void {
  if (!alive(dashboardWin) || !dashboardWin.isVisible()) return
  dashboardWin.setAlwaysOnTop(true, 'screen-saver')
  dashboardWin.moveTop()
}

function showDashboard(): void {
  if (!alive(dashboardWin)) {
    dashboardWin = createDashboardWindow()
    return
  }
  if (dashboardWin.isMinimized()) dashboardWin.restore()
  dashboardWin.show()
  dashboardWin.focus()
  raiseDashboard()
}

/** The Phase 0 to 4 debug window, only with CALMFRAME_DEBUG_WINDOW=1 or the FPS sweep. */
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
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadPage(win, 'debug', fpsSweep ? 'sweep' : '')
  return win
}

function sendOverlayState(state: OverlayState): void {
  sendToDebug(IPC.overlayState, state)
}

// ---------------------------------------------------------------------------
// Status: derived from the heartbeat (src/shared/status.ts)
// ---------------------------------------------------------------------------

/** The latest heartbeat with main's own view of the overlay, or null before the first. */
function currentBeat(): StatusBeat | null {
  if (lastHeartbeat === null || lastHeartbeatAt === null) return null
  return {
    ...lastHeartbeat,
    overlayVisible: alive(overlayWin) && overlayWin.isVisible(),
    offReason,
    ageMs: Date.now() - lastHeartbeatAt
  }
}

/** Send the latest heartbeat to the dashboard now, and update the tray. */
function pushStatus(): void {
  const beat = currentBeat()
  if (beat) sendToUi(IPC.statusBeat, beat)
  refreshStatus()
}

/** Re-derive the status for the tray. Silence is what turns it off, so this runs on a
 *  timer as well as on each heartbeat. */
function refreshStatus(): void {
  const beat = currentBeat()
  const view = deriveStatus(beat, beat === null ? Infinity : beat.ageMs)
  if (trayView === null || trayView.status !== view.status) {
    console.log(`[status] ${STATUS_LABEL[view.status]}: ${view.detail}`)
  }
  trayView = view
  tray?.update(view)
}

function hideOverlay(reason: string): void {
  if (alive(overlayWin) && overlayWin.isVisible()) overlayWin.hide()
  console.log(`[overlay] hidden: ${reason}`)
  sendOverlayState({ visible: false, reason })
}

function showOverlay(reason: string): void {
  if (!alive(overlayWin)) return
  overlayWin.showInactive()
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  raiseDashboard()
  console.log(`[overlay] shown: ${reason}`)
  sendOverlayState({ visible: true, reason })
}

/**
 * Fail open, or the user's off switch: hide the overlay at once, then tell the renderer to
 * go to Disabled. A frozen renderer gets the message when it recovers, and stays hidden
 * until the user switches protection back on.
 * @param reason in words, for the status line ("Switched off from the dashboard")
 */
function disableProtection(reason: string): void {
  protectionOn = false
  offReason = reason
  hideOverlay(`Protection off: ${reason}`)
  if (alive(overlayWin)) overlayWin.webContents.send(IPC.protection, false, reason)
  pushStatus()
}

/**
 * The user's on switch. Refused while the renderer is not sending heartbeats, since a
 * frozen overlay must not be shown again, and when detection has failed, since there is
 * nothing to switch on.
 * @returns whether protection was switched on
 */
function enableProtection(reason: string): boolean {
  if (lastHeartbeatAt === null || Date.now() - lastHeartbeatAt > WATCHDOG_MS) {
    console.log('[protection] not switched back on: the overlay renderer is not responding')
    sendOverlayState({ visible: false, reason: 'Protection off: overlay not responding' })
    return false
  }
  if (lastHeartbeat?.state === 'off') {
    console.log('[protection] not switched back on: detection failed, restart CalmFrame')
    return false
  }
  protectionOn = true
  offReason = null
  if (alive(overlayWin)) overlayWin.webContents.send(IPC.protection, true, reason)
  showOverlay(reason)
  return true
}

function setProtection(enabled: boolean, where: 'dashboard' | 'tray menu'): boolean {
  if (enabled) return enableProtection(where)
  disableProtection(`Switched off from the ${where}`)
  return true
}

/** Watchdog ("Safety mechanisms"): no heartbeat for WATCHDOG_MS hides the overlay and sets
 *  Disabled, because a frozen opaque overlay would block the whole screen. */
function onHeartbeat(heartbeat: Heartbeat): void {
  lastHeartbeat = heartbeat
  lastHeartbeatAt = Date.now()
  if (watchdogTimer !== null) clearTimeout(watchdogTimer)
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null
    const silent = lastHeartbeatAt === null ? 'unknown' : String(Date.now() - lastHeartbeatAt)
    if (protectionOn) {
      disableProtection(`The overlay stopped responding (no heartbeat for ${silent} ms)`)
    } else {
      console.log(`[watchdog] no heartbeat for ${silent} ms (protection already off)`)
    }
  }, WATCHDOG_MS)
  pushStatus()
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

/** Tell every renderer the settings now in force: the overlay applies the detector
 *  options, the dashboard and debug window show them. */
function broadcastSettings(settings: Settings): void {
  for (const win of [overlayWin, dashboardWin, debugWin]) {
    if (alive(win)) win.webContents.send(IPC.settings, settings)
  }
}

function installIpc(): void {
  ipcMain.handle(IPC.getInit, (): InitInfo => ({
    settings: (store as SettingsStore).settings,
    startedAtWallMs,
    nativeCapture: nativeCaptureRequested
  }))

  // The overlay registers its texture receiver first, then asks for the frames.
  ipcMain.handle(IPC.startNativeCapture, (event): NativeCaptureStart => {
    const overlay = overlayWin
    if (!alive(overlay) || event.sender !== overlay.webContents) {
      return { ok: false, error: 'only the overlay can start native capture' }
    }
    try {
      const info = nativeCapture.start(overlay.webContents, (message) => {
        console.error(`[native capture] error: ${message}`)
        if (alive(overlayWin)) overlayWin.webContents.send(IPC.nativeCaptureError, message)
      })
      console.log(
        `[native capture] started: ${info.width}x${info.height} on ${info.output} (${info.adapter}, LUID ${info.adapterLuid}), ${info.method}, ${info.slots} slots`
      )
      return { ok: true, info }
    } catch (error) {
      console.error(`[native capture] could not start: ${String(error)}`)
      return { ok: false, error: String(error) }
    }
  })

  ipcMain.on(IPC.updateSettings, (_event, patch: unknown) => {
    if (!store) return
    const before = store.settings
    const after = store.update(patch)
    if (after === before) return
    logSafely(
      'settings',
      () =>
        `[settings] sensitivity ${JSON.stringify(after.sensitivity)}, concurrency rule ${after.concurrency}, mitigation ${after.mitigation}, flash limit ${after.flashLimit}/s`
    )
    broadcastSettings(after)
  })

  ipcMain.handle(IPC.setProtection, (_event, enabled: unknown) =>
    typeof enabled === 'boolean' ? setProtection(enabled, 'dashboard') : false
  )

  let lastLog = 0
  let lastSettings = ''
  ipcMain.on(IPC.captureStats, (_event, stats: CaptureStats) => {
    sendToUi(IPC.captureStats, stats)
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
        const native = stats.source === 'native' ? nativeCapture.stats() : null
        const nativeText = native
          ? ` | native: ${stats.repeats} repeats/s, missed ${native.missedPresents}, no free slot ${native.droppedNoSlot}, access lost ${native.accessLost}, send errors ${native.sendErrors}${native.lastSendError ? ` (${native.lastSendError})` : ''}`
          : ''
        return `[capture] ${stats.source} ${stats.fps} fps | ${delay} | ${stats.width}x${stats.height} | skipped ${stats.skippedFrames}/${stats.framesTotal}${nativeText}`
      })
    }
  })

  ipcMain.on(IPC.captureError, (_event, message: string) => {
    console.error(`[capture] error: ${message}`)
    disableProtection(`Screen capture failed: ${message}`)
  })

  ipcMain.on(IPC.pipelineError, (_event, message: string) => {
    console.error(`[pipeline] error: ${message}`)
    disableProtection(`Detection failed: ${message}`)
  })

  ipcMain.on(IPC.heartbeat, (_event, heartbeat: Heartbeat) => onHeartbeat(heartbeat))

  ipcMain.on(IPC.smoothSelfTest, (_event, result: SmoothSelfTestResult) => {
    smoothSelfTest = result
    sendToDebug(IPC.smoothSelfTest, result)
    logSafely(
      'smooth self-test',
      () => `[smooth self-test] ${result.pass ? 'PASS' : 'FAIL'}: ${result.detail}`
    )
    const correction = result.correction
    if (correction) {
      logSafely(
        'correct self-test',
        () =>
          `[correct self-test] ${correction.pass ? 'PASS' : 'FAIL ("Keep motion sharp" will smooth instead)'}: ${correction.detail}`
      )
    }
  })

  ipcMain.on(IPC.stateChange, (_event, change: StateChange) => {
    sendToDebug(IPC.stateChange, change)
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
    sendToDebug(IPC.gridSelfTest, result)
    logSafely(
      'grid self-test',
      () => `[grid self-test] ${result.pass ? 'PASS' : 'FAIL'}: ${result.detail}`
    )
  })

  let lastDetectLog = 0
  ipcMain.on(IPC.detectionStats, (_event, stats: DetectionStats) => {
    sendToUi(IPC.detectionStats, stats)
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
        `hot ${stats.hotCells}, rule ${stats.concurrency} (set aside ${stats.ignoredReversals}) | state ${stats.state}, alpha ${fmt(sm.alpha, 3)}, d ${fmt(sm.dim, 2)}, ` +
        `opacity ${fmt(sm.opacity, 2)}${sm.drawn ? ' (drawn)' : ''}, method ${sm.method} | ` +
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

  // The thumbnails only go to the dashboard, and only while someone can see it.
  ipcMain.on(IPC.thumbnails, (_event, thumbnails: Thumbnails) => {
    if (alive(dashboardWin) && dashboardWin.isVisible() && !dashboardWin.isMinimized()) {
      dashboardWin.webContents.send(IPC.thumbnails, thumbnails)
    }
  })

  ipcMain.on(IPC.flashEvent, (_event, event: FlashEventMessage) => {
    sendToUi(IPC.flashEvent, event)
    logSafely(
      'event',
      () =>
        `[event] #${event.id} ${event.kind}: ${flashEventText(event, startedAtWallMs)} (${event.type})`
    )
  })

  ipcMain.on(IPC.hazardEvent, (_event, event: HazardEvent) => {
    sendToDebug(IPC.hazardEvent, event)
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
    sendToDebug(IPC.selfCheckResult, result)
    logSafely('self-check', () => `[self-check] ${result.verdict.toUpperCase()}: ${result.detail}`)
    result.cycles.forEach((c, i) => {
      logSafely(
        'self-check',
        () =>
          `[self-check]   cycle ${i + 1}: red ratio off ${fmt(c.hidden.redRatio, 3)} -> on ${fmt(c.shown.redRatio, 3)}, black share on ${fmt(c.shown.blackFraction, 2)}`
      )
    })
  })

  // The debug window's stacking test: above the overlay, and excluded from capture so it
  // doesn't appear in its own preview. The dashboard does this always.
  ipcMain.on(IPC.debugSetOnTop, (_event, onTop: boolean) => {
    if (!alive(debugWin)) return
    debugWin.setContentProtection(onTop)
    debugWin.setAlwaysOnTop(onTop, 'screen-saver')
    if (onTop) debugWin.moveTop()
    console.log(`[debug] above overlay + content protected: ${onTop}`)
  })
}

function start(): void {
  electronApp.setAppUserModelId('com.calmframe.app')

  // F12 opens DevTools in dev; Ctrl+R reload is disabled in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  store = new SettingsStore(join(app.getPath('userData'), SETTINGS_FILE_NAME))
  installDisplayMediaHandler()
  installIpc()

  // The overlay first, then the dashboard, which is raised above it.
  overlayWin = createOverlayWindow()
  dashboardWin = createDashboardWindow()
  if (debugWindowOn) debugWin = createDebugWindow()

  tray = new CalmTray({
    setProtection: (enabled) => {
      if (!setProtection(enabled, 'tray menu')) tray?.refresh()
    },
    showDashboard,
    quit: () => {
      quitting = true
      app.quit()
    }
  })
  refreshStatus()
  setInterval(refreshStatus, STATUS_REFRESH_MS)

  // Kill switch ("Safety mechanisms"): to Disabled and hidden at once, and back on.
  const registered = globalShortcut.register(KILL_SWITCH_ACCELERATOR, () => {
    if (protectionOn) disableProtection(`Switched off with ${KILL_SWITCH_LABEL}`)
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
}

// One CalmFrame at a time. A second copy would capture the screen alongside the first
// (Phase 5 found two dev instances running, at about 33 fps instead of 40 to 45) and could
// not register the kill switch. Launching it again shows the running one's dashboard.
if (!app.requestSingleInstanceLock()) {
  console.log('[app] CalmFrame is already running; showing its dashboard instead')
  app.quit()
} else {
  app.on('second-instance', () => showDashboard())
  app.whenReady().then(start)
}

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  nativeCapture.stop()
  globalShortcut.unregisterAll()
  store?.flush()
  tray?.destroy()
  tray = null
})

// Windows is the only target, so quit when the last window closes. Closing the dashboard
// only hides it, so this is reached when quitting from the tray.
app.on('window-all-closed', () => {
  app.quit()
})
