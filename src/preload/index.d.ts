import { ElectronAPI } from '@electron-toolkit/preload'
import type { CalmFrameApi } from '../shared/messages'

declare global {
  interface Window {
    electron: ElectronAPI
    api: CalmFrameApi
  }
}
