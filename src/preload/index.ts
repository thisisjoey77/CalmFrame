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
  sendDetectionStats: (stats) => ipcRenderer.send(IPC.detectionStats, stats),
  sendHazardEvent: (event) => ipcRenderer.send(IPC.hazardEvent, event),
  sendGridSelfTest: (result) => ipcRenderer.send(IPC.gridSelfTest, result),
  sendPipelineError: (message) => ipcRenderer.send(IPC.pipelineError, message),
  sendSmoothSelfTest: (result) => ipcRenderer.send(IPC.smoothSelfTest, result),
  sendHeartbeat: (heartbeat) => ipcRenderer.send(IPC.heartbeat, heartbeat),
  sendStateChange: (change) => ipcRenderer.send(IPC.stateChange, change),
  onProtection: (callback) => {
    ipcRenderer.on(IPC.protection, (_event, enabled, reason) => callback(enabled, reason))
  },
  onDebugFreeze: (callback) => {
    ipcRenderer.on(IPC.debugFreeze, (_event, ms) => callback(ms))
  },
  onConcurrencyRule: (callback) => {
    ipcRenderer.on(IPC.concurrencyRule, (_event, rule) => callback(rule))
  },
  runSelfCheck: () => ipcRenderer.send(IPC.selfCheckRun),
  restartCapture: (size) => ipcRenderer.send(IPC.captureRestart, size),
  setDebugOnTop: (onTop) => ipcRenderer.send(IPC.debugSetOnTop, onTop),
  setConcurrencyRule: (rule) => ipcRenderer.send(IPC.concurrencyRule, rule),
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
