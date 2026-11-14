# CalmFrame

> **Flashing-content warning.** This project deals with strobing images. The test tools start paused, at low contrast, with an auto-stop.

## What it is

CalmFrame is a Windows app that watches the whole screen for flashing that breaks the WCAG 2.3.1 flash thresholds. When it finds some, it covers the screen with a smoothed copy within one or two flashes. It works across every app (video players, browsers, games in borderless-windowed mode) and runs entirely offline. It reduces exposure to hazardous flashing. It is not a medical device and does not guarantee anything.

Built at EmoryHacks 2026 (Entertainment track).

## How to run

Requirements: Windows 10 version 2004 or later, or Windows 11; Node.js 22 or later.

```sh
npm install
npm run dev        # run the app
npm test           # unit tests
npm run build:win  # packaged installer in dist/
```

_TODO: tray, kill switch (Ctrl+Alt+Shift+C), dashboard walkthrough._

## How it works

_TODO, summarising docs/SPEC.md:_

- Capture: the primary screen at 60 fps, through an overlay window that is excluded from capture.
- Detection: linear-light luminance on a 96×54 grid, a per-cell transition tracker, and the WCAG area rule over a 10° visual field.
- Mitigation: a per-pixel running average whose strength is solved from the detected flash, plus dimming where smoothing alone can't get under the threshold.

## Measurements

_TODO (Phase 6): flashes reaching the viewer with protection on and off, response time, per-second agreement with IRIS (Python port), and residual swing after smoothing._

## Limitations

_TODO. Known so far: the first one or two flashes pass before protection lands. DRM-protected video captures as black. Exclusive-fullscreen games may sit above the overlay. Screen recorders can't see the overlay._

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
- [Entire](https://entire.com/): agent session capture, checkpoints and repository hosting
- [Claude Code](https://claude.com/claude-code): AI coding assistant used to write much of the code
- [IRIS (Python port, `iris-pse-detection`)](https://pypi.org/project/iris-pse-detection/), based on [EA's IRIS](https://github.com/electronicarts/IRIS): reference analyzer we compare against (validation only)
- [FFmpeg](https://ffmpeg.org/): test clip generation and decoding for the validator (planned)
- Standards and research: [W3C WCAG 2.3.1](https://w3c.github.io/wcag21/understanding/three-flashes-or-below-threshold.html), Epilepsy Foundation reviews (Harding et al. 2005, Fisher et al. 2005 and 2022), and [Apple's Video Flashing Reduction paper](https://developer.apple.com/accessibility/downloads/Video-Flashing-Reduction-12.pdf)

## What we built vs what we used

_TODO: keep this honest and current._

| Built by us | Used as-is |
| --- | --- |
| Detector core (transition tracker, area rule, filter math, state machine) | Electron, Vite, electron-vite template and toolkit presets |
| Overlay capture and GPU pipeline | WebGL2 |
| Dashboard, tray, strobe test page | IRIS (Python port), for comparison only |
| Validator CLI and measurements | FFmpeg |
