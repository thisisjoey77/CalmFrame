import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type CalmFrameApi } from '../shared/messages'

const api: CalmFrameApi = {
  sendCaptureStats: (stats) => ipcRenderer.send(IPC.captureStats, stats),
  sendCaptureError: (message) => ipcRenderer.send(IPC.captureError, message),
  sendSelfCheckResult: (result) => ipcRenderer.send(IPC.selfCheckResult, result),
  onSelfCheckRun: (callback) => {
    ipcRenderer.on(IPC.selfCheckRun, () => callback())
  },
  onCaptureRestart: (callback) => {
    ipcRenderer.on(IPC.captureRestart, (_event, size) => callback(size))
  },
  runSelfCheck: () => ipcRenderer.send(IPC.selfCheckRun),
  restartCapture: (size) => ipcRenderer.send(IPC.captureRestart, size),
  setDebugOnTop: (onTop) => ipcRenderer.send(IPC.debugSetOnTop, onTop),
  onCaptureStats: (callback) => {
    ipcRenderer.on(IPC.captureStats, (_event, stats) => callback(stats))
  },
  onSelfCheckResult: (callback) => {
    ipcRenderer.on(IPC.selfCheckResult, (_event, result) => callback(result))
  },
  onOverlayState: (callback) => {
    ipcRenderer.on(IPC.overlayState, (_event, state) => callback(state))
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
