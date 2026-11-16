# CalmFrame

> **Flashing-content warning.** This project deals with strobing images. The test tools start paused, at low contrast, with an auto-stop.

## What it is

CalmFrame is a Windows app that watches the whole screen for flashing that breaks the WCAG 2.3.1 flash thresholds. When it finds some, it covers the screen with a smoothed copy within one or two flashes. It works across every app (video players, browsers, games in borderless-windowed mode) and runs entirely offline. It reduces exposure to hazardous flashing. It is not a medical device and does not guarantee anything.

Winner of Entertainment track at Emoryhacks 2026 + Coder for Good Sponsor prize. 

## How to run

Requirements: Windows 10 version 2004 or later, or Windows 11; Node.js 22 or later. Building the native capture module also needs Python 3 and the Visual Studio 2022 Build Tools with the "Desktop development with C++" workload.

```sh
npm install
npm run native:build  # the native screen capture module (once, and after changing it)
npm run dev        # run the app
npm test           # unit tests
npm run build:win  # packaged installer in dist/
```

### Using it

CalmFrame runs in the tray and opens its dashboard at the top right of the screen. The dashboard stays above everything else, and screen recorders can't see it, so film it with a phone.

- **Status.** "Protected" means frames are flowing and the detector is running. "Smoothing" means flashing was found and you are seeing a smoothed copy. "Protection off" says why it is off. The status is worked out again four times a second from the overlay's heartbeat, so it can't get stuck on "Protected".
- **Graph.** Flashes per second over the most affected part of the screen, against the WCAG limit of 3.
- **Raw input (unprotected)** is a 240×135 view of what the detector sees, kept small enough that it can't become a hazardous flashing area itself. **Protected preview** shows what you see while CalmFrame is smoothing.
- **Flash events.** One line per event, such as `0:42, 8 Hz, 2.1 s, smoothed`, and a count of the events smoothed since start.
- **Sensitivity.** From "most sensitive" (smooths on the 2nd fast change) through "standard" (the 3rd, the default) and "fewer false alarms" (the 4th) to "strict" (only more than 3 flashes in a second). Each position shows how many flashes of a 10 Hz strobe the spec predicts get through first.
- **Ignore movement** (on by default) stops scrolling and dragging windows from starting the smoothing.
- **Ctrl+Alt+Shift+C** switches protection off and on from anywhere. So do the dashboard's switch and the tray menu. Protection is always on when CalmFrame starts.
- Settings are saved in `%APPDATA%\calmframe\settings.json`. Closing the dashboard keeps CalmFrame in the tray. Quit from the tray menu.

## How it works

_TODO, summarising docs/SPEC.md:_

- Capture: the primary screen at 60 fps and full resolution, through an overlay window that is excluded from capture. A small C++ module (`native/capture`) uses Windows' Desktop Duplication to copy each new screen frame into a shared GPU texture, which Electron's `sharedTexture` API hands to the overlay without the pixels ever leaving the GPU. If the module is missing or cannot start, CalmFrame falls back to Chromium's screen capture (`CALMFRAME_NATIVE_CAPTURE=0` forces it).
- Detection: linear-light luminance on a 96×54 grid, a per-cell transition tracker, and the WCAG area rule over a 10° visual field.
- Mitigation: a per-pixel running average whose strength is solved from the detected flash, plus dimming where smoothing alone can't get under the threshold.

## Measurements

_TODO (Phase 6): flashes reaching the viewer with protection on and off, response time, and residual swing after smoothing._

### Compared against IRIS (Python port)

`tools/validate` runs CalmFrame's detector, the same code as the app, on video files, and compares it second by second with the community Python port of EA's IRIS. Results are in [measurements/iris-comparison.md](measurements/iris-comparison.md).

To reproduce (Windows; Node 22 or later and Python 3.11):

```sh
python -m venv %USERPROFILE%\.calmframe\iris-venv
%USERPROFILE%\.calmframe\iris-venv\Scripts\pip install iris-pse-detection==1.1.2 imageio-ffmpeg
npm run validate:all     # makes the 11 test clips, runs IRIS and CalmFrame, writes the report
```

`imageio-ffmpeg` brings its own ffmpeg, so nothing needs installing system-wide. Set `CALMFRAME_FFMPEG` to use another ffmpeg, or `CALMFRAME_IRIS` for another `iris` command. To check one file: `npm run validate -- <video> [--area wcag|iris] [--trigger early|strict] [--extended]`. That writes one CSV row per second to `measurements/validate/`.

## Limitations

_TODO. Known so far:_

- The first one or two flashes pass before protection lands.
- DRM-protected video captures as black.
- Exclusive-fullscreen games may sit above the overlay.
- Screen recorders can't see the overlay or the dashboard. Both are excluded from capture on purpose, so the detector only ever sees the real screen.
- Only the primary display is protected, and a rotated display is not supported by the native capture (it falls back to Chromium's).
- With the fallback, Chromium's capture, speed depends on screen resolution and CPU power mode: about 50 fps at a 960×540 cap on our demo laptop, so the smoothed copy is softer, and a ghost cursor can appear in it. The native capture runs at 60 fps at full resolution and leaves the cursor out.

## Credits

- [Electron](https://www.electronjs.org/): desktop app runtime
- [electron-vite](https://electron-vite.org/) and its `@quick-start/create-electron` template: build tooling and project scaffold
- [@electron-toolkit](https://github.com/alex8088/electron-toolkit): preload, utils, tsconfig and ESLint presets from the template
- [Vite](https://vite.dev/): bundler and dev server
- [TypeScript](https://www.typescriptlang.org/)
- [Vitest](https://vitest.dev/): unit tests
- [ESLint](https://eslint.org/) and [Prettier](https://prettier.io/): linting and formatting
- [electron-builder](https://www.electron.build/): Windows installer
- WebGL2: GPU analysis and smoothing passes (browser API)
- Windows DXGI Desktop Duplication and Direct3D 11: native screen capture
- [node-addon-api](https://github.com/nodejs/node-addon-api) and [node-gyp](https://github.com/nodejs/node-gyp): building the native module
- [Entire](https://entire.com/): agent session capture, checkpoints and repository hosting
- [Claude Code](https://claude.com/claude-code): AI coding assistant used to write much of the code
- [IRIS (Python port, `iris-pse-detection`)](https://pypi.org/project/iris-pse-detection/), based on [EA's IRIS](https://github.com/electronicarts/IRIS): reference analyzer we compare against (validation only)
- [FFmpeg](https://ffmpeg.org/), via the [imageio-ffmpeg](https://pypi.org/project/imageio-ffmpeg/) package's bundled build: test clip generation and decoding for the validator
- Standards and research: [W3C WCAG 2.3.1](https://w3c.github.io/wcag21/understanding/three-flashes-or-below-threshold.html), Epilepsy Foundation reviews (Harding et al. 2005, Fisher et al. 2005 and 2022), and [Apple's Video Flashing Reduction paper](https://developer.apple.com/accessibility/downloads/Video-Flashing-Reduction-12.pdf)

## What we built vs what we used

_TODO: keep this honest and current._

| Built by us | Used as-is |
| --- | --- |
| Detector core (transition tracker, area rule, filter math, state machine) | Electron, Vite, electron-vite template and toolkit presets |
| Overlay capture and GPU pipeline | WebGL2 |
| Native capture module (C++, Desktop Duplication into shared textures) | Electron's `sharedTexture` API, DXGI and Direct3D 11, node-addon-api |
| Dashboard, tray, strobe test page | IRIS (Python port), for comparison only |
| Validator CLI and measurements | FFmpeg |
