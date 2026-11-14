/**
 * Native screen capture (trail #9). The C++ module in native/capture duplicates the primary
 * display with DXGI Desktop Duplication into a ring of shared D3D11 textures. This file
 * imports each one with Electron's sharedTexture API and sends it to the overlay renderer,
 * which uploads it with WebGL like a <video> frame. Only a texture handle and a few numbers
 * cross the process boundary, never pixels.
 *
 * Lifetime: the module marks a slot busy when it sends it, and this file calls
 * release(slot) from allReferencesReleased, after main and the overlay have both released
 * their references. A busy slot is never written.
 */

import { app, sharedTexture, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { NATIVE_CAPTURE_REPEAT_MS } from '../shared/config'
import type { NativeCaptureInfo, NativeFrameMeta } from '../shared/messages'

/** One frame from the module (see native/capture/src/capture.cc, DeliverFrame). */
interface ModuleFrame {
  slot: number
  /** The texture's NT handle as 8 bytes, the layout Electron's importer reads. */
  handle: Buffer
  width: number
  height: number
  presentMs: number
  presentEpochMs: number
  readyMs: number
  accumulatedFrames: number
  repeat: boolean
}

export interface ModuleStats {
  acquired: number
  emitted: number
  droppedNoSlot: number
  pointerOnly: number
  timeouts: number
  accessLost: number
  missedPresents: number
  repeats: number
  busySlots: number
}

interface CaptureModule {
  start(
    onFrame: (frame: ModuleFrame) => void,
    onError: (message: string) => void,
    options: { repeatMs: number }
  ): NativeCaptureInfo
  release(slot: number): void
  stop(): void
  stats(): ModuleStats | null
}

export interface NativeCaptureStats extends ModuleStats {
  sent: number
  sendErrors: number
  lastSendError: string | null
}

/** Where the built module is: next to the sources in development, in the app's resources
 *  folder when packaged (electron-builder extraResources). */
function modulePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'calmframe_capture.node')
    : join(app.getAppPath(), 'native', 'capture', 'build', 'Release', 'calmframe_capture.node')
}

export class NativeCapture {
  private module: CaptureModule | null = null
  private target: WebContents | null = null
  /** Bumped on every start and stop, so a late release from an earlier run is ignored. */
  private generation = 0
  private sent = 0
  private sendErrors = 0
  private lastSendError: string | null = null

  get running(): boolean {
    return this.module !== null
  }

  /**
   * Start capturing and sending frames to `target`, whose preload must already have
   * registered its receiver. Throws if the module cannot be loaded or cannot start.
   */
  start(target: WebContents, onError: (message: string) => void): NativeCaptureInfo {
    this.stop()
    const load = createRequire(__filename)
    const module = load(modulePath()) as CaptureModule
    const generation = ++this.generation
    this.target = target
    const info = module.start((frame) => this.onFrame(module, generation, frame), onError, {
      repeatMs: NATIVE_CAPTURE_REPEAT_MS
    })
    this.module = module
    this.sent = 0
    this.sendErrors = 0
    this.lastSendError = null
    return info
  }

  stop(): void {
    this.generation++
    const module = this.module
    this.module = null
    this.target = null
    module?.stop()
  }

  stats(): NativeCaptureStats | null {
    const s = this.module?.stats()
    if (!s) return null
    return { ...s, sent: this.sent, sendErrors: this.sendErrors, lastSendError: this.lastSendError }
  }

  private onFrame(module: CaptureModule, generation: number, frame: ModuleFrame): void {
    const release = (): void => {
      if (generation === this.generation) module.release(frame.slot)
    }
    const target = this.target
    if (generation !== this.generation || !target || target.isDestroyed()) {
      release()
      return
    }
    let imported: Electron.SharedTextureImported
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: 'bgra',
          codedSize: { width: frame.width, height: frame.height },
          handle: { ntHandle: frame.handle },
          // Microseconds; it becomes the VideoFrame's timestamp.
          timestamp: Math.round(frame.presentEpochMs * 1000)
        },
        allReferencesReleased: release
      })
    } catch (error) {
      release()
      this.sendErrors++
      this.lastSendError = String(error)
      return
    }
    const meta: NativeFrameMeta = {
      presentEpochMs: frame.presentEpochMs,
      repeat: frame.repeat,
      missed: frame.accumulatedFrames > 1 ? frame.accumulatedFrames - 1 : 0
    }
    sharedTexture
      .sendSharedTexture({ frame: target.mainFrame, importedSharedTexture: imported }, meta)
      .then(() => {
        this.sent++
      })
      .catch((error: unknown) => {
        this.sendErrors++
        this.lastSendError = String(error)
      })
      .finally(() => imported.release())
  }
}
