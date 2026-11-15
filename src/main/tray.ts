/**
 * The tray icon and its menu (docs/SPEC.md, Phase 5). The icon and tooltip show the status
 * derived from the heartbeat ("flips the tray icon and dashboard to Protection off",
 * "Safety mechanisms"); the menu holds the on/off switch, "Ignore movement" and "Keep
 * motion sharp" (moved here from the dashboard in its redesign, Sat Nov 14, so the fallback
 * to the detector as first specified stays one click away), the dashboard and Quit.
 */

import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { TRAY_ICON_BASE_SIZE, TRAY_ICON_SCALES } from '../shared/config'
import type { Settings } from '../shared/settings'
import {
  DASHBOARD_TOGGLE_LABEL,
  STATUS_LABEL,
  type ProtectionStatus,
  type StatusView
} from '../shared/status'
import { drawStatusIcon, encodePng } from './trayIcon'

/** Windows cuts tray tooltips at 127 characters, and long menu items are hard to read. */
const TOOLTIP_MAX = 127
const MENU_DETAIL_MAX = 70

export interface TrayActions {
  setProtection(enabled: boolean): void
  setIgnoreMovement(on: boolean): void
  setKeepMotionSharp(on: boolean): void
  showDashboard(): void
  quit(): void
}

/** One image with a PNG representation per scale factor, so Windows picks a sharp one. */
function iconFor(status: ProtectionStatus): NativeImage {
  const image = nativeImage.createEmpty()
  for (const scaleFactor of TRAY_ICON_SCALES) {
    const size = Math.round(TRAY_ICON_BASE_SIZE * scaleFactor)
    const png = encodePng(drawStatusIcon(status, size), size, size)
    image.addRepresentation({
      scaleFactor,
      dataURL: `data:image/png;base64,${png.toString('base64')}`
    })
  }
  return image
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

export class CalmTray {
  private readonly tray: Tray
  private readonly icons: Record<ProtectionStatus, NativeImage>
  private view: StatusView = {
    status: 'off',
    detail: 'Starting up',
    switchOn: false,
    byUser: false
  }
  /** The two settings the menu shows, as main last sent them. */
  private ignoreMovement = true
  private keepMotionSharp = false

  constructor(private readonly actions: TrayActions) {
    this.icons = {
      protected: iconFor('protected'),
      smoothing: iconFor('smoothing'),
      off: iconFor('off')
    }
    this.tray = new Tray(this.icons.off)
    this.tray.on('click', () => actions.showDashboard())
    this.render()
  }

  /** Show a new status. Rebuilds the menu only when something in it changed. */
  update(view: StatusView): void {
    const v = this.view
    if (v.status === view.status && v.detail === view.detail && v.switchOn === view.switchOn) {
      return
    }
    this.view = view
    this.render()
  }

  /** Show the settings now in force. Rebuilds the menu only when one of its two changed. */
  setSettings(settings: Settings): void {
    const ignoreMovement = settings.concurrency === 'one-way'
    const keepMotionSharp = settings.mitigation === 'correct'
    if (ignoreMovement === this.ignoreMovement && keepMotionSharp === this.keepMotionSharp) {
      return
    }
    this.ignoreMovement = ignoreMovement
    this.keepMotionSharp = keepMotionSharp
    this.render()
  }

  /** Rebuild the menu from the current status, e.g. after main refused a switch the menu's
   *  checkbox had already flipped. */
  refresh(): void {
    this.render()
  }

  destroy(): void {
    this.tray.destroy()
  }

  private render(): void {
    const { status, detail, switchOn } = this.view
    const label = STATUS_LABEL[status]
    this.tray.setImage(this.icons[status])
    this.tray.setToolTip(clip(`CalmFrame: ${label}. ${detail}`, TOOLTIP_MAX))
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `CalmFrame: ${label}`, enabled: false },
        { label: clip(detail, MENU_DETAIL_MAX), enabled: false },
        { type: 'separator' },
        {
          label: 'Protection on',
          type: 'checkbox',
          checked: switchOn,
          click: (item) => this.actions.setProtection(item.checked)
        },
        { type: 'separator' },
        {
          label: 'Ignore movement (recommended)',
          type: 'checkbox',
          checked: this.ignoreMovement,
          click: (item) => this.actions.setIgnoreMovement(item.checked)
        },
        {
          label: 'Keep motion sharp (experimental)',
          type: 'checkbox',
          checked: this.keepMotionSharp,
          click: (item) => this.actions.setKeepMotionSharp(item.checked)
        },
        { type: 'separator' },
        {
          label: `Show dashboard (${DASHBOARD_TOGGLE_LABEL} hides it)`,
          click: () => this.actions.showDashboard()
        },
        { type: 'separator' },
        { label: 'Quit CalmFrame', click: () => this.actions.quit() }
      ])
    )
  }
}
