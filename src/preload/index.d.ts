import { ElectronAPI } from '@electron-toolkit/preload'
import type { CalmFrameApi, NativeFrameMeta } from '../shared/messages'

/** A native frame's texture as the overlay page sees it (Electron's SharedTextureImported,
 *  through the context bridge). The preload releases it after the callback returns. */
export interface NativeTexture {
  getVideoFrame(): VideoFrame
}

/** Native capture (trail #9): the overlay registers here before asking main to start. */
export interface NativeCaptureApi {
  onFrame(callback: (texture: NativeTexture, meta: NativeFrameMeta) => void): void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: CalmFrameApi
    nativeCapture: NativeCaptureApi
  }
}
