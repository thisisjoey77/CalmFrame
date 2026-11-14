/**
 * Open a screen capture stream. Main grants the primary screen through the
 * display-media request handler, so no picker appears (spec: "Capture requirements").
 */
export async function openScreenStream(
  frameRate: number,
  maxWidth: number,
  maxHeight: number
): Promise<MediaStream> {
  const video = {
    frameRate: { ideal: frameRate, max: frameRate },
    width: { max: maxWidth },
    height: { max: maxHeight },
    // Not in TypeScript's DOM types. Requested so no ghost cursor appears in the
    // smoothed copy; whether it is honoured shows up in track.getSettings().
    cursor: 'never'
  } as MediaTrackConstraints
  return navigator.mediaDevices.getDisplayMedia({ video, audio: false })
}
