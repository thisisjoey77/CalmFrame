import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

type Page = 'dashboard' | 'overlay'

/** Load one of the renderer pages: the Vite dev server in dev, the built file otherwise. */
function loadPage(win: BrowserWindow, page: Page): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devUrl) {
    win.loadURL(`${devUrl}/${page}/index.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
  }
}

function createDashboardWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    title: 'CalmFrame',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadPage(win, 'dashboard')
  return win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.calmframe.app')

  // F12 opens DevTools in dev; Ctrl+R reload is disabled in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createDashboardWindow()
})

// Windows is the only target, so quit when the last window closes.
app.on('window-all-closed', () => {
  app.quit()
})
