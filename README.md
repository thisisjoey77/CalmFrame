# CalmFrame

**Live protection from hazardous screen flashing for people with photosensitive epilepsy, in every app on Windows.**

> **Flashing-content warning.** This project is about strobing images, and its test tools can flash. They open paused, at low contrast and in a small area, and stop on their own after a few seconds.

**1st place in the Entertainment track and the Coder for Good sponsor prize at EmoryHacks 2026.** The demo video and write-up are on [Devpost](https://devpost.com/software/calmframe).

## What it is

Flashing light can trigger seizures in people with photosensitive epilepsy: a strobing scene in a film, an explosion in a game, a music video. The web accessibility guidelines set a limit for it (WCAG 2.3.1, "Three Flashes or Below Threshold"): no more than three flashes in any one second that are both bright enough and large enough. Plenty of content breaks that limit, and a viewer can't know what a video or game will show next.

CalmFrame is a Windows app that watches the whole screen, 60 times a second, for flashing that breaks the WCAG 2.3.1 thresholds. When it finds some, it covers the screen with a calmed copy within one or two flashes. When the flashing stops, the screen goes back to normal on its own. It works across every app at once (browsers, video players, games in borderless-windowed mode), runs entirely offline on the computer's own GPU, and uses no AI: the detector implements a published standard, so every decision can be checked.

It reduces exposure to hazardous flashing. It is not a medical device and does not guarantee anything.

## How it works

A transparent window covers the whole screen, and Windows is told to leave it out of screen capture. So CalmFrame always sees the real screen underneath its own overlay. Without that, it would see its own calmed picture, decide the flashing had stopped, switch off, see the strobe again and switch back on: the fix would flash too. CalmFrame checks this at every start by tinting the overlay red and confirming that the captured picture doesn't change.

```text
The real screen
   │
   ▼
Capture          C++ module: Windows Desktop Duplication into a shared GPU texture,
   │             60 fps at full resolution (fallback: Chromium's screen capture)
   ▼
Grid (GPU)       convert to linear light, average down to 96×54 regions
   │
   ▼
Detector         per region: brightness reversals and red flashes; the WCAG area
   │             rule over a 10° field of view; act on the 3rd fast reversal
   ▼
State machine    safe, active or fading out: how strongly to calm and how much to dim
   │
   ▼
Draw (GPU)       only during a hazard: the calmed copy, on the overlay
   │
   ▼
Overlay window   always on top, click-through, invisible to screen capture
```

All the per-frame work runs on the GPU inside one process, so frames are never copied between processes.

- **Detection.** Brightness is measured as relative luminance in linear light, as WCAG defines it. A flash is a pair of opposing changes of at least 0.10 where the darker state is below 0.80, plus WCAG's separate rule for saturated red. It counts only if it covers at least a quarter of a 10° patch of the viewer's field, about 3% of the screen.
- **Acting early.** WCAG counts flashes over a whole second, so waiting to be sure would let three flashes through. CalmFrame acts on the third fast reversal in a region instead, which lets one or two through. A sensitivity slider moves this between the 2nd reversal, the 4th, and the strict per-second count.
- **Ignoring movement.** Scrolling and dragging windows also make regions flip between light and dark. A reversal only counts when a quarter of the area around it reverses the same way in the same frame, which stopped ordinary scrolling and window dragging from setting it off in our tests.
- **Calming.** By default ("Keep motion sharp") CalmFrame shows the current frame and scales each region's brightness toward that region's recent average, so moving things stay sharp. The alternative is a running average of recent frames, its strength solved from the detected flash rate: steadier, but it leaves trails behind moving things. Both aim to keep the leftover swing at 0.07, under WCAG's 0.10, and dim the picture where that isn't enough. Red flashes are also desaturated.
- **Fails open, and says so.** The overlay reports a heartbeat four times a second. If it stops, the frames go stale or a GPU self-test fails, the overlay is hidden and the app says "Not protecting" instead of leaving a frozen picture on screen.

The full maths, the derivations and every default value are in [docs/SPEC.md](docs/SPEC.md).

## The app

CalmFrame lives in the tray and shows a small window at the top right of the screen, which stays above the overlay:

- **Protection switch**, with a mark showing whether it is watching, calming or off.
- **Flashes per second** over the most affected part of the screen, as a live graph against the limit and as a number.
- **Sensitivity**, from "most sensitive" through "standard" (the default) to "strict".
- **Flash limit**: 3 a second, the WCAG limit, by default. It can be raised to 10 to see how content behaves at a looser limit, which lets through flashing that WCAG counts as a hazard. It goes back to 3 every time CalmFrame starts.
- **A notice line** that appears only when something is wrong.

The tray menu has "Ignore movement" and "Keep motion sharp", and Ctrl+Alt+Shift+C switches protection on and off from anywhere. Protection is always on when CalmFrame starts.

Screen recorders can't see CalmFrame's windows, by design, so footage of it working comes from a phone or from the offline render in `tools/validate`.

## Results

Measured on our demo laptop: Windows 11, 1920×1080 at 60 Hz, integrated AMD Radeon 890M.

| What | Result |
| --- | --- |
| Capture rate | 60 fps at full 1920×1080, with the native capture module |
| Capture to calmed picture drawn | 14 ms median, 19 ms at the 95th percentile. With Chromium's fallback capture: 20.4 and 28.0 ms ([measurements/latency.md](measurements/latency.md)) |
| Analysis cost per frame | 0.6 to 1.0 ms (median) at 1920×1080 |
| Leftover brightness swing on a 10 Hz test strobe | 0.070 to 0.074, against WCAG's 0.10 |
| Second-by-second agreement with IRIS (Python port) | 100% ([measurements/iris-comparison.md](measurements/iris-comparison.md)) |
| A real 2½-minute anime fight clip, offline | IRIS fails the original (23 failing frames) and passes CalmFrame's output with either calming method |
| Capture-exclusion self-check | The captured picture changed by 0.000 with the overlay tinted red |

What these numbers don't show:

- The latency comes from the app's own log and leaves out the time the display takes to show the frame. The planned end-to-end measurement, filming the screen at 240 fps, didn't happen during the weekend.
- The leftover swing was read on one low-contrast burst, three readings.
- The real-clip test ran offline at 640×360, and the clip isn't in this repo.

## Limitations

- The first one or two flashes get through before protection lands, because a single reversal looks the same as a scene cut.
- Protected video (Netflix and other DRM content) captures as black, so it can't be checked or calmed.
- Exclusive-fullscreen games may draw above the overlay. Borderless-windowed mode works.
- Only the primary display is protected, and a rotated display falls back to the slower Chromium capture.
- Some false alarms remain: very fast scrolling, fast camera turns in games, a tab switch that repaints three times, lightning in video. Each costs a couple of seconds of calmed picture, not a blocked screen.
- With "Ignore movement" on, a large checkerboard that swaps black and white isn't caught. Static stripe patterns, which IRIS also checks, aren't detected at all.
- "Keep motion sharp" steadies each region of about 20 pixels, not each pixel: finer detail can still alternate, and a thin rim can flicker where flashing content meets still content. The running average avoids both but leaves motion trails.
- Slow, full-contrast strobes (around 3 Hz) are the hardest case: they are calmed and dimmed to just under half brightness.
- Windows only. On macOS, the system's screen capture ignores Electron's capture-exclusion flag, so the overlay would see itself.

## What's in this repo

| Path | What |
| --- | --- |
| [src/core](src/core) | The detector, filter maths and state machine. Pure TypeScript with no Electron, browser or Node APIs, so the same code runs in the app, the tools and the tests |
| [src/shared](src/shared) | Every threshold and default value, in one config file, and the status rules |
| [src/overlay](src/overlay) | The overlay window: capture, the WebGL2 passes and the per-frame loop |
| [src/main](src/main), [src/preload](src/preload) | The Electron main process: windows, tray, settings and the native module |
| [src/dashboard](src/dashboard) | The small control window |
| [native/capture](native/capture) | The C++ capture module: Desktop Duplication into shared Direct3D 11 textures |
| [tools/strobe](tools/strobe) | A safe strobe test page: opens paused, low contrast and small, and stops itself |
| [tools/validate](tools/validate) | The IRIS comparison, and the offline render that runs a video through the app's own detector and filter and writes the calmed picture beside the original. The render is a simulation, not a recording of the live overlay |
| [measurements](measurements) | The IRIS comparison and latency results |
| [docs/SPEC.md](docs/SPEC.md) | The build spec: research, maths, architecture, defaults, and the plan we built from |

There are 377 unit tests in 31 files (Vitest).

## How we built it

- **Spec first.** The rules allowed planning before Friday 8 PM but no code, so we wrote a full build spec first: the research, the maths, the architecture, every default value, and an acceptance checklist for each phase. Checking it against primary sources changed four things before any code existed. For example, the "obvious" smoothing strength fails the standard, and the area rule is far stricter than we first thought.
- **Phases.** Seven phases, each with its own branch and checklist: overlay spike, detector core, strobe test page, live detection, the calming overlay, the dashboard, and validation. Then two stretch goals: native capture and "Keep motion sharp". The spec records each phase's measured results and every decision.
- **AI-assisted, kept honest by tests.** Much of the code was written with [Claude Code](https://claude.com/claude-code), one session per phase, each starting from the spec. The guardrails: the detector core is forced to stay pure (its own TypeScript project, with no DOM or Node types, and a lint rule against Electron and Node imports); every threshold lives in one config file; every GPU pass is checked against a CPU version at startup; and known weaknesses are pinned by tests rather than hidden.
- **[Entire](https://entire.com/)** captured every coding session and linked each commit to the prompts behind it, so we could search past decisions across two laptops instead of re-deriving them ([docs/ENTIRE-LOG.md](docs/ENTIRE-LOG.md)).
- **[Coder](https://coder.com/).** Everything that doesn't need the Windows desktop (the detector and its tests, the validator) was tested in a Coder workspace after every push: 19 logged runs ([docs/CODER-LOG.md](docs/CODER-LOG.md)). The overlay itself can't run there.
- **Two laptops.** A Windows 11 laptop, the only place the app runs, did all the live testing. A Mac took the pure core, the strobe page and the validator until Friday night.

## Team

| Name | GitHub |
| --- | --- |
| Kartikeya Jain | [@Apsidals](https://github.com/Apsidals) |
| Ashley Choi | [@ashleyes](https://github.com/ashleyes) |
| Joy Kim | [@thisisjoey77](https://github.com/thisisjoey77) |
| Jack Gardner | |

## Built by us, and what we used

| Built by us | Used as-is |
| --- | --- |
| Detector core: transition tracker, area rule, movement rule, filter maths, state machine | Electron, Vite, the electron-vite template and toolkit presets, TypeScript |
| Overlay capture and GPU pipeline (WebGL2 shaders for the grid, smoothing and brightness correction) | WebGL2 |
| Native capture module (C++, Desktop Duplication into shared textures) | Electron's `sharedTexture` API, Windows DXGI and Direct3D 11, node-addon-api |
| Dashboard, tray, settings and the strobe test page | Vitest, ESLint, Prettier, electron-builder |
| Validator, IRIS comparison, offline render and measurements | IRIS (Python port), for comparison only; FFmpeg |

Credits:

- [Electron](https://www.electronjs.org/): desktop app runtime
- [electron-vite](https://electron-vite.org/) and its `@quick-start/create-electron` template: build tooling and project scaffold
- [@electron-toolkit](https://github.com/alex8088/electron-toolkit): preload, utils, tsconfig and ESLint presets from the template
- [Vite](https://vite.dev/): bundler and dev server
- [TypeScript](https://www.typescriptlang.org/)
- [Vitest](https://vitest.dev/): unit tests
- [ESLint](https://eslint.org/) and [Prettier](https://prettier.io/): linting and formatting
- [electron-builder](https://www.electron.build/): Windows installer
- Windows DXGI Desktop Duplication and Direct3D 11: native screen capture
- [node-addon-api](https://github.com/nodejs/node-addon-api) and [node-gyp](https://github.com/nodejs/node-gyp): building the native module
- [IRIS (Python port, `iris-pse-detection`)](https://pypi.org/project/iris-pse-detection/), based on [EA's IRIS](https://github.com/electronicarts/IRIS): the reference analyzer we compare against (validation only)
- [FFmpeg](https://ffmpeg.org/), via the [imageio-ffmpeg](https://pypi.org/project/imageio-ffmpeg/) package's bundled build: test clips and decoding for the validator
- [Claude Code](https://claude.com/claude-code): AI coding assistant used to write much of the code
- [Entire](https://entire.com/): session capture and checkpoints
- [Coder](https://coder.com/): cloud workspace for the platform-independent tests
- Standards and research: [W3C WCAG 2.3.1](https://w3c.github.io/wcag21/understanding/three-flashes-or-below-threshold.html), Epilepsy Foundation reviews (Harding et al. 2005, Fisher et al. 2005 and 2022), and [Apple's Video Flashing Reduction paper](https://developer.apple.com/accessibility/downloads/Video-Flashing-Reduction-12.pdf)

## License

MIT. See [LICENSE](LICENSE).
