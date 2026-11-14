# CalmFrame build spec — EmoryHacks 2026

Nov 13, 2026 · @Jain

## Read this first

CalmFrame is a Windows desktop app that watches the whole screen, detects flashing that breaks the WCAG flash thresholds, and covers it with a smoothed copy within one or two flashes. This doc is the full spec: research, math, architecture, build order, and the prompts to paste into Claude Code at 8 PM.

It contains no code on purpose. Your rules allow ideating before 8 PM but not coding, so everything here is design, equations and instructions. Create the repo at 8:00, not before.

### Lock these before 8 PM

- [ ] **Demo laptop runs Windows 10 (version 2004 or later) or Windows 11.** This is now a hard recommendation, not a preference. See the third correction below.
- [ ] **One owner per workstream** (section "Build plan"): A capture and overlay, B detector, C dashboard and test page, D validation, measurement, video and Devpost.
- [ ] **Nobody with known or suspected photosensitivity runs strobe tests.** Most children affected in the 1997 Pokémon broadcast had no prior seizure history, so treat every teammate as possibly sensitive: low-contrast test flashes by default, short bursts, small window.
- [ ] **A phone that records 240 fps slow motion**, plus something to prop it on. It produces your headline number.
- [ ] **Python 3 on one laptop** for the validation tool (one `pip install`, details in "Validation and measurement").

### Four corrections to what we discussed earlier

I checked the earlier advice against the primary sources and the arithmetic. Four things change.

| Topic | What I said earlier | What is correct | What it changes |
| --- | --- | --- | --- |
| Area rule | A flash counts if it covers about a quarter of the central field, "roughly a 341×256 block" | The 341×256 block **is** the 10° field. The limit is 25% of it: about 148×148 px at 1024×768, or 2.8% of the screen | Detection needs a finer grid than "coarse", and a flashing video in a small window still counts. Spec uses 96×54 cells |
| Smoothing strength | A 0.85 / 0.15 running average cuts a 10 Hz flicker to about a tenth | On a full black-to-white 10 Hz strobe it leaves a 0.24 luminance swing. The limit is 0.10 | The filter must adapt: about 0.05 at 10 Hz, slower still plus dimming at 3 to 5 Hz. Derivation in "Mitigation math" |
| Mac | Electron's capture-exclusion flag is "less reliable" on recent macOS | Electron's own docs say ScreenCaptureKit-based capture ignores it. The overlay would see itself | Build on Windows. On a Mac the overlay plan most likely fails its first test |
| Validation tool | Build EA's C++ analyzer | A Python port installs with one pip command. I installed it and ran its CLI while writing this | Validation drops from a risky half-day build to under an hour |

One more thing worth knowing for the pitch: Apple's published algorithm reduces each frame to a single average luminance, so it cannot see a strobe confined to part of the screen. CalmFrame's per-region detection is a real technical difference, not just a platform one.

## The research

Three stimulus properties decide whether a flash is dangerous: how fast it repeats, how much the brightness changes, and how much of central vision it fills. Every guideline below is a threshold on those three, plus a special rule for saturated red.

### What the clinical literature says

- **Who is affected.** The Epilepsy Foundation's [2022 review](https://repository.essex.ac.uk/34275/) puts visually provoked seizures at up to 1 in 4,000 people and notes the true figure may be higher. Its [2005 review](https://research.aston.ac.uk/en/publications/photic-and-pattern-induced-seizures-a-review-for-the-epilepsy-fou/) estimated about 1 in 10,000 overall and 1 in 4,000 for ages 5 to 24.
- **What provokes them.** The 2022 review names flashes brighter than 20 cd/m², at 3 to 60 Hz and especially 15 to 20 Hz, covering at least 10 to 25% of the visual field. Red flashes and oscillating stripes are separate risks.
- **Where the numbers come from.** The [2005 expert consensus](https://research.aston.ac.uk/en/publications/photic-and-pattern-induced-seizures-expert-consensus-of-the-epile/) (Harding, Wilkins, Erba, Barkley, Fisher) set the hazard at ≥20 cd/m², ≥3 Hz and ≥0.006 steradians. It ties the three-per-second limit to Jeavons and Harding's patient studies.
- **The incident judges will know.** In the 1997 Pokémon broadcast, 685 children went to hospital after red-blue flashing. Only 24% of those who seized had a prior seizure, per the 2005 review. That is your case for protection people do not know they need.
- **What helps.** The 2022 review lists reducing contrast among the preventive measures. That is what CalmFrame does, automatically.

### The thresholds, side by side

WCAG and broadcast-style tools use the same flash definition but different area rules. The detector implements both, because you protect with one and validate against the other.

| Parameter | [WCAG 2.3.1](https://w3c.github.io/wcag21/understanding/three-flashes-or-below-threshold.html) | [IRIS](https://github.com/electronicarts/IRIS) defaults | CalmFrame |
| --- | --- | --- | --- |
| Luminance change | ≥10% of maximum relative luminance, darker state below 0.80 | 0.1, dark threshold 0.8 | Same |
| What a flash is | A pair of opposing changes (up then down, or down then up) | Counts transitions; two transitions make a flash | Counts transitions |
| Rate limit | No more than 3 flashes in any 1 s | Fail above 6 transitions in 1 s. Warning at 4. Extended fail at 4 to 6 sustained 4 s within 5 s | Early trigger at 3 fast transitions, strict at 7 |
| Area | 25% of any 10° visual field. About 341×256 px at 1024×768 for the field, so 21,824 px for the limit | 25% of the whole frame | Both, switchable |
| Saturated red | R/(R+G+B) ≥ 0.8 and change in (R−G−B)×320 above 20 | Red threshold 20 | Same |
| Exempt | Fine balanced patterns such as checkerboards with squares under 0.1° | n/a | Falls out of area averaging |

The IRIS column comes from its README and from the default configuration of the [Python port](https://pypi.org/project/iris-pse-detection/1.1.2/), which I read directly. The 0.006 steradian figure is where both area rules come from: it is a quarter of a 10° field up close, and roughly a quarter of a TV screen from a sofa.

### What already exists, and the gap

| Tool | What it does | Limit |
| --- | --- | --- |
| [Apple Dim Flashing Lights](https://developer.apple.com/accessibility/downloads/Video-Flashing-Reduction-12.pdf) | Live risk score from a flicker-visibility model, then compresses contrast and dims | Apple platforms and supported video only. One average luminance per frame, so no regional detection |
| [EA IRIS](https://github.com/electronicarts/IRIS) | Analyzes video files for luminance flashes, red flashes and patterns | Offline analysis, no mitigation |
| PEAT, Harding FPA | Named by W3C as analysis tools | Offline analysis, no mitigation |

I did not find a tool that mitigates live, across every app, on Windows. That is the gap CalmFrame fills.

### Two things Apple's paper gives you

Apple's own algorithm description says its processing is causal, so the first few flashes of a sequence pass unmitigated. Quote that when a judge asks why CalmFrame lets one or two through: the best-resourced implementation has the same limit.

Its mitigation also pulls each frame toward a running average of recent luminance and fades out with a 2-second time constant. CalmFrame's filter is the same family, applied per pixel instead of per frame.

## Detection math

The detector turns each captured frame into a 96×54 grid of luminance values, tracks brightness reversals per cell, and raises a hazard when enough neighbouring cells are reversing fast enough. It is a pure function of (frame grid, timestamp), with no dependence on Electron, so it can be unit-tested and reused in the offline validator.

### Step 1: linear light

Screen pixels are gamma-encoded. All thresholds are defined on linear relative luminance, so convert first. For each 8-bit channel value C scaled to 0–1:

```latex
C_{lin} = \begin{cases} C / 12.92 & C \le 0.04045 \\ \left( \dfrac{C + 0.055}{1.055} \right)^{2.4} & \text{otherwise} \end{cases}
```

```latex
Y = 0.2126\,R_{lin} + 0.7152\,G_{lin} + 0.0722\,B_{lin}
```

Y runs from 0 (black) to 1 (white). Mid-grey sRGB 128 is only Y = 0.22, and the 0.80 "dark" limit is sRGB 231, so almost every on-screen flash has a dark state under the limit.

### Step 2: the analysis grid

Average linear R, G and B over each cell of a 96×54 grid (5,184 cells). Averaging must happen after linearisation, on the GPU, with a true area average rather than point sampling.

Acceptance test: a one-pixel black and white checkerboard must read Y ≈ 0.5 in every cell, not 0.21. This also delivers WCAG's fine-pattern exemption for free, because an inverting checkerboard averages to a constant.

### Step 3: the red channel

Per cell, from the same linear averages:

```latex
\rho = \frac{R}{R + G + B} \qquad v = 320 \cdot \max(0,\; R - G - B)
```

A red transition is a change in v of more than 20 where ρ ≥ 0.8 in at least one of the two states.

### Step 4: the transition tracker

Each cell keeps a running extremum e and a direction d. A transition is recorded when the value has reversed by at least the threshold from the extremum, however many frames that took.

1. Each cell has a direction d that is idle, rising or falling. Start idle, with a running low and high both set to the first Y.
2. While idle: keep the running low and high up to date. If Y has risen 0.10 above the low, record a **rising transition**. If it has dropped 0.10 below the high, record a **falling transition**. Either way set d accordingly and e = Y.
3. While rising: if Y > e, set e = Y. If e − Y ≥ 0.10, record a **falling transition**, then set d = falling and e = Y.
4. While falling: the mirror image. If Y < e, set e = Y. If Y − e ≥ 0.10, record a **rising transition**, then set d = rising and e = Y.
5. A transition only counts if the darker of the two values is below 0.80. A reversal that fails this test is ignored outright: the cell keeps its direction and extremum. Otherwise a flash that ramps from 0.98 down to 0.5 is used up at 0.85 and never counted.
6. A cell with no transition for 1 s returns to idle, with low and high reset to the current Y.
7. Run the same tracker on v with threshold 20 for red.

The idle state matters. Without it, the first change after a static scene is missed whenever it happens to continue the cell's last remembered direction, and the trigger fires one transition late. I found this by prototyping the rules against the test clips.

Tracking the extremum instead of frame-to-frame differences matters. A flash that ramps over three frames, or a 30 fps video sampled at 60 Hz, still registers as one transition. IRIS accumulates differences across frames for the same reason.

### Step 5: per-cell bookkeeping

Each cell stores three things, all driven by capture timestamps rather than frame counts:

- **t\_last**: time of its latest transition, and **swing**: the size of that reversal, measured from the extremum it started at to the furthest point reached since. It keeps growing while a ramped flash continues.
- **count c**: transitions in the last 1.0 s, with the window open at its old end. An evenly spaced 3 Hz strobe therefore holds 6, and the strict trigger at 7 means more than 3 flashes.
- **streak s**: consecutive transitions each arriving within 167 ms of the one before. The first transition of a run counts as 1, so N = 3 fires on the third. Reset s to 0 when 167 ms pass with no transition.

The 167 ms figure is the three-per-second limit restated. More than 3 flashes per second means more than 6 transitions per second, so less than 1/6 s between them.

### Step 6: the area rule

Mark a cell hot when its streak or count meets the trigger (step 7). Then slide a window the size of a 10° visual field over the grid and find the largest hot fraction:

```latex
A = \max_{\text{windows}} \; \frac{\text{hot cells in window}}{w \cdot h} \qquad \text{hazard if } A \ge 0.25
```

Use a summed-area table so each window costs four lookups. Window size has two modes:

- **WCAG default:** one third of the grid each way (32×18 cells), matching 341×256 on 1024×768.
- **Calibrated:** from screen width and viewing distance D. A 10° field is 2·D·tan(5°) wide, which is 10.5 cm at 60 cm. That is 30% of a 15.6-inch laptop's width but only 20% of a 24-inch monitor's, so big screens are stricter.

A third mode, **IRIS-compatible**, replaces the window with the whole grid (hot cells ≥ 25% of all cells). Use it only for the validation comparison.

### Step 7: when to trigger

| Mode | Cell is hot when | Use |
| --- | --- | --- |
| Early (default) | streak s ≥ 3 | Protection. Fires on the third fast reversal |
| Strict | count c ≥ 7 | Matches a true violation: more than 3 flashes in 1 s |
| Slider | s ≥ N for N = 2, 3, 4, then strict | The user-facing sensitivity control |

The number of flashes a viewer sees before protection lands follows directly. With trigger count N, strobe frequency f and pipeline latency L:

```latex
F \approx \frac{N - 1}{2} + f \cdot L
```

| Strobe | Early (N = 3), L = 50 ms | Early, L = 75 ms | Early, L = 100 ms | Strict (N = 7), L = 75 ms |
| --- | --- | --- | --- | --- |
| 5 Hz | 1.25 | 1.38 | 1.50 | 3.38 |
| 10 Hz | 1.50 | 1.75 | 2.00 | 3.75 |
| 15 Hz | 1.75 | 2.13 | 2.50 | 4.13 |

A 60 Hz display can only show strobes at 30/n Hz: 30, 15, 10, 7.5, 6, 5 and so on. Use 5, 10 and 15 Hz as the standard test frequencies everywhere.

These are predictions. Your slow-motion measurement replaces them. The table also shows why trigger choice beats raw latency: going from strict to early saves two flashes, while shaving 25 ms saves a quarter of one.

### Step 8: what the detector hands to the filter

- **hazard** (boolean) and **type** (luminance or red).
- **f̂**, the flash frequency: 1 / (2 × median interval between transitions) over hot cells.
- **ΔL**, the flash size: 90th percentile of swing over hot cells.
- **hot mask**, for regional smoothing later.
- **graph value**: the largest k such that cells with count ≥ k fill 25% of some window, divided by 2. This is "flashes per second over a hazardous area", plotted against the limit line at 3.

### Known behaviour at the edges

- **Scene cuts** produce one transition and never trigger. A cut to white and back produces two and does not trigger at N = 3.
- **Lightning or gunfire** with two quick double-flashes can trigger early mode. That is the accepted false positive of a safety default.
- **Capture rate** bounds what you can see. At 60 fps capture you resolve up to 30 Hz. Below 45 fps, show a warning in the dashboard.
- **Frame gaps** over 250 ms reset all streaks, so a stall cannot fake a fast sequence.
- **Static spatial patterns** (stripes) are a separate hazard that IRIS detects and this spec does not. List it under future work.

## Mitigation math

During a hazard the overlay shows a time-averaged copy of the screen, with the averaging strength computed from the detected flash so the leftover brightness swing lands at 0.08, under WCAG's 0.10 flash threshold. Mild flashes get a light touch and violent ones get heavy smoothing.

### The filter

Per pixel and per channel, in linear light, with X the captured frame and S the smoothed state:

```latex
S_t = S_{t-1} + \alpha \,( X_t - S_{t-1} )
```

### How much flicker survives

For a square strobe of size ΔL at frequency f, captured at f\_s frames per second, each half-cycle lasts n = f\_s / (2f) frames. With β = 1 − α, the steady-state peak-to-peak swing left in S is:

```latex
r = \Delta L \cdot \frac{1 - \beta^{\,n}}{1 + \beta^{\,n}}
```

I checked this closed form against a frame-by-frame simulation and they agree to three decimals. Residual swing for a full black-to-white strobe (ΔL = 1) at 60 fps:

| α | 3 Hz | 5 Hz | 10 Hz | 15 Hz |
| --- | --- | --- | --- | --- |
| 0.15 | 0.67 | 0.45 | 0.24 | 0.16 |
| 0.10 | 0.48 | 0.31 | 0.16 | 0.10 |
| 0.05 | 0.25 | 0.15 | 0.08 | 0.05 |
| 0.03 | 0.15 | 0.09 | 0.05 | 0.03 |

The α = 0.10, 15 Hz cell is 0.105 to three decimals. An earlier draft rounded that to 0.11; the Phase 1 tests caught it. At 0.105 it is still a flash.

Anything above 0.10 is still a flash by the standard. A fixed α of 0.15 fails at every frequency in the table, which is why the filter adapts.

### Choosing α from the detection

Set the target residual ρ = 0.08 and invert the formula, using the detector's f̂ and ΔL:

```latex
\alpha = 1 - \left( \frac{\Delta L - \rho}{\Delta L + \rho} \right)^{1/n} \qquad n = \frac{f_s}{2 \hat{f}}
```

| Flash | Required α |
| --- | --- |
| ΔL = 1.0 at 10 Hz | 0.052 |
| ΔL = 0.5 at 10 Hz | 0.10 |
| ΔL = 0.3 at 10 Hz | 0.17 |
| ΔL = 1.0 at 15 Hz | 0.077 |
| ΔL = 1.0 at 3 Hz | 0.016 |

Clamp α to the range 0.03 to 0.30. Below 0.03 the image becomes a half-second smear and stops being watchable.

### Dimming covers what smoothing cannot

When the clamp stops α short, compute the residual r that the clamped α actually leaves, then scale brightness to close the gap:

```latex
d = \min\!\left(1,\; \frac{\rho}{r}\right), \quad d \ge 0.4 \qquad \text{output} = d \cdot S
```

Worst case, a full-contrast 3 Hz strobe: α clamps at 0.03, r = 0.15, so d = 0.53. The picture is heavily smoothed and about half brightness. That is the hard corner, and you should say so if asked.

### Red flashes

For a red hazard, also blend the output 50% toward its own grey level. That takes pure red from R/(R+G+B) = 1.0 down to 0.74, under the 0.8 saturated-red line, so no state counts as saturated red.

### Three implementation requirements

1. **Linear light.** Linearise the captured pixels, filter, then re-encode for display. Filtering gamma-encoded values makes the formulas above wrong.
2. **Floating-point state.** Hold S in a half-float texture. With 8-bit state and α = 0.05, any change smaller than 10 levels rounds to nothing and stale ghosts never clear.
3. **Always warm.** Run the filter every frame even when safe, at α = 0.25, with the overlay invisible. When a hazard fires, S already holds a sensible recent average to show.

### On fast, off slow

The overlay has four states. The rule that matters is that it must never switch on and off in time with the strobe, or the filter becomes the hazard.

| State | Overlay | Leaves when |
| --- | --- | --- |
| Safe | Invisible, filter warm at α = 0.25 | Detector raises a hazard |
| Active | Fully opaque within one frame. α and d from the formulas, re-evaluated each frame and only allowed to get stronger | No hazard for a continuous 1.5 s |
| Release | Opacity fades 1 to 0 over 0.75 s while α eases back to 0.25 and d to 1 | Fade completes, or a new hazard (back to Active at once) |
| Disabled | Hidden. User switched protection off, or the watchdog fired | User re-enables |

The 1.5 s hold is longer than the 1 s counting window, so the detector has fully cleared before the fade begins.

### What the viewer gives up

- **Motion trails while active.** At α = 0.05 moving objects leave about a third of a second of ghosting. Static content stays sharp.
- **A slightly late picture while active.** The copy lags the real screen by the pipeline latency. The cursor stays live because Windows draws it above the overlay. We request capture without the cursor, but Chromium ignores that, so a smeared ghost cursor can appear in the smoothed copy (Phase 0 results).
- **Protected video shows black.** DRM streams capture as black, so they can neither be detected nor shown smoothed.

### Stretch: smooth only the flashing region

Use the detector's hot mask, grown by two cells and blurred, as the overlay's opacity. Everything outside the mask stays live and sharp. Build it only after whole-screen smoothing is measured and working.

## Architecture

CalmFrame is one Electron app with three windows and one hot loop. All per-frame work lives in the overlay window's renderer, so no frame ever crosses a process boundary and adds latency.

&#91;embedded content: CalmFrame architecture · frame loop inside the overlay renderer, three supporting parts\]

Read it clockwise from the screen: frames go in, the smoothed copy comes back out on top. Because the overlay is excluded from capture, the detector always sees the real screen underneath.

### The pieces

| Piece | Runs in | Job |
| --- | --- | --- |
| Main process | Node | Creates windows and tray, grants screen capture to the overlay renderer, stores settings, relays messages, owns the kill switch and watchdog |
| Overlay window | Renderer | Captures the screen, runs the GPU passes and the detector, draws the smoothed copy. Transparent, click-through, always on top, excluded from capture |
| Dashboard window | Renderer | Hazard graph, raw thumbnail, event log, controls. Receives stats about 20 times a second |
| Detector core | Plain TypeScript, no Electron or DOM imports | Detection, filter-parameter math, overlay state machine. Shared by the app and the validator |
| Strobe test page | Static page in a normal browser | Calibration source and safe demo clip |
| Validator CLI | Node script | Decodes a video file, runs the detector core, compares with IRIS |

### The per-frame loop

1. A frame arrives from the screen capture stream. Record its capture timestamp.
2. Upload it to a GPU texture.
3. Pass A: linearise and area-average down to 96×54, then read those 5,184 values back to JavaScript.
4. Run the detector. It returns hazard, type, f̂, ΔL and the hot mask.
5. Step the state machine. It returns α, d and overlay opacity.
6. Pass B: update the smoothing state in a half-float texture.
7. Pass C: draw d · S, re-encoded for display, at the current opacity.
8. Every third frame, send stats and the 96×54 thumbnail to the dashboard.

### Overlay window requirements

These are the settings the plan depends on. Each is a documented Electron window option or method.

- Transparent, frameless, no shadow, hidden from the taskbar, not focusable.
- Always on top at the highest level, and ignoring all mouse events so clicks reach the app underneath.
- Sized to the primary display's bounds, minus 1 DIP at the bottom so Windows doesn't hide the taskbar. Apply the bounds again after showing, because Windows clamps new windows to the work area. Do not use the OS fullscreen mode.
- Content protection on. On Windows 10 version 2004 and later, [Electron documents](https://jetbrains.github.io/kotlin-wrappers/kotlin-electron/electron.core/-browser-window/set-content-protection.html) that this removes the window from capture entirely. This is what prevents the feedback loop.
- Background throttling off, hardware acceleration on.

### Capture requirements

- The main process picks the primary screen as the source and grants it through Electron's [display-media request handler](https://www.electronjs.org/docs/latest/api/desktop-capturer). The renderer then opens the stream.
- Request 60 fps, cap resolution at 960×540 (lowered from 1920×1080 in Phase 0 to hold 50 fps), no audio, and cursor excluded if the constraint is honoured. Chromium does not honour it.
- Use the video element's per-frame callback so each frame is processed once, with its timestamps.

### Safety mechanisms

- **Kill switch.** A global shortcut (Ctrl+Alt+Shift+C) moves to Disabled and hides the overlay at once.
- **Watchdog.** The overlay sends a heartbeat every 250 ms. If the main process misses it for 750 ms, it hides the overlay window. A frozen opaque overlay would otherwise block the whole screen.
- **Fails open, and says so.** Any failure shows the raw screen and flips the tray icon and dashboard to "Protection off". Never show "Protected" unless frames are flowing.

### Defaults, in one place

| Setting | Value |
| --- | --- |
| Analysis grid | 96×54 cells |
| Luminance threshold, dark limit | 0.10, 0.80 |
| Red threshold, red ratio | 20, 0.8 |
| Fast-transition interval | 167 ms |
| Counting window | 1.0 s |
| Trigger | Early, N = 3 |
| Area limit, window | 0.25 of a window one third of the grid each way |
| Target residual ρ | 0.08 |
| α range, warm α | 0.03 to 0.30, 0.25 |
| Minimum dim d | 0.4 |
| Hold, fade | 1.5 s, 0.75 s |
| Heartbeat, watchdog | 250 ms, 750 ms |
| Capture | 60 fps, max 960×540 (was 1920×1080; see Phase 0 results) |

### Stack and repo layout

Electron, TypeScript, Vite (the electron-vite template), WebGL2 for the GPU passes, Vitest for the core tests. The dashboard is plain TypeScript and canvas. Credit every one of these in the README, as the rules require.

```text
(repo root)
  CLAUDE.md            project rules for Claude Code
  README.md            what it is, how to run, credits, what we built vs used
  docs/SPEC.md         this document, exported as Markdown
  .claude/, .entire/   Claude Code settings and Entire session capture (hooks, skills)
  src/main/            windows, tray, capture grant, settings, kill switch, watchdog
  src/preload/         contextBridge API between main and the renderers (from the template)
  src/overlay/         capture, GPU pipeline, shaders, frame loop
  src/dashboard/       graph, thumbnail, log, controls
  src/core/            luminance, tracker, area, detector, filter math, state machine, tests
  src/shared/          message types, config defaults
  tools/strobe/        strobe test page
  tools/validate/      clip generator, validator CLI, IRIS comparison
  measurements/        slow-motion results, comparison tables
```

## Build plan

The first 90 minutes decide the design: Phase 0 proves or kills the overlay, while the detector and test page are built in parallel because they do not depend on it. By 1 AM Saturday you should have live detection on screen, which is already a demo.

### Who owns what

| Role | Owns | Friday night | Saturday |
| --- | --- | --- | --- |
| A | Capture and overlay | Phase 0 spike, then live capture and grid | Smoothing overlay, watchdog |
| B | Detector core | Detector, filter math, state machine, all with tests | Wire into overlay with A, then validator CLI |
| C | Interface | Strobe test page | Dashboard, control panel, tray |
| D | Proof and story | Repo, Devpost draft, IRIS install, test clips | Measurements, IRIS table, video, write-up, pitch |

With three people, split D between B and C. With two, pair A+B and C+D. Each role can run its own Claude Code session on its own branch, because the core has no Electron imports and the folders do not overlap.

### Phase 0: overlay spike (A, Friday 8:00 to 9:30 PM)

- [x] A transparent overlay with a 30% red tint covers the primary display, and clicks and typing reach the apps underneath.
- [x] A debug window showing the live capture has no red tint and no black rectangle where the overlay sits.
- [x] Capture delivers at least 50 fps on moving content, and the median capture-to-callback delay is logged. *Only with the demo-laptop setup and the 960×540 cap below.*
- [x] The overlay stays above a fullscreen YouTube video and a borderless-windowed game.
- [x] The kill switch hides it.

If the first two boxes are not ticked by 9:30 PM, stop and switch to the fallback in "Risks and fallbacks".

#### Phase 0 results (Fri Nov 13, measured on the Windows 11 demo laptop)

Boxes 1 and 2 passed by 9:00 PM, so the design stands and no fallback is needed. What we measured and changed:

- **Capture exclusion works.** The window's display affinity reads `0x11` (`WDA_EXCLUDEFROMCAPTURE`). An automatic self-check toggles the overlay's tint and compares the captured frame's red ratio. It changed by 0.000 ± 0.007 on every run, including with video and a game moving. The user confirmed by eye that the preview shows a clean desktop.
- **The capture frame rate is limited by screen pixels, not by our code.** Chromium copies the full native screen each frame and limits itself to a share of one CPU core, so frame rate falls with screen resolution and CPU clock. The capture size cap barely matters, because the shrink happens after the copy. We tested with a moving bar that changes every display frame:

  | Display | Power mode | Cap 1920×1080 | Cap 1280×720 | Cap 960×540 |
  | --- | --- | --- | --- | --- |
  | 2880×1800 | Silent | 24 | 23 | 26 |
  | 1920×1080 | Best performance | 48 | 42 | 46 |
  | 1920×1080 | Turbo | 42 | 45 | **54** |

  Runs vary by about ±5 fps. **Decision: capture cap 960×540** (mean 54 fps, range 44 to 59). Detection is unaffected because the grid is 96×54. The cost is that the smoothed copy shown during a hazard is softer. A native capture module (Windows Graphics Capture handing GPU textures to the renderer through Electron's experimental `sharedTexture` API) could reach 60 fps at full resolution. It is a stretch option for the Saturday 6 PM gate.
- **Demo-laptop setup this depends on:** display at 1920×1080 and 60 Hz, mains power, Turbo mode, discrete GPU off, and no other heavy apps. Not yet tested: the frame rate with Minecraft running at the same time.
- **Overlay size.** Windows clamped the new overlay to the work area (1440×852), which left the taskbar strip uncovered over fullscreen apps. Setting the bounds after show fixes that. But an overlay that exactly covers the monitor makes Windows treat it as a fullscreen app and hide the taskbar. The overlay therefore stops 1 DIP short of the bottom of the screen (`OVERLAY_BOTTOM_INSET`).
- **Chromium ignores `cursor: 'never'`.** It reports `cursor: always`, so the cursor is baked into captured frames, and the smoothed copy can show a smeared ghost cursor during a hazard.
- **The capture-to-callback delay is understated.** `captureTime` is present, but the median is about 1 ms, so Chromium apparently stamps it late. Use the slow-motion measurement for latency.
- **Chromium shrinks the frame before our shader sees it.** It averages gamma-encoded values. Patterns finer than 2 screen pixels therefore read darker than in true linear light: a 1-pixel checkerboard reads about Y = 0.22, not 0.5. Inverting patterns still cancel, so the fine-pattern exemption holds. The Step 2 acceptance test runs on a generated texture, so it still tests our shader correctly.
- **Dashboard stacking.** A window can sit above the overlay and be excluded from capture (tested with the debug window). That fixes the dashboard-under-overlay problem noted in CLAUDE.md once the team agrees.
- **Chromium shares one capture device per screen.** The first stream opened sets the format for every stream. A debug preview opened first at 480×270 and 15 fps dragged the overlay's capture down to the same. Any second capture, including the dashboard in Phase 5, must request exactly the overlay's settings, or better, use data the overlay sends (as the raw thumbnail already does).

### Phase 1: detector core (B, Friday 8:00 to 11:00 PM)

- [x] Tests on synthetic grids pass: 2 Hz full-screen strobe is safe, 10 Hz is a hazard, a single cut is safe.
- [x] Early mode fires on exactly the third fast transition.
- [x] Area rule: a 10 Hz strobe filling 20% of a window is safe and 30% is a hazard.
- [x] Contrast rules: a swing of 0.05 is safe, and a flash between two states both above 0.80 is safe.
- [x] A red and black strobe raises a red hazard. A slow 2-second fade loop is safe.
- [x] The α solver reproduces the table in "Mitigation math", and the residual formula matches a simulated filter.
- [x] State machine: on within one frame, 1.5 s hold, fade, and an immediate return to Active if a hazard arrives mid-fade.

#### Phase 1 results (Fri Nov 13, built and tested on the Windows laptop)

All seven boxes pass, with 116 tests in `src/core`. The end-to-end check under "Check the filter against the detector" passes as written. What Phase 3 needs to know, and the spec readings the code settles:

- **Interface.** `new Detector(options).step(grid, tMs)` takes linear RGB per cell (`inputChannels: 4` accepts an RGBA GPU read-back as-is) and returns one result object, reused every frame. `new OverlayStateMachine().step(tMs, detection, captureFps)` returns α, d, opacity and the red flag. Neither allocates per frame.
- **Cost.** A detector step takes under 1 ms, measured in Vitest on the demo laptop: about 0.9 ms on a 10 Hz full-screen strobe, and 0.2 to 0.5 ms on a static screen. The Phase 3 budget is 4 ms. Hot loops copy imported constants to locals, because some module loaders turn each read of an import into a property lookup. That alone took the tracker from 0.62 to 0.16 ms per frame.
- **Readings of the spec.** Step 4 rule 5 and Step 5 now state the first three.
  - A reversal that fails the dark limit, or the saturated-red test, is ignored, not half-counted.
  - Swing grows with a ramped flash, so ΔL reports the full flash.
  - The first transition of a run counts as streak 1. The count window is open at its old end.
  - Luminance needs a change of at least 0.10 and red a change of more than 20, following WCAG's own wording.
  - The calibrated window applies the 10° field's share of the screen width in both directions, the way the WCAG window is one third in both.
  - The red tracker remembers the red ratio of each extremum, so "ρ ≥ 0.8 in at least one of the two states" is checked against the state the reversal started from.
  - For a red-only hazard, f̂ comes from the red intervals and ΔL from the luminance swing of the same cells (often near 0). Smoothing is then light and the 50% desaturation does the work.
  - The graph value is computed separately for luminance and red, and the larger is reported.
  - Median and 90th percentile use nearest rank.
  - The IRIS extended-failure option counts frames whose area count is 4 to 6, from capture timestamps, and fails at 4 s within any 5 s. A sustained 2 Hz strobe fails at about 4.75 s, matching IRIS's "warning, then extended failure after 4 s".
- **State machine details.** The fade is timed from the moment the hold ran out, not from the next frame. A hazard mid-fade returns to Active with the stronger of the eased and the required α and d. A hazard with no usable frequency gets the strongest setting (α 0.03, d 0.4).
- **Finding for Phase 4.** At 3 to 5 Hz, α clamps at 0.03, so the smoothed copy needs over a second to settle when it starts far from the average (a time constant of about 0.55 s). The detector can see that slow drift as one isolated transition, but never two within a second, so it never forms a flash.
- **Spec fix.** The residual table's α = 0.10, 15 Hz cell is 0.105, so 0.10 to two decimals, not 0.11.

### Phase 2: strobe test page (C, Friday 8:00 to 9:30 PM)

- [ ] Controls for frequency (1 to 30 Hz, snapped to what the display can show), the two grey levels, area as a share of the window, colour mode (grey or red and black) and burst length.
- [ ] A frame counter and millisecond timestamp are drawn on screen for the slow-motion footage.
- [ ] It starts paused behind a warning, Esc stops it, it auto-stops after 5 s, and it defaults to low contrast (a 0.2 swing between two greys).

### Phase 3: live detection (A and B, Friday 9:30 PM to Saturday 1:00 AM)

- [ ] Capture, grid and detector run in the overlay renderer, and the checkerboard test reads 0.5.
- [ ] A graph shows flashes per second. The test page at 2 Hz stays under the line and at 10 Hz goes over it.
- [ ] Hazard start and end are logged with timestamps.
- [ ] Analysis costs under 4 ms per frame.

### Phase 4: smoothing overlay (A, Saturday 9:00 AM to 1:00 PM)

- [ ] A hazard makes the overlay opaque within one frame, showing the smoothed copy. It releases after the hold and fade.
- [ ] On the 10 Hz test strobe the screen looks like steady grey, while the detector still reports the hazard underneath.
- [ ] The overlay never toggles during a continuous strobe.
- [ ] The watchdog hides a deliberately frozen overlay.

### Phase 5: dashboard and controls (C, Saturday 9:00 AM to 3:00 PM)

- [ ] Scrolling graph with the limit line at 3 flashes per second.
- [ ] Status that reads Protected, Smoothing, or Protection off, and is never wrong.
- [ ] Raw-input thumbnail no larger than 240×135, clearly labelled. At that size it is under the area limit on a 1080p screen by design.
- [ ] Event log lines such as "0:42, 8 Hz, 2.1 s, smoothed".
- [ ] Sensitivity slider, on/off switch, events-mitigated counter, tray icon with a menu.
- [ ] A warning when capture drops below 45 fps.

### Phase 6: measure and validate (D, Saturday 1:00 to 6:00 PM)

- [ ] Slow-motion counts at 5, 10 and 15 Hz, protection off and on.
- [ ] IRIS comparison table over the clip set.
- [ ] Latency median and 95th percentile from the app's own log.

### Gate: Saturday 6:00 PM

If every box above is ticked, pick one stretch: regional smoothing (the visual win) or the Typesense hazard index (an extra prize). If any box is open, spend the evening closing it and polishing instead.

### Phase 7: freeze and ship (everyone, Saturday 9:00 PM onward)

- [ ] Feature freeze at 9:00 PM. Bug fixes only after that.
- [ ] Video recorded and cut to 2 minutes, uploaded to YouTube as unlisted.
- [ ] Devpost write-up and README finished.
- [ ] Table demo rehearsed twice against a timer.
- [ ] Fresh install tested on the demo laptop after a reboot.

### Fixed points in the weekend

These times come from the opening slides you shared earlier. Check them against the live schedule.

| When | What | Do |
| --- | --- | --- |
| Fri 8:00 PM | Hacking starts | Create the repo, paste the kickoff prompt |
| Fri 9:30 PM | Typesense workshop | Send one person only if the hazard index is a likely stretch |
| Sat 10:00 AM | Coder workshop | Ask whether Coder for Good requires using Coder's product |
| Sat 12:00 PM | Devpost draft due | Team, repo, name, track set to Entertainment |
| Sat 1:00 PM | De Ronne Floyd talk | One person attends |
| Sat 4:30 PM | MLH workshop | Ask which MLH prizes are running |
| Sun 8:00 AM | Submission due | Devpost plus the 2-minute video |
| Sun 8:15 AM | Judging expo | Table demo |
| Sun 10:15 AM | Finalist demos | Three slides ready |

## Validation and measurement

Two measured numbers carry the pitch: how many flashes reach the eye, and how often CalmFrame's detector agrees with EA's analyzer. Both come from one small set of test clips.

### Test clips

Generate these as 10-second 1080p60 files with a 3-second steady lead-in, so the ground truth is known by construction.

| Clip | Expected, WCAG area mode | IRIS result |
| --- | --- | --- |
| 2 Hz full-screen black and white | Safe | Warning, then extended failure after 4 s |
| 3.75 Hz full-screen | Hazard | Fail |
| 10 Hz full-screen | Hazard | Fail |
| 15 Hz full-screen | Hazard | Fail |
| 10 Hz, swing 0.05 | Safe | Pass |
| 10 Hz, swing 0.2 between two greys | Hazard | Fail |
| 10 Hz in a patch covering 15% of the frame | Hazard | Pass |
| 10 Hz in a patch covering 30% of the frame | Hazard | Fail |
| 10 Hz red and black | Red hazard | Red fail and luminance fail |
| Hard cuts every 2 s | Safe | Pass |
| Slow fade, one cycle per 2 s | Safe | Pass |

The IRIS column is measured, not predicted. I generated all eleven clips and ran the IRIS port on them while writing this.

The 2 Hz row shows a rule IRIS has and WCAG does not: 4 to 6 transitions per second sustained for 4 seconds is an extended failure. Give the validator an optional switch for that rule so the comparison is like for like. The live app does not need it.

The 15% patch is the interesting row. It fills a whole 10° window, so WCAG's rule flags it, but it is under a quarter of the frame, so IRIS passes it. Use it to explain why you implement both.

Add three to five real clips: a music video with strobes, game footage, and an ordinary talking-head clip as a negative. Note where each came from.

### Comparison with IRIS

1. Install the port: `pip install iris-pse-detection`. It provides an `iris` command that takes a video path and writes per-frame results.
2. Run `iris` on every clip. Each frame gets a luminance result and a red result: 0 pass, 1 warning, 2 extended failure, 3 failure.
3. Run CalmFrame's validator on the same files in IRIS-compatible area mode with the strict trigger.
4. Reduce both to one verdict per second. A second fails if any frame in it fails.
5. Report a two-by-two table (both fail, both pass, only IRIS, only CalmFrame) and the percentage agreement. Then repeat in WCAG area mode and explain the differences.

Two honesty notes for the write-up. The pip package is a community Python port of EA's IRIS, so write "compared against IRIS (Python port)". And IRIS's own README says it does not certify compliance, so never say "validated by EA" or "certified".

### Slow-motion measurement

This is the end-to-end truth, because it includes the compositor and the display, which the app cannot see.

1. Demo laptop in its Phase 0 setup (1920×1080 at 60 Hz, mains power, Turbo, discrete GPU off), brightness fixed, HDR off, room lights low.
2. Phone on a stand at 240 fps, framing the screen centre and the test page's frame counter.
3. Use full contrast for this measurement only. The operator starts the burst and looks away while the phone records.
4. For each of 5, 10 and 15 Hz, record three bursts with protection off and three with it on.
5. Step through the footage. Count bright phases visible before the screen goes steady. Report the median of three and the range.
6. Response time is the number of footage frames from the first visible change to the first smoothed frame, times 4.17 ms.

### The app's own latency log

Log capture timestamp, callback time and draw time for every frame, and show the median and 95th percentile over a minute. It understates the true delay, so quote the slow-motion figure in the pitch and keep this one for the technical question.

### Check the filter against the detector

Run the detector on the filter's own output. In the core tests, a 10 Hz full-contrast strobe passed through the reference filter with the solved α and d must produce zero transitions after half a second. That one test proves the smoothed picture is under the threshold by the same rule that flagged the original.

### The four numbers for your slide

- Flashes reaching the viewer on a 10 Hz strobe, protection on, against protection off.
- Response time in milliseconds.
- Per-second agreement with IRIS across N clips.
- Residual swing after smoothing, against the 0.10 threshold.

## Demo, pitch and submission

The demo's job is to make an invisible product visible: the screen stays calm while the graph and the thumbnail prove something dangerous was underneath. Protection stays on for the whole demo.

### One gotcha to plan around

Screen recorders cannot see the overlay, because it is excluded from capture by design. A screen recording of CalmFrame working shows the raw strobe. For the video, film the laptop with a phone, and use the dashboard's protected-preview pane for any on-screen footage.

### Table demo, about 90 seconds

1. Ask first: "Is anyone here sensitive to flashing lights?" If yes, show only the dashboard and the slow-motion comparison.
2. Dashboard open, status Protected, graph flat.
3. Play a video with strobing. The screen stays steady, the graph crosses the limit line, the thumbnail shows what was underneath, a log line appears.
4. Switch to a game in borderless-windowed mode. Same result, so it is not a video trick.
5. Move the sensitivity slider and show the trade-off.
6. Show the slow-motion side-by-side and the four numbers.

Never switch protection off with a strobe on screen, for a judge or anyone else.

### The 2-minute video

| Time | Content |
| --- | --- |
| 0:00 to 0:15 | Hook. 685 children in hospital after one cartoon in 1997. Warnings put the burden on the viewer. |
| 0:15 to 0:30 | The gap. Apple's protection covers Apple devices and supported video. The analysis tools work offline. Nothing protects a Windows user live. |
| 0:30 to 1:15 | Live demo, filmed by phone, with the dashboard visible. |
| 1:15 to 1:40 | How. The published standard on the GPU, no AI, so it is deterministic and works offline. The measured numbers. |
| 1:40 to 2:00 | Limits stated plainly, what is next, and the non-profit you would name for the Coder for Good donation. |

Run the finished video file through IRIS before uploading. Keep any raw strobe footage small in frame, and put a flashing-content warning at the start and in the description. "We ran our own demo video through the analyzer" is a line judges remember.

### Answers to have ready

| Question | Answer |
| --- | --- |
| Why does any flash get through? | One reversal looks identical to a scene cut. Apple's own paper says its first few flashes pass unmitigated. Ours is a measured X. |
| Does it work on Netflix? | No. Protected video captures as black for every capture-based tool. |
| Is this a medical device? | No. It reduces exposure to flashes that break a published accessibility threshold. It does not guarantee anything. |
| Why no AI? | The hazard is defined by a standard. A deterministic check is auditable, has no model to be wrong, and runs offline. |
| What about false positives? | Early mode will sometimes smooth lightning or gunfire. Smoothing leaves static content untouched, so a false positive costs a second of motion blur. |
| Why the Entertainment track? | Games and video are what it protects. The track asks for entertainment to be made more accessible. |

### Words to avoid

Do not say "prevents seizures", "certified", "WCAG compliant" or "validated by EA". Say "reduces exposure", "implements the WCAG flash thresholds" and "compared against IRIS".

### Submission checklist

- [ ] Devpost: Entertainment track, Coder for Good, and Typesense only if you actually used it.
- [ ] Video on YouTube, 2 minutes or under, unlisted is fine, with the warning.
- [ ] README: what it is, how to run it, how it works, measurements, limitations, credits for every framework and tool, and a clear line between what you built and what you used.
- [ ] Repo public, with the measurements folder included.
- [ ] Three slides for the finalist round: the problem, the live demo, the measured numbers.

## Claude Code prompts

Give Claude Code this document as a file in the repo, then one short prompt per phase. A spec it can re-read beats one giant pasted prompt, because it stays available after the context fills up.

### At 8:00 PM, before any prompt

1. Create an empty folder named calmframe and run git init in it.
2. Export this doc as Markdown and save it as docs/SPEC.md in that folder.
3. Start Claude Code in the folder and paste prompt 1.
4. Once prompt 1 is committed and pushed, A, B, C and D each start their own session on their own branch with their own prompt.

### Prompt 1: kickoff (one person, once)

```text
You are helping a team build CalmFrame during a 36-hour hackathon. Read docs/SPEC.md in full before doing anything. It is the source of truth for the math, the architecture, the default values and the acceptance criteria.

Do only this now:
1. Scaffold an Electron + TypeScript + Vite project (the electron-vite template) in this folder, using the layout under "Stack and repo layout" in the spec. Add Vitest. Windows is the only target OS.
2. Create src/shared/config.ts holding every value from the spec's "Defaults, in one place" table as named, typed constants. No other file may hard-code those numbers.
3. Write CLAUDE.md containing the working rules below.
4. Write a README.md skeleton with these sections: What it is, How to run, How it works, Measurements, Limitations, Credits, What we built vs what we used. List every framework and tool under Credits.
5. Make the dev command open an empty window and the test command run one trivial passing test. Commit.

Working rules for CLAUDE.md:
- docs/SPEC.md is the source of truth. If the code must deviate, say so and update the spec in the same commit.
- src/core is pure TypeScript with no Electron, DOM or Node imports. Everything in it has unit tests.
- All per-frame work stays in the overlay renderer. Never send frames over IPC.
- Timing logic uses capture timestamps, never frame counts.
- Fail open: on any error, hide the overlay and report "Protection off".
- Safety: never auto-play a strobe. Test content starts paused, low contrast and small, with an auto-stop.
- Check Electron and WebGL API details against the current official documentation before relying on them. Do not guess option names.
- Small commits that each leave the tests green. Do not add a dependency without saying why.
- Build only what the current phase's checklist asks for.

Stop after the commit and tell me what you created.
```

### Prompt 2: overlay spike (role A)

```text
Read docs/SPEC.md. We are doing "Phase 0: overlay spike" from the build plan. The goal is to prove the overlay can exist without seeing itself. Spike quality is fine. Speed matters more than polish.

Build:
- Main process: find the primary display and create the overlay window exactly as listed under "Overlay window requirements", with a 30% red tint as its only content and content protection enabled.
- Capture: grant the primary screen through the display-media request handler, and open the stream in the overlay renderer as listed under "Capture requirements".
- A second, ordinary debug window that shows the live captured video at small size, plus capture frames per second over a rolling second, the median and 95th percentile capture-to-callback delay, and the frame resolution.
- A global shortcut, Ctrl+Alt+Shift+C, that toggles the overlay.

Then walk me through each Phase 0 checkbox by hand, one at a time, and wait for my answer on each. Ask me specifically whether the debug window shows (a) the red tint, (b) a black rectangle, or (c) the clean desktop.

If I answer (a) or (b), do not move on. Check that this Windows build supports capture exclusion, check that content protection is applied after the window is shown, try the other supported way of opening a desktop stream, and report what you find.
```

### Prompt 3: detector core (role B)

```text
Read docs/SPEC.md. Implement src/core exactly as specified under "Detection math" and "Mitigation math". Pure TypeScript, no Electron, DOM or Node imports. Use typed arrays for per-cell state and allocate nothing per frame in the hot path. Take every constant from src/shared/config.ts.

Modules:
- luminance: sRGB-to-linear lookup table, relative luminance, red ratio and red value (Steps 1 and 3).
- tracker: the per-cell extremum tracker with timestamps, count and streak (Steps 4 and 5), for both luminance and red.
- area: summed-area table and the three window modes (Step 6).
- detector: one step function that takes a Float32Array of linear RGB per cell and a timestamp in milliseconds, and returns the Step 8 outputs. Supports early and strict triggers, N from config, and an optional extended-failure rule for the validator.
- filterMath: the residual formula, the alpha solver with clamping, and the dim factor.
- stateMachine: Safe, Active, Release and Disabled as described under "On fast, off slow", returning alpha, d and opacity for each frame.
- referenceFilter: a CPU version of the smoothing filter that works on a grid, for tests only.

Tests: write a helper that generates synthetic grid sequences at 60 fps by frequency, the two luminance levels, area and colour. Then implement every checkbox under "Phase 1: detector core". Also assert the residual table in "How much flicker survives" to two decimals, and add the end-to-end test described under "Check the filter against the detector".

Where the spec is ambiguous, stop and ask instead of guessing.
```

### Prompt 4: strobe test page (role C)

```text
Read docs/SPEC.md. Build tools/strobe as one static HTML page with no build step and no dependencies, meeting every checkbox under "Phase 2: strobe test page".

- Drive the flash from requestAnimationFrame with frame counting, so each phase lasts a whole number of display frames. Show the frequency actually achieved.
- A flashing rectangle centred on a neutral grey page. Controls for frequency, the two grey levels (display their relative luminance), area as a share of the window, colour mode (grey, or red and black) and burst length.
- A large frame counter and millisecond clock, readable in phone slow-motion footage.
- A 2-second steady grey lead-in before each burst.
- Safety: the page loads paused behind a full-page warning that must be clicked through. Defaults are a 0.2 luminance swing, 25% area and a 3-second burst. Esc or any click stops it. Hard stop at 5 seconds. Full contrast is a separate toggle that is off by default.
```

### Prompt 5: live detection (roles A and B, after prompts 2 and 3 are merged)

```text
Read docs/SPEC.md. We are doing "Phase 3: live detection". Wire capture, the GPU grid and the detector together in the overlay renderer. Put the Phase 0 red tint behind a debug flag.

- WebGL2 pipeline, Pass A from "The per-frame loop": upload the video frame, linearise in the shader, area-average to the 96x54 grid, read back. The downsample must be a true area average (a mip chain or a multi-tap box filter), not one bilinear tap. Prove it with the checkerboard acceptance test from Step 2 on a generated texture, and show me the number.
- Drive the loop from the video element's per-frame callback and pass each frame's capture timestamp to the detector.
- Extend the debug window: a scrolling graph of the detector's graph value with a line at 3, the current state, estimated frequency, flash size, largest area fraction, analysis time per frame (median and 95th percentile), and a log of hazard start and end times.
- Send stats to the debug window at most every third frame. Never send frames.

Then have me run the strobe page at 2 Hz and 10 Hz, at low contrast, and confirm each Phase 3 checkbox.
```

### Prompt 6: smoothing overlay (role A)

```text
Read docs/SPEC.md. We are doing "Phase 4: smoothing overlay". Implement mitigation exactly as specified under "Mitigation math".

- Pass B: two half-float render targets at capture resolution, used alternately, holding the linear smoothed state. Update with alpha from the state machine on every frame, including the warm alpha when safe.
- Pass C: draw d times the state, re-encoded for display, to the overlay canvas at the state machine's opacity. Apply the red desaturation when the hazard type is red. At opacity 0 the overlay must be fully transparent.
- Check for float render-target support at startup. If it is missing, fail open with a clear message.
- Heartbeat to the main process every 250 ms. A main-process watchdog hides the overlay after 750 ms of silence and sets the state to Disabled. Add a hidden debug command that freezes the renderer so I can test it.
- Log alpha, d and state on every state change.

Then have me verify each Phase 4 checkbox with the strobe page, starting at low contrast.
```

### Prompt 7: dashboard and tray (role C)

```text
Read docs/SPEC.md. We are doing "Phase 5: dashboard and controls". Replace the debug window with the real dashboard and add the tray icon. Plain TypeScript and canvas, no UI framework.

- Everything listed under Phase 5, plus a small "protected preview" pane showing the smoothed output, because screen recorders cannot see the overlay.
- The raw thumbnail is drawn from the 96x54 grid, capped at 240x135, and labelled "Raw input (unprotected)".
- Design goals: calm, legible at arm's length on a demo table, one large status indicator, high-contrast text, fully usable from the keyboard, no animation beyond the graph.
- The status must be derived from the heartbeat, never from a stored flag.
- Settings persist across restarts.
```

### Prompt 8: validator (roles B and D)

```text
Read docs/SPEC.md. Build tools/validate as described under "Validation and measurement".

1. make-clips: generate the synthetic clip set from the "Test clips" table as 1080p60 MP4 files using ffmpeg, plus a JSON manifest of the expected result for each clip in each area mode. Remember that a 60 fps file can only hold strobes at 30/n Hz.
2. validate: decode a video file to frames with ffmpeg, area-average each frame in linear light to the 96x54 grid on the CPU, run the detector with each frame's presentation time, and write one CSV row per second: largest graph value, hazard yes or no, and type. Area mode, trigger mode and the extended-failure rule are command-line options.
3. compare-iris: read the per-frame CSV written by the iris command from the Python package iris-pse-detection, and our CSV. Reduce both to pass or fail per second. Print a two-by-two agreement table and the disagreeing seconds per clip. Save the output under measurements/.

Run it on the synthetic set first. Show me every clip where we disagree with the manifest or with IRIS, with your explanation of why.
```

### Stretch prompts, only after the Saturday 6 PM gate

```text
Regional smoothing. Read "Stretch: smooth only the flashing region" in docs/SPEC.md. Upload the detector's hot mask as a 96x54 texture each frame, grow it by two cells, blur it, and use it as per-pixel overlay opacity in Pass C. Outside the mask the overlay must be fully transparent. Add a test strobe covering one corner and have me confirm the rest of the screen stays live and sharp.
```

```text
Hazard index with Typesense. When a hazard ends, record an event: the active window's title, start time, duration, peak frequency and type. Index events in Typesense and add a search box to the dashboard that answers "has this title flashed before, and how badly". Be honest in the UI about the limit: an overlay cannot read a video's playback position, so this is a lookup and a warning before you press play, not look-ahead dimming.
```

### Three habits that save hours

- Start a fresh Claude Code session per phase and begin it with "Read docs/SPEC.md". Long sessions drift.
- When something looks wrong on screen, paste the numbers from the debug window, not a description.
- If Claude Code proposes a design the spec does not contain, ask it to justify the change against the acceptance criteria before accepting it.

## Risks and fallbacks

The one risk that can change the design is the overlay showing up in its own capture, and Phase 0 settles it in the first 90 minutes. Everything else has a cheap workaround.

| Risk | How you will know | What to do |
| --- | --- | --- |
| Overlay appears in the capture, or leaves a black rectangle | Phase 0, second checkbox | Drop smoothing. Hold a constant whole-screen contrast reduction during the hazard through the Windows Magnification API's full-screen colour effect, called from a small native binding. Detection is unchanged. I have not verified this API here, so have Claude Code check Microsoft's docs first |
| Capture is slow | Under 45 fps, or delay over 120 ms in the debug window | **Happened in Phase 0** (24 fps at 2880×1800). Fixed with display 1920×1080, Turbo, mains and a 960×540 cap (54 fps). If it regresses, close other heavy apps and check the power mode. A native capture helper is a last resort |
| Overlay does not stay above a fullscreen game | Phase 0, fourth checkbox | Demo games in borderless-windowed mode and list exclusive fullscreen as a limitation |
| Overlay freezes while opaque | Screen stops updating | Watchdog hides it after 750 ms. Kill switch as backup. Test both before the demo |
| Float render targets missing | Startup check fails | Unlikely on a recent laptop. Fall back to 8-bit state with α no lower than 0.10 and lean on dimming |
| False positive mid-demo | Smoothing on ordinary content | Rehearse with the exact clips. Move the slider to N = 4 for the demo if needed |
| Demo laptop quirks | Colours or sizes look wrong | HDR off, one display only, test after a reboot, same power mode as rehearsal |
| Someone nearby is photosensitive | Ask before every demo | Dashboard and slow-motion comparison only. No strobe on the main screen |
| Coder for Good requires Coder's product | Answer at the Saturday 10 AM workshop | Develop and test the detector core in a Coder workspace. It has no GUI dependencies, so that is honest use |
| Scope creep | A phase checkbox still open at the Saturday 6 PM gate | No stretch work. Close the box, then polish |
| The Mac question comes up anyway | A teammate only has a Mac | They take role B, C or D. Core, test page, dashboard and validator all develop fine on a Mac. Only the overlay needs Windows |

## Sources

- [Understanding WCAG Success Criterion 2.3.1: Three Flashes or Below Threshold](https://w3c.github.io/wcag21/understanding/three-flashes-or-below-threshold.html), W3C. Flash definitions, the area rule, the red-flash working definition.
- [Photic- and pattern-induced seizures: expert consensus of the Epilepsy Foundation of America Working Group](https://research.aston.ac.uk/en/publications/photic-and-pattern-induced-seizures-expert-consensus-of-the-epile/), Harding et al., Epilepsia 2005.
- [Photic- and pattern-induced seizures: a review for the Epilepsy Foundation of America Working Group](https://research.aston.ac.uk/en/publications/photic-and-pattern-induced-seizures-a-review-for-the-epilepsy-fou/), Fisher et al., Epilepsia 2005. Prevalence and the Pokémon figures.
- [Visually sensitive seizures: an updated review by the Epilepsy Foundation](https://repository.essex.ac.uk/34275/), Fisher et al., Epilepsia 2022.
- [Video Flashing Reduction: Background and Algorithm](https://developer.apple.com/accessibility/downloads/Video-Flashing-Reduction-12.pdf), Apple, March 2023. Reference code at [apple/VideoFlashingReduction](https://github.com/apple/VideoFlashingReduction).
- [IRIS](https://github.com/electronicarts/IRIS), Electronic Arts. README for outputs and result codes.
- [iris-pse-detection](https://pypi.org/project/iris-pse-detection/1.1.2/), the Python port. I installed it, read its default configuration, and ran it on the eleven synthetic clips.
- [Electron: setContentProtection](https://jetbrains.github.io/kotlin-wrappers/kotlin-electron/electron.core/-browser-window/set-content-protection.html) (API text as mirrored in the Kotlin wrappers) and [Electron: desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer).
- [Apple Developer Forums: window sharing state and ScreenCaptureKit on macOS 15.4+](https://developer.apple.com/forums/thread/792152).

The equations in "Mitigation math", the trigger design and the flashes-through formula are my own derivations from those definitions. I ran the arithmetic in code and prototyped the detection rules against the ten luminance test clips, where they gave the expected result every time. None of it has been tested on a live screen yet. Your Phase 6 measurements are what make the numbers real.
