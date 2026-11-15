/**
 * The dashboard's one notice line (redesigned as a small panel, Sat Nov 14, afternoon). The
 * panel has no status word, only the protection switch and a small status mark, so this
 * line is how it says in words that something is wrong. It appears only then, one message
 * at a time, most serious first:
 *
 * 1. Not protecting, for any reason except the user switching protection off (the switch
 *    already shows that). This keeps "Fails open, and says so" ("Safety mechanisms"): a
 *    stalled capture leaves the switch on, so without this line the panel would look as
 *    if it were protecting.
 * 2. "Keep motion sharp" is ticked (in the tray menu) but its pass failed its startup
 *    check on this computer, so the overlay smooths instead.
 *
 * The low capture-rate warning that Phase 5 showed is gone: the user asked for no fps
 * warning on the demo panel (Sat Nov 14, afternoon). Main still logs the rate.
 */

import type { StatusView } from './status'

export interface PanelNoticeInput {
  view: StatusView
  /** "Keep motion sharp" is on but the overlay reports that it draws with smoothing. */
  sharpUnavailable: boolean
}

export interface PanelNotice {
  /** 'problem' when protection is off; 'info' for a setting that fell back. */
  level: 'problem' | 'info'
  text: string
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

export function panelNotice({ view, sharpUnavailable }: PanelNoticeInput): PanelNotice | null {
  if (view.status === 'off') {
    return view.byUser
      ? null
      : { level: 'problem', text: `Not protecting: ${lowerFirst(view.detail)}` }
  }
  if (sharpUnavailable) {
    return {
      level: 'info',
      text: 'Keep motion sharp is not available on this computer, so CalmFrame smooths instead'
    }
  }
  return null
}
