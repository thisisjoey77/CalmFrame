import { contextBridge, ipcRenderer, sharedTexture } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type CalmFrameApi, type NativeFrameMeta } from '../shared/messages'

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
  sendDetectionStats: (stats) => ipcRenderer.send(IPC.detectionStats, stats),
  sendHazardEvent: (event) => ipcRenderer.send(IPC.hazardEvent, event),
  sendGridSelfTest: (result) => ipcRenderer.send(IPC.gridSelfTest, result),
  sendPipelineError: (message) => ipcRenderer.send(IPC.pipelineError, message),
  sendSmoothSelfTest: (result) => ipcRenderer.send(IPC.smoothSelfTest, result),
  sendHeartbeat: (heartbeat) => ipcRenderer.send(IPC.heartbeat, heartbeat),
  sendStateChange: (change) => ipcRenderer.send(IPC.stateChange, change),
  sendThumbnails: (thumbnails) => ipcRenderer.send(IPC.thumbnails, thumbnails),
  sendFlashEvent: (event) => ipcRenderer.send(IPC.flashEvent, event),
  onProtection: (callback) => {
    ipcRenderer.on(IPC.protection, (_event, enabled, reason) => callback(enabled, reason))
  },
  onDebugFreeze: (callback) => {
    ipcRenderer.on(IPC.debugFreeze, (_event, ms) => callback(ms))
  },
  startNativeCapture: () => ipcRenderer.invoke(IPC.startNativeCapture),
  onNativeCaptureError: (callback) => {
    ipcRenderer.on(IPC.nativeCaptureError, (_event, message) => callback(message))
  },
  getInit: () => ipcRenderer.invoke(IPC.getInit),
  onSettings: (callback) => {
    ipcRenderer.on(IPC.settings, (_event, settings) => callback(settings))
  },
  updateSettings: (patch) => ipcRenderer.send(IPC.updateSettings, patch),
  setProtection: (enabled) => ipcRenderer.invoke(IPC.setProtection, enabled),
  onStatusBeat: (callback) => {
    ipcRenderer.on(IPC.statusBeat, (_event, beat) => callback(beat))
  },
  onThumbnails: (callback) => {
    ipcRenderer.on(IPC.thumbnails, (_event, thumbnails) => callback(thumbnails))
  },
  onFlashEvent: (callback) => {
    ipcRenderer.on(IPC.flashEvent, (_event, event) => callback(event))
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
  },
  onDetectionStats: (callback) => {
    ipcRenderer.on(IPC.detectionStats, (_event, stats) => callback(stats))
  },
  onHazardEvent: (callback) => {
    ipcRenderer.on(IPC.hazardEvent, (_event, event) => callback(event))
  },
  onGridSelfTest: (callback) => {
    ipcRenderer.on(IPC.gridSelfTest, (_event, result) => callback(result))
  },
  onSmoothSelfTest: (callback) => {
    ipcRenderer.on(IPC.smoothSelfTest, (_event, result) => callback(result))
  },
  onStateChange: (callback) => {
    ipcRenderer.on(IPC.stateChange, (_event, change) => callback(change))
  }
}

/**
 * Native capture (trail #9). Main sends each frame as a shared texture; the page takes a
 * VideoFrame from it, uploads it and closes the frame before the callback returns. Then
 * this releases the page's reference, and once main's is released too the native module
 * may reuse the texture. Same shape as Electron's own sharedTexture test fixture.
 */
const nativeCapture = {
  onFrame: (
    callback: (texture: Electron.SharedTextureImported, meta: NativeFrameMeta) => void
  ): void => {
    sharedTexture.setSharedTextureReceiver(async (data, meta) => {
      try {
        callback(data.importedSharedTexture, meta as NativeFrameMeta)
      } finally {
        data.importedSharedTexture.release()
      }
    })
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('nativeCapture', nativeCapture)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.nativeCapture = nativeCapture
}
