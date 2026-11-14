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

### Step 5a: only concurrent, one-way reversals count

Added Sat Nov 14, after Phase 4 testing. Steps 4 and 5 alone treat movement as flashing. When a page scrolls or a window is dragged, light and dark content passes over each cell, so the cell reverses again and again although nothing on screen flashes. On the demo laptop this switched the overlay on for ordinary scrolling (see "Movement false triggers" under Phase 4).

WCAG's area rule is about flashes "occurring concurrently". A strobe makes a whole region brighter in one frame and darker in a later one. Movement makes cells reverse one after another, and in any single frame some cells get brighter while their neighbours get darker. So, each frame, between Step 4 and the bookkeeping of Step 5:

1. Collect the cells that reversed on this frame, split into rising and falling.
2. A rising reversal counts as a transition only if some position of the area window (Step 6) that contains the cell holds rising cells over at least 25% of the window, and falling cells numbering at most a quarter of the rising ones. Falling reversals are the mirror image.
3. A reversal that does not count still moves the cell's direction and extremum (Step 4) and keeps the cell out of idle. It adds nothing to t\_last, the count or the streak, so it reaches neither trigger and not the graph.
4. Luminance and red are judged separately.

The rule is a detector option, `concurrency`, with two values. `one-way` is the default. `off` counts every reversal, which is the detector exactly as first specified, kept as the fallback. The debug window has a checkbox that switches between them while the app runs.

What the rule gives up, each pinned by a test in `src/core/motion.test.ts`:

- **Inverting patterns are no longer caught.** A checkerboard of 60 px squares that swaps black and white has half its cells going each way, so neither direction is one-way. Fine patterns were already exempt (Step 2). Coarse ones count as a flash under WCAG, so this is a real loss, accepted because such content is rare and movement is constant. Halves of the screen flashing in turn are still caught, because each half fills windows of its own.
- **A small flash on a fast-scrolling page can be caught one transition late**, about 50 ms at 10 Hz, because the scrolling around it reverses cells both ways inside the same window.
- **Very fast scrolling still counts.** Once a single edge sweeps a quarter of a window in one captured frame (about 5,400 px/s at 60 fps, 3,600 px/s at 40 fps), its reversals are concurrent and one-way by any definition.
- **Repaints are not movement.** A tab switch or page load that repaints a window three times in a row reverses every cell together, exactly like the start of a strobe. The rule does nothing for these. The trigger count N is the only control (Step 7).

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

### Step 7a: pre-arm (optional, off by default)

The early trigger fires on the third fast reversal, so the first two reach the viewer at
full contrast. Pre-arm is an optional state ahead of the trigger that starts smoothing on
the **first** reversal, before the detector knows whether a strobe is coming.

A cell is **armed** when its streak s ≥ 1, that is when it recorded a luminance transition
within the fast-transition interval. This is the early trigger with N = 1, so arming
inherits the dark-limit rule of Step 4 and the 250 ms frame-gap streak reset. The armed
mask then goes through the same area rule as the trigger: pre-arm raises **arm** when armed
cells fill at least 25% of some window. Luminance only; a red-only flash still waits for
the trigger.

| From | To | When |
| --- | --- | --- |
| Safe | Armed | arm is raised, and arm has been absent for the re-arm quiet period (1.0 s) |
| Armed | Active | The trigger fires. The ordinary hazard path, with N unchanged |
| Armed | Disarming | arm clears, or the armed cap (1.0 s) is reached |
| Disarming | Safe | The pre-arm fade (0.3 s) completes. Only a hazard interrupts it, never arm |

There is no separate hold. The arm signal already carries one: when it clears, no fast
transition has arrived for 167 ms and the streak is dead, so the fade starts at once.

The armed cap and the quiet period together bound how much of the time pre-arm can soften
the screen. Continuously flashing content below the trigger gets **one** episode of at most
1.3 s at its leading edge and nothing after that, because arm never goes quiet for long
enough to re-arm. Content that flashes in bursts a second or more apart gets one episode
per burst, which is the point of the feature.

**N stays at 3 for full protection.** Two quick opposing transitions are locally
indistinguishable from the start of a strobe: same direction, same interval, same swing. An
explosion, a muzzle flash and the first two frames of a 10 Hz strobe all look alike, which
is why Step 7 counts to three. Pre-arm changes when mitigation *starts*, not when the
detector *decides*.

#### What pre-arm does and does not buy

It does not move the flash count of Step 7. With trigger count N, strobe frequency f and
pipeline latency L, the viewer still sees

```latex
F \approx \frac{N - 1}{2} + f \cdot L
```

flashes before Active lands, because Active still waits for the third reversal. What changes
is the amplitude of those F flashes, and only of some of them:

- The **f · L** part is pipeline latency and pre-arm cannot touch it. Nothing can be on
  screen until a frame has been captured, analysed and drawn, so the opening flash reaches
  the viewer at full contrast whatever the detector does. At 10 Hz with L = 75 ms that is
  0.75 of a flash.
- The **(N − 1) / 2** part is the one pre-arm attenuates. Those flashes arrive while the
  overlay is already showing a lightly smoothed copy at α = 0.15, which leaves 0.24 of a
  full-contrast 10 Hz swing. That is still a flash by the standard, well above 0.10; it is
  about a quarter of the exposure, not an exemption. At 10 Hz with N = 3 that is 1 flash of
  the 1.75.

So pre-arm reduces the intensity of the flashes before Active lands. It does not remove
them, and it does not shorten L. Say it that way in the pitch: the first flash still gets
through, as it does in Apple's implementation, and CalmFrame makes it a quarter as strong.

#### Why it is off by default

Arming on a single reversal means arming on things that are not hazards at all. A scene
cut, alt-tab to a white page, a window closing onto the desktop: each is one large
transition over most of the screen, so each arms pre-arm and softens the screen for about
half a second. That is a visible cost paid on ordinary use for a benefit that only appears
when a strobe follows.

It therefore belongs at the **most sensitive position of the Phase 5 sensitivity slider**,
past N = 2, rather than as a toggle of its own. The slider already runs from the most
sensitive trigger to the strictest; pre-arm is simply one step further in that direction,
and a user who has been hurt by flashing can choose it knowing what it costs. Build no UI
for it before the slider exists.

#### What the detector adds

Two outputs alongside Step 8, both inert unless the option is on:

- **arm** (boolean): armed cells fill at least the area limit of some window.
- **arm area fraction**: the largest armed fraction of any window, for the dashboard.

A hazard implies arm, since s ≥ 3 implies s ≥ 1, so pre-arm can never delay protection: by
the time the trigger fires the detector is already armed. The extra area pass costs one
summed-area build and one window sweep, and runs only when the option is on.

The overlay state machine reports the requested smoothing as its own pair of values,
separate from the α, d and opacity that Active and Release drive, so a renderer that
ignores them behaves exactly as it did before pre-arm existed.

### Step 8: what the detector hands to the filter

- **hazard** (boolean) and **type** (luminance or red).
- **f̂**, the flash frequency: 1 / (2 × median interval between transitions) over hot cells.
- **ΔL**, the flash size: 90th percentile of swing over hot cells.
- **hot mask**, for regional smoothing later.
- **graph value**: the largest k such that cells with count ≥ k fill 25% of some window, divided by 2. This is "flashes per second over a hazardous area", plotted against the limit line at 3.

### Known behaviour at the edges

- **Scene cuts** produce one transition and never trigger. A cut to white and back produces two and does not trigger at N = 3.
- **Lightning or gunfire** with two quick double-flashes can trigger early mode. That is the accepted false positive of a safety default.
- **Scrolling and dragging** make cells reverse, but one after another and both ways at once, so Step 5a does not count them. A window repainted three times in a row (a tab switch) still triggers early mode at N = 3.
- **Capture rate** bounds what you can see. At 60 fps capture you resolve up to 30 Hz. Below 45 fps, show a warning in the dashboard.
- **Frame gaps** over 250 ms reset all streaks, so a stall cannot fake a fast sequence.
- **Static spatial patterns** (stripes) are a separate hazard that IRIS detects and this spec does not. List it under future work.

## Mitigation math

During a hazard the overlay shows a time-averaged copy of the screen, with the averaging strength computed from the detected flash so the leftover brightness swing lands at 0.07, under WCAG's 0.10 flash threshold. Mild flashes get a light touch and violent ones get heavy smoothing.

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

Set the target residual ρ = 0.07 and invert the formula, using the detector's f̂ and ΔL. The target was 0.08 until Phase 4, where uneven capture left more swing than the formula predicts (see "Phase 4 results"):

```latex
\alpha = 1 - \left( \frac{\Delta L - \rho}{\Delta L + \rho} \right)^{1/n} \qquad n = \frac{f_s}{2 \hat{f}}
```

| Flash | Required α |
| --- | --- |
| ΔL = 1.0 at 10 Hz | 0.046 |
| ΔL = 0.5 at 10 Hz | 0.09 |
| ΔL = 0.3 at 10 Hz | 0.15 |
| ΔL = 1.0 at 15 Hz | 0.068 |
| ΔL = 1.0 at 3 Hz | 0.014 |

Clamp α to the range 0.03 to 0.30. Below 0.03 the image becomes a half-second smear and stops being watchable.

### Dimming covers what smoothing cannot

When the clamp stops α short, compute the residual r that the clamped α actually leaves, then scale brightness to close the gap:

```latex
d = \min\!\left(1,\; \frac{\rho}{r}\right), \quad d \ge 0.4 \qquad \text{output} = d \cdot S
```

Worst case, a full-contrast 3 Hz strobe: α clamps at 0.03, r = 0.15, so d = 0.46. The picture is heavily smoothed and a little under half brightness. That is the hard corner, and you should say so if asked.

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

Not built. An offline test of a close relative (smooth each pixel only as far as its region's mean is away from its running average) kept barely more detail than plain smoothing on an action clip, 0.54 against 0.51, because large flashes and large movement both cover most of the picture. See the next section for the numbers.

### Stretch: correct brightness per region (experimental, trail #10)

Added Sat Nov 14 as the one stretch, at the user's request and before the gate. It is a second way to draw a hazard, behind the dashboard's "Keep motion sharp" tick box. The smoothing filter above stays the default. Detection, the trigger, the state machine, α, d and the red desaturation are the same for both.

The smoothing filter averages each pixel with its own past, so anything that moves leaves a trail. This method shows the current frame and changes only how bright each region is.

- **Targets.** Each grid cell keeps a target T, the running average of its own mean G, per channel in linear light: T += α (G − T). It is the smoothing filter run on the 96×54 grid instead of on the pixels, with the same α, on every frame.
- **Correction.** For each pixel, the region mean m and the target t are interpolated between the four nearest cell centres. Then, per channel:

  ```latex
  \text{out} = \begin{cases} x \cdot \dfrac{t}{m} & m \ge t \quad \text{(too bright: scale toward black)} \\[2mm] 1 - (1 - x)\,\dfrac{1 - t}{1 - m} & m < t \quad \text{(too dark: scale toward white)} \end{cases}
  ```

  Both are straight lines in x that send the region's mean to its target and keep the result inside 0 to 1, so nothing clips. A region already at its target is left exactly as it is. A plain gain alone could not lift a black phase, which is why the dark case scales toward white.
- **Then as before:** multiply by d, desaturate for a red hazard, re-encode, draw at the state machine's opacity.

**Same frame, no read-back.** The frame, its grid and the targets on the GPU always belong to one captured frame: Pass A uploads the frame and draws its grid, and the targets are updated at once, next to Pass B. A skipped frame skips all of them. A correction worked out from an older frame would let one full-contrast frame through at every reversal, which is still a flash.

**What stays true.** At the scale of the grid, the output is the same as the smoothing filter's: each cell's mean lands on d · T, which is what the viewer check's grid twin already computes. So the viewer check, the residual number and the protected preview apply to both methods. They say nothing about what happens inside a cell.

**What it gives up,** each pinned by a test in `src/core/regionCorrect.test.ts`:

- **It steadies each region's mean, not each pixel.** Detail finer than a cell can still alternate. A one-pixel checkerboard that inverts passes through unchanged, as it does for the detector (Step 2). A cell is 20 px on the demo laptop, about 0.34° at 60 cm, while WCAG's exemption for fine balanced patterns stops at 0.1°.
- **A hard edge keeps a flickering rim.** Where flashing content meets still content, a cell holds both and one correction cannot suit both. A rim about a cell wide on each side still swings by more than 0.10: the still side flickers in step with the flash, and the flashing side is only partly calmed. Two cells from the edge both are clean.

**Offline test (Sat Nov 14).** Both methods were run through the real detector and state machine in a scratch prototype (not in the repo), on synthetic screens at 480×270 and 60 fps, and on a 2:37 anime battle clip at 640×360 and 30 fps on default settings. "Detail kept" is the correlation between the output's edges and the current frame's, where 1.0 is the current frame's own detail.

| Test | Smoothing filter | Brightness correction |
| --- | --- | --- |
| Full-screen black and white strobe, leftover swing | 0.070 | 0.070 |
| Hard-edged strobe patch on a still screen, pixels still swinging ≥ 0.10 | none | a rim: 0.39 of the WCAG area limit in one direction |
| Clip: detail kept on the parts of the picture that change | 0.51 | 0.91 |
| Clip: IRIS (Python port) on the output. The unmitigated clip fails, with 23 failing frames | passes, 14 warning frames | passes, 14 warning frames |
| Clip: seconds our detector flags at the strict trigger. Unmitigated: 19 | 0 | 0 |

A finer correction grid shrinks the rim (0.19 of the limit at 192×108) and keeps a little less detail (0.86). The app uses the detection grid, which is already on the GPU.

**In the app.** `src/overlay/correctPass.ts` holds the targets in two 96×54 float textures and draws the corrected frame. A startup self-test checks it against the CPU twin: on the demo laptop the largest difference was 0.54 of an 8-bit code (limit 1). If the pass cannot start or fails that check, the tick box falls back to the smoothing filter and the dashboard says so. The targets are kept warm on every frame, whichever method draws, so ticking the box in the middle of a hazard switches cleanly.

**Not yet checked on screen.** The numbers above are offline. How it looks at 1920×1080 and 60 fps, and how visible the rim is on real content, need the user's eyes: the low-contrast strobe page first, then real clips.

## Architecture

CalmFrame is one Electron app with three windows and one hot loop. All per-frame work lives in the overlay window's renderer, so no frame ever crosses a process boundary and adds latency.

&#91;embedded content: CalmFrame architecture · frame loop inside the overlay renderer, three supporting parts\]

Read it clockwise from the screen: frames go in, the smoothed copy comes back out on top. Because the overlay is excluded from capture, the detector always sees the real screen underneath.

### The pieces

| Piece | Runs in | Job |
| --- | --- | --- |
| Main process | Node | Creates windows and tray, grants screen capture to the overlay renderer, stores settings, relays messages, owns the kill switch and watchdog |
| Overlay window | Renderer | Captures the screen, runs the GPU passes and the detector, draws the smoothed copy. Transparent, click-through, always on top, excluded from capture |
| Dashboard window | Renderer | Hazard graph, raw thumbnail, event log, controls. Receives stats about 20 times a second. Always on top, above the overlay, and excluded from capture, so it stays sharp and live during a hazard (decided Sat Nov 14) |
| Detector core | Plain TypeScript, no Electron or DOM imports | Detection, filter-parameter math, overlay state machine. Shared by the app and the validator |
| Strobe test page | Static page in a normal browser | Calibration source and safe demo clip |
| Validator CLI | Node script | Decodes a video file, runs the detector core, compares with IRIS |

### The per-frame loop

1. A frame arrives from the screen capture stream. Record its capture timestamp.
2. Upload it to a GPU texture.
3. Pass A: linearise and area-average down to 96×54, then read those 5,184 values back to JavaScript. The read-back is asynchronous and never stalls the frame loop (Phase 3 results).
4. Run the detector. It returns hazard, type, f̂, ΔL and the hot mask.
5. Step the state machine. It returns α, d and overlay opacity.
6. Pass B: fold the frame into the smoothing state in a half-float texture, every frame. It runs in the frame callback right after Pass A's read-back is fenced, so it uses the α decided on the previous frame, never delays the read-back, and draws only offscreen, so it presents nothing (Phase 4 results).
7. Pass C: after each decision, and only while the opacity is above 0, draw d · S, re-encoded for display, at the current opacity. When the opacity reaches 0, clear the canvas once and draw nothing more until the next hazard.
8. Every third frame, send stats and the 96×54 thumbnail to the dashboard.

With "Keep motion sharp" ticked (see "Stretch: correct brightness per region"), step 6 also folds the frame's grid into the per-cell targets, which it does on every frame anyway, and step 7 draws the corrected current frame instead of d · S.

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
- **Since Sat Nov 14 the default capture is the native module** (see "Native capture" under the build plan): full size, 60 fps, no cursor. The two points above describe Chromium's capture, which stays as the automatic fallback.
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
| Concurrency rule | One-way: a quarter of a window reversing the same way in one frame, with at most 0.25 as many reversing the other way (Step 5a) |
| Area limit, window | 0.25 of a window one third of the grid each way |
| Target residual ρ | 0.07 (0.08 until Phase 4) |
| α range, warm α | 0.03 to 0.30, 0.25 |
| Minimum dim d | 0.4 |
| Mitigation method | The smoothing filter. Brightness correction per region is an opt-in tick box, "Keep motion sharp" (experimental) |
| Hold, fade | 1.5 s, 0.75 s |
| Heartbeat, watchdog | 250 ms, 750 ms |
| Capture | 60 fps, full size with the native module; max 960×540 with Chromium's fallback (see Phase 0 results and "Native capture") |
| Native capture repeat | 20 ms: the latest frame is sent again when the screen has not changed for this long |

### Stack and repo layout

Electron, TypeScript, Vite (the electron-vite template), WebGL2 for the GPU passes, Vitest for the core tests. The dashboard is plain TypeScript and canvas. Credit every one of these in the README, as the rules require.

```text
(repo root)
  CLAUDE.md            project rules for Claude Code
  README.md            what it is, how to run, credits, what we built vs used
  docs/SPEC.md         this document, exported as Markdown
  .claude/, .entire/   Claude Code settings and Entire session capture (hooks, skills)
  native/capture/      C++ screen capture module (Desktop Duplication into shared textures)
  src/main/            windows, tray, capture grant, native capture hand-over, settings, kill switch, watchdog
  src/preload/         contextBridge API between main and the renderers (from the template)
  src/overlay/         capture, GPU pipeline (grid, smoothing, brightness correction), shaders, frame loop
  src/dashboard/       graph, thumbnail, log, controls
  src/debug/           the Phase 0 to 4 debug window, behind CALMFRAME_DEBUG_WINDOW=1
  src/core/            luminance, tracker, area, detector, filter math, brightness correction, state machine, tests
  src/shared/          message types, config defaults
  tools/strobe/        strobe test page
  tools/validate/      clip generator, validator CLI, IRIS comparison (npm run validate:all)
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
- **Dashboard stacking.** A window can sit above the overlay and be excluded from capture (tested with the debug window). That fixes the dashboard-under-overlay problem. Agreed Sat Nov 14: the Phase 5 dashboard does this.
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

- [x] Controls for frequency (1 to 30 Hz, snapped to what the display can show), the two grey levels, area as a share of the window, colour mode (grey or red and black) and burst length.
- [x] A frame counter and millisecond timestamp are drawn on screen for the slow-motion footage.
- [x] It starts paused behind a warning, Esc stops it, it auto-stops after 5 s, and it defaults to low contrast (a 0.2 swing between two greys).

#### Phase 2 notes (Fri Nov 13, built on the Mac)

Two decisions the spec did not fix, recorded because CLAUDE.md requires deviations to be written down:

- **The page duplicates five thresholds instead of importing them.** "One static page with no build step and no dependencies" means it cannot import `src/shared/config.ts`, so `tools/strobe/strobe.js` copies `LUMINANCE_THRESHOLD`, `DARK_LIMIT`, `RED_THRESHOLD`, `RED_RATIO` and `RED_SCALE` to show whether the current settings would count as a flash. `tools/strobe/strobe.test.ts` imports the config module and asserts the copies still match, so config.ts stays the single source of truth without the page importing it.
- **The cap on the swing while full contrast is off is 0.3.** The spec fixes the default swing (0.2) and says full contrast is a separate toggle, off by default, for the slow-motion measurement only, but it does not say what the range in between is. The page clamps the two greys to a 0.3 swing until the toggle is on, which keeps the default range low-contrast while still allowing either side of the 0.10 detection threshold to be explored.

Everything else is as specified. Each half-cycle is a whole number of display frames, the frequency control offers only `refresh / 2n`, and the burst's achieved frequency is measured between its first and last transition so a part-finished half-cycle cannot bias it low.

#### Phase 2 verification (Fri Nov 13, Windows demo laptop, 1920×1080 at 60 Hz, mains, Turbo)

- **The warning gate didn't open in any browser.** `#gate { display: grid }` overrode the `hidden` attribute, so the button did nothing. Fixed with a global `[hidden] { display: none !important }`. The Mac's unit tests cover `strobe.js` but not the page, so they could not catch it.
- **Snapping and frame counts are right.** The 5, 10 and 15 Hz buttons give 6, 3 and 2 frames per half-cycle. A 10 Hz burst achieved 10.01 Hz.
- **The slider labels read about 0.4% high** (15.06 rather than 15). The refresh estimate takes the median gap between frame timestamps, which the browser rounds to 0.1 ms. That gives 16.6 ms, so 60.24 Hz. The flash itself counts whole frames and is unaffected. Follow-up for the Mac: estimate from the total span, or snap to the nominal rate when within 1%.
- **Slow motion works.** In 240 fps iPhone footage of a 10 Hz burst, FRAME, MS and PHASE (HI/LO) were readable, confirmed by eye.
- **Safety behaviour checked by hand.** The page loads behind the gate, and Esc or a click stops a burst. The maximum burst stops itself at 5 s. Loaded in a hidden window, the defaults read greys 89 and 149, 25% area, a 3 s burst and full contrast off.

### Phase 3: live detection (A and B, Friday 9:30 PM to Saturday 1:00 AM)

- [x] Capture, grid and detector run in the overlay renderer, and the checkerboard test reads 0.5.
- [x] A graph shows flashes per second. The test page at 2 Hz stays under the line and at 10 Hz goes over it.
- [x] Hazard start and end are logged with timestamps.
- [x] Analysis costs under 4 ms per frame.

#### Phase 3 results (Fri Nov 13, Windows demo laptop, 1920×1080 at 60 Hz)

All four boxes pass. The live checks used the strobe page at its default low contrast (greys 89 and 149, a 0.2 swing, 25% of a browser window snapped to half the screen):

- **Checkerboard.** Pass A runs a self-test at startup. A 1-pixel checkerboard reads Y 0.5000 in every cell at 960×540 and 1920×1080, and 0.4999 to 0.5001 at 1366×768, where cells hold a fractional number of pixels. Averaging the gamma-encoded values would read 0.21. On noise, the GPU grid matches a CPU twin (`src/core/gridAverage.ts`) to 1.6e-6. The noise check catches a pass that averages only part of each cell, which a checkerboard can't. The validator can reuse the CPU twin.
- **Graph.** At 2 Hz the graph peaked at 2.0 flashes per second and never raised a hazard. At 10 Hz it read 10.0 to 10.5 and raised a luminance hazard (ΔL 0.20, area 0.56, f̂ 8 to 11 Hz), which ended 2.99 s later with the 3 s burst.
- **Log.** Hazard start and end, with wall-clock time and capture timestamp, appear in the debug window and the terminal.
- **Cost.** Main-thread analysis per frame had a median of 1.0 to 1.3 ms and a p95 of at most 3.8 ms. The parts: upload and Pass A 0.2 to 0.3 ms, grid copy 0.4 ms, detector and state machine 0.3 to 0.6 ms.
- **Latency per stage**, as median / p95 from capture timestamps:

  | Stage | Median | p95 |
  | --- | --- | --- |
  | Captured → frame callback | 4 ms | 14 ms |
  | Callback → grid ready | 7 to 10 ms | 12 ms |
  | Grid → decision | 0.4 ms | 0.7 ms |
  | Captured → decision | 12 to 13 ms | 22 to 25 ms |

  The largest stage is the round trip through the GPU. Chromium stamps `captureTime` late (Phase 0), so the first stage and the total are understated, and the slow-motion footage stays the end-to-end number. Decision → overlay drawn arrives in Phase 4. At 10 Hz, early mode itself waits about 100 ms for the third reversal, so the trigger rule outweighs the whole pipeline.

What changed from the plan, and why:

- **Read-back is asynchronous.** A synchronous `readPixels` cost 2.1 ms on a quiet screen. Whenever another window of the app animated, it waited a full vsync (about 17 ms), blocking the overlay's main thread and dropping a third of the frames. Pass A now reads into one of 3 pixel buffers behind a fence, collected when the GPU signals. The main thread never waits: if every slot is busy, the frame is skipped and counted. Grids are processed in capture order, not newest only. The GPU finishes them in order, so dropping older grids would lose samples without saving any latency.
- **Open: GPU-process contention.** Electron runs one GPU process for all its windows. While our own debug window animated at 60 Hz, a read-back took about 50 ms. Other apps, such as the browser or a game, don't share that queue, but the Phase 4 overlay will. Phase 4 should draw only while the overlay is visible, and measure this stage during a hazard. If it hurts the first detection, the fallback is the native capture module named in the Phase 0 results.
- **The red tint is behind a debug flag** (`CALMFRAME_DEBUG_TINT=1`), along with the automatic capture-leak check that toggles it.
- **Grid row 0 is the top of the screen** on both the GPU and CPU paths, and the hot mask uses the same order.

Findings:

- **A 0.34 s false positive while the test windows were being arranged.** It had ΔL 0.94 over 47% of a window: three fast, near full-contrast reversals, the "lightning" class this spec accepts. In Phase 4 it would show the smoothed copy for about 2 s. Arrange windows before a demo, not during it.
- **The strobe page's frame counter and clock** change every frame in 11 to 20 cells. Those cells go hot but stay far under the area limit (144 cells), as intended.
- **Capture ran at 41 to 48 fps**, below Phase 0's 54 fps and sometimes below the 45 fps warning. Check Turbo mode and background apps before Phase 6 measurements.
- **The hazard-end line's peak frequency (23.5 Hz) is inflated** at the edges of the burst. During the burst, f̂ read 8 to 11 Hz. Peaks don't feed mitigation, and the state machine only lets α get stronger.

### Phase 4: smoothing overlay (A, Saturday 9:00 AM to 1:00 PM)

- [x] A hazard makes the overlay opaque within one frame, showing the smoothed copy. It releases after the hold and fade.
- [x] On the 10 Hz test strobe the screen looks like steady grey, while the detector still reports the hazard underneath. *By measurement: the leftover swing is 0.070 to 0.074, under the 0.10 threshold. At low contrast that is calmer, not perfectly steady, to the eye.*
- [x] The overlay never toggles during a continuous strobe.
- [x] The watchdog hides a deliberately frozen overlay.

#### Phase 4 results (Fri Nov 13 to Sat Nov 14, Windows demo laptop, 1920×1080 at 60 Hz)

All four boxes pass, the second by measurement after the target was lowered. The strobe checks used the test page at its default low contrast (a 0.2 swing, 10 Hz). The numbers come from the app's own log.

- **On within one frame, off slowly.** Every hazard moved the state machine from Safe to Active on the hazard's own frame, at opacity 1.00. Release began 1.48 to 1.52 s after the last hazard frame and the fade took 0.72 to 0.77 s.
- **No toggling.** Three bursts of the test strobe (4.96 s, 4.99 s and 2.96 s) each produced one hazard and one Active episode. On a real clip with red flashing at about 11 to 20 Hz that kept stopping and starting, the overlay stayed on for 11.7 s without a break and applied the red desaturation.
- **Watchdog.** The debug freeze blocked the overlay renderer for 5 s. Main hid the overlay after 751 ms without a heartbeat. When the renderer resumed it went to Disabled and stayed hidden until the kill switch switched protection back on 3 s later.
- **Steady grey, by measurement.** With the 0.08 target, the viewer check measured a leftover swing of 0.083 to 0.105 on the test strobe (α 0.22 to 0.23), and its detector never raised a hazard on what the viewer saw. One reading, 0.105, was over WCAG's 0.10. By eye it was "still flickering, just smoother": at this contrast a swing near 0.09 is under the threshold but visible. The detector underneath kept reporting the hazard for the whole burst (graph 10 to 10.5). The residual formula assumes even sampling and capture ran unevenly at 39 to 50 fps. **Decision: target 0.07**, which scales the worst reading to about 0.092. 0.06 would give more room, at the cost of longer trails. One 3 s burst at the new target (Sat Nov 14, 1:14 AM, α 0.205, capture 36 to 52 fps) read 0.070, 0.074 and 0.073, with the detector underneath still at graph 10 to 10.5 and the viewer check at 0. That is one burst and three readings, so Phase 6 should repeat it; the 0.105 outlier at the old target was one reading in about ten.
- **Drawing does not slow detection.** The grid wait was 7 to 9 ms at the median whether or not the overlay was drawn, with no busy skips in 740 drawn frames. The GPU contention that Phase 3 worried about did not appear, because Pass C draws only while the overlay is visible.

  | Stage, while the overlay is drawn | Median | p95 |
  | --- | --- | --- |
  | Captured → decision | 15 to 17 ms | 25 to 27 ms |
  | Decision → overlay drawn on the GPU | 5.4 to 5.8 ms | 7 to 9 ms |
  | Captured → overlay drawn | 21 to 23 ms | 31 to 33 ms |

  As in Phase 3, these are understated and leave out the compositor and the display. The slow-motion footage stays the end-to-end number.
- **Startup self-tests pass.** Passes B and C match the CPU twin to 0.58 of an 8-bit code, and the half-float state round-trips exactly.

Findings:

- **Movement triggered the overlay constantly.** See the next section and Step 5a.
- **Fast camera turns in games still trigger.** After Step 5a, flicking the view left, right and back in Minecraft, and the same in Valorant footage, still switches the overlay on. A fast turn moves the picture several times further per frame than Step 5a's limit, and bright and dark halves of a scene swapping places is a large-area brightness reversal. Options, none built: N = 4 on the sensitivity slider, or a check for whether the new frame is the old one shifted.
- **The debug window's preview is unprotected.** It sits above the overlay and is big enough to count as a hazardous area. Use it only with the low-contrast test strobe. Phase 5's raw thumbnail is capped at 240×135 for this reason.
- **Capture ran at 39 to 50 fps**, mostly 45 to 48, below Phase 0's 54. Check the demo-laptop setup before Phase 6.

#### Movement false triggers (Sat Nov 14, Windows demo laptop)

Found while testing Phase 4 on real content: scrolling YouTube, scrolling VS Code, dragging a window and opening a window each switched the overlay on. In one run of about 10 minutes there were 7 triggers from window and tab actions alone, each smoothing the screen for about 2.25 s (the hold plus the fade). The fix is Step 5a. This section records how it was chosen.

- **The cause, measured.** In simulated screens run through the real detector, 86 to 100% of a strobe's hot cells made their latest reversal in the same captured frame. For scrolling and dragging it was 12 to 55%.
- **"At the same time" alone was not enough.** A fast scroll moves the page 33 to 67 px per captured frame, so more than a quarter of a window does change in a single frame. Requiring the reversals to also go the same way is what separates the two.
- **Results in simulation**, 12 movement cases and 10 strobe cases, at an even 60 fps and at an uneven 40 fps like the demo laptop's capture:

  | Rule | Movement cases that trigger (60 fps / 40 fps) | Strobes caught | Strobe delay |
  | --- | --- | --- | --- |
  | Steps 4 and 5 only (`off`) | 11 / 11 of 12 | 10 of 10 | none |
  | N = 4 only | 9 / 9 | 10 of 10 | 33 to 133 ms |
  | Same frame, either direction | 8 / 8 | 10 of 10 | none |
  | Same frame, same direction (`one-way`) | 0 / 2 | 9 of 10 | none |

  The two movement cases left at 40 fps are 5,000 and 6,000 px/s scrolls. The strobe not caught is the inverting checkerboard. Allowing more opposing reversals than a quarter (0.35, 0.5, 0.75) let 3,000 px/s scrolling trigger again, so 0.25 stays.
- **The simulated pages are stand-ins** (a grid of video thumbnails, a chat page with code blocks, a dragged window), not recordings of this screen. The detector with the rule on matched the prototype on every frame of every case.
- **Cost.** A detector step took 0.5 to 0.85 ms in Vitest on the demo laptop with the rule on or off, on a still screen, a scrolling page and a 10 Hz strobe. The rule adds nothing measurable against the 4 ms budget.
- **On the live screen (Sat Nov 14, by eye).** Scrolling no longer triggers unless it is very fast, and most of the real flashing clip is handled as before, with a trigger on its lightning scene. Fast camera turns in games still trigger (see "Phase 4 results"). The debug window's "Ignore movement" box switches the rule off to compare, and the terminal's `[detect]` line shows how many reversals the rule set aside.
- **Tab switches remain.** If they still trigger too often on the live screen, the next step is N = 4, which costs about half a flash more at the start of a real strobe.

### Phase 5: dashboard and controls (C, Saturday 9:00 AM to 3:00 PM)

- [x] The dashboard sits above the overlay and is excluded from capture, so the graph and thumbnail stay sharp and live while the rest of the screen is smoothed.
- [x] Scrolling graph with the limit line at 3 flashes per second.
- [x] Status that reads Protected, Smoothing, or Protection off, and is never wrong.
- [x] Raw-input thumbnail no larger than 240×135, clearly labelled. At that size it is under the area limit on a 1080p screen by design.
- [x] Event log lines such as "0:42, 8 Hz, 2.1 s, smoothed".
- [x] Sensitivity slider, on/off switch, events-mitigated counter, tray icon with a menu.
- [x] A warning when capture drops below 45 fps.
- [x] The Step 5a "Ignore movement" switch moves from the debug window to the dashboard, on by default, so the fallback to the detector as first specified stays one click away.

#### Phase 5 results (Sat Nov 14, Windows demo laptop, 1920×1080 at 150% scaling)

The dashboard replaces the debug window. It is plain TypeScript and canvas, one narrow column at the top right of the screen (460×640 DIP at this scaling). The Windows checks below were run from outside the app. The dashboard is excluded from capture, so no screenshot tool can see it. Its layout was checked from a render of the page itself (`webContents.capturePage`).

- **Above the overlay, out of the capture.** The dashboard is always on top at the overlay's level (`screen-saver`). It is raised again every time the overlay is shown, so it stays above it. Content protection is on. Win32 confirms the dashboard sits directly above the overlay in z-order, both windows are topmost, and both have display affinity `0x11` (`WDA_EXCLUDEFROMCAPTURE`). That held after the kill switch hid the overlay and showed it again.
- **Status, derived from the heartbeat.** `src/shared/status.ts` is a pure function of the latest heartbeat and its age. Main relays each heartbeat with its own view of the overlay window. The dashboard and the tray re-derive the status every 250 ms, so silence alone turns it off. Every rule can only turn the status off:
  - no heartbeat for 750 ms (the watchdog's limit)
  - the pipeline failed open
  - protection switched off
  - the overlay window hidden
  - the capture track ended
  - no captured frame for 1 s (`FRAME_STALE_MS`)

  On screen, the kill switch moved the status from Protected to "Protection off: Switched off with Ctrl+Alt+Shift+C" and back within one heartbeat.
- **Frames keep flowing on a still screen.** Before choosing `FRAME_STALE_MS`, we checked whether Chromium stops sending frames when nothing changes. It doesn't: up to 19 of 45 frames a second were identical to the one before, and the longest gap was 49 ms. So 1 s without a frame means the capture has stalled, not that the screen is still.
- **Thumbnails.** Both are the 96×54 grid, encoded to sRGB in the overlay (20 KB each, every third frame). They are sized in device pixels: 240×135 at 1080p, which is 160×90 CSS pixels at 150%. They are also capped at an eighth of the screen each way, which keeps them under the area limit on any screen, not only at 1080p (`src/core/thumbnail.test.ts`).
  - **Raw input (unprotected)** is always live.
  - **Protected preview** is the viewer check's grid, what the viewer sees. It shows a picture only while the overlay draws its smoothed copy, and a placeholder otherwise. So the two panes never show unsmoothed flashing at the same time: two 240×135 panes side by side would add up to 112% of the area limit at 1080p.
- **Event log and counter.** One line per flash event, for example `0:42, 8 Hz, 2.1 s, smoothed`, timed from the app's start. An event merges hazards that are closer together than the hold plus the fade (2.25 s), which is exactly one stretch of the overlay being up. Without that, a clip whose hazard flag drops in and out would fill the log. The rate shown is the median of the per-frame estimates, because the estimate is inflated at the edges of a burst (Phase 3). The counter counts the events that were smoothed. Events while protection is off read "not smoothed (protection off)".
- **Controls.**
  - The sensitivity slider has the positions N = 2, 3 (default), 4, then strict. Each shows the Step 7 prediction of flashes seen at 10 Hz and 75 ms (1.3, 1.8, 2.3, 3.8). It has no pre-arm position: the user decided at the start of this phase that pre-arm stays off.
  - "Ignore movement" is on by default. Unticked, it is the detector as first specified. The debug window's box drives the same setting.
  - The on/off switch sits next to the status.
  - The tray icon has a different shape per status (a filled disc, a disc with a wave, a slashed ring), so it reads without colour. Its menu has the status, "Protection on", "Show dashboard" and "Quit CalmFrame".
  - Everything is a native control, so the page works from the keyboard: Tab, arrow keys, Space.
- **Settings persist** in `settings.json` in the app's userData folder: sensitivity, Ignore movement, and where the dashboard was left. Each field is validated on load, so a damaged file falls back to the defaults. A position saved while the app ran (x 600, y 90) came back after a restart. Bounds are saved on every move and resize, because Windows sends `moved` only at the end of a mouse drag.
- **Low capture rate.** The warning shows under 45 fps and stays up 5 s after the last low reading, so it doesn't come and go. During this session's testing capture ran at 39 to 50 fps, so the warning was often up. Check the demo-laptop setup before Phase 6.
- **Cost.** Analysis per frame was 1.0 ms median and 1.7 ms p95 with the dashboard open, inside the 4 ms budget.
- **On-screen check (Sat Nov 14, 6:50 AM, by the user, low-contrast strobe page).** Four bursts at 7 to 12 Hz. Each one turned the status to Smoothing and logged an event, for example `0:26, 11 Hz, 2.9 s, smoothed`. The overlay started to fade out 1.5 s after the last hazard and was gone 0.75 s later, and the status went back to Protected. The user checked by eye that the graph crossed the line, the raw thumbnail flickered while the protected preview stayed calm, the counter went up, and the tray menu worked. The kill switch turned protection off and back on. The slider was moved through all four positions and "Ignore movement" switched off. After a restart both came back, and so did the dashboard's position. Capture ran at 40 to 49 fps (demo setup not applied), so the low-rate warning was up for part of the time.

Decisions and deviations:

- **Protection starts on at every launch.** It is the one setting that does not persist. A switch left off by accident must not leave someone unprotected after a restart.
- **Closing the dashboard hides it to the tray.** Quit is in the tray menu.
- **One CalmFrame at a time.** At the start of this phase an earlier dev instance was still running, and capture fell to about 33 fps with two copies capturing. A second launch now shows the running copy's dashboard and exits.
- **The debug window stays, behind a flag.** `CALMFRAME_DEBUG_WINDOW=1` opens it (the FPS sweep opens it too). It has the capture tools and the per-stage latency tables that Phase 6 uses.
- **The dashboard is visible to no screen recorder,** as already noted under "One gotcha to plan around". Film it with the phone. No recording switch was built.

### Phase 6: measure and validate (D, Saturday 1:00 to 6:00 PM)

- [ ] Slow-motion counts at 5, 10 and 15 Hz, protection off and on.
- [x] IRIS comparison table over the clip set. *The 11 synthetic clips. The three to five real clips are not added yet.*
- [x] Latency median and 95th percentile from the app's own log. *Captured → overlay drawn: 20 ms median, 28 ms p95 (`measurements/latency.md`).*

#### Phase 6 results so far (Sat Nov 14, Windows laptop)

The IRIS comparison ran overnight, unattended. The latency log came from the morning slow-motion session. The slow-motion counts are still to come.

**Merged with one box open (Sat Nov 14, about 8 AM).** At the user's request, Phase 6 merged to `main` before the slow-motion counts, so the native capture could merge after it. The counts are a measurement, not code: the user will film them later, preferably with the native capture, since that is what the demo runs. The box stays unticked until then.

- **Latency from the app's log** (`measurements/latency.md`). The run lasted 201 s in demo setup on default settings, with five low-contrast bursts at 5, 10 and 15 Hz. All five were smoothed, with no busy skips.
  - Captured → decision: 13.8 ms median, 21.9 ms p95.
  - Decision → overlay drawn: 4.8 ms median, 5.9 ms p95.
  - **Captured → overlay drawn: 20.4 ms median, 28.0 ms p95.**

  The GPU round trip (callback → grid) is 5.7 ms median, down from 7 to 10 ms in Phase 3. These figures understate the true delay, because `captureTime` is stamped late and the time to reach the glass is left out. Quote the slow-motion figure in the pitch.
- **Capture rate in the same run:** 50 fps median, 44 at the 10th percentile, range 39 to 59, with 15% of the seconds under 45. Phase 0 measured a mean of 54 with no other apps open. Here VS Code and the browser were open. The warning holds for 5 s after any reading under 45, so it showed for about 47% of the run. A 5 s rolling mean fell under 45 for only 13 s.

- **The validator** (`tools/validate`, Prompt 8) has three steps:
  - `make-clips` writes the 11 clips of "Test clips" as 1080p60 H.264 (CRF 4) with a 3 s lead-in, plus a manifest of the expected results.
  - `validate` decodes with ffmpeg and averages each frame to the grid in linear light with `averageToGrid`, the CPU twin of Pass A. Then it runs the real detector with each frame's presentation time and writes one CSV row per second.
  - `compare-iris` writes the two-by-two tables.

  `npm run validate:all` runs everything. It is built with the project's own `tsc`, so it adds no npm dependency. It needs only ffmpeg, not ffprobe, so the build bundled with the Python package `imageio-ffmpeg` is enough. The README has the setup. A clip takes about 16 s to validate here, and IRIS takes about 30 s.
- **Result** (`measurements/iris-comparison.md`), against `iris-pse-detection` 1.1.2 with its default settings:

  | CalmFrame setup | Both fail | Both pass | Only IRIS | Only CalmFrame | Agreement |
  | --- | --- | --- | --- | --- | --- |
  | IRIS-compatible area, strict trigger, extended-failure rule | 45 | 65 | 0 | 0 | 100% (110 of 110 s) |
  | WCAG area, strict trigger | 42 | 58 | 3 | 7 | 90.9% |

  The WCAG setup differs from IRIS in exactly the two places this spec predicts:
  - **2 Hz full-screen** (3 s where only IRIS fails). IRIS's extended-failure rule fails it from second 7, after 4 s of flashing. WCAG has no such rule, so the WCAG setup leaves it out.
  - **The 15% patch** (7 s where only CalmFrame fails). It fills a whole 10° window, so the WCAG rule flags it, but it covers less than a quarter of the frame, so IRIS passes it.

  Every clip's verdict matches the expected column of the "Test clips" table in both setups. The IRIS column there is reproduced too: the 2 Hz clip fails only by the extended rule, and the red clip fails red and luminance.
- **A reading of the detector** the CSV makes visible: with the extended-failure option on, the detector's `hazard` flag includes the extended failure. The validator's CSV reports the trigger and the extended rule as separate columns.
- **IRIS's exit code is its verdict:** 0 pass, 1 fail, 2 pass with a warning, 3 error. The runner first treated 1 as an error.
- **Still to do for this box:** three to five real clips (a music video with strobes, game footage, a talking-head negative), with their sources noted. They need someone to choose and source them.
- **First real clip, not yet in the report (Sat Nov 14).** A 2:37 anime battle from YouTube ("Pokemon: Infernape vs Luxray", 1270×720 at 30 fps), supplied by the user and kept out of the repo.
  - IRIS fails it at one moment, 2:19: near white to near black, then a 15 Hz flicker over more than half the frame, 9 transitions in the second. It also gives warnings in 17 other seconds.
  - CalmFrame's WCAG setup flags 18 of the 157 seconds at the strict trigger, 2:19 among them, and 52 at the default trigger. With the Step 5a rule off, strict flags 86, so the rule removes most of them on real content too.
  - **The IRIS-compatible setup flags nothing, so it misses the one second IRIS fails.** The Step 5a rule is why: with it off, that setup catches 2:19, but also flags 34 seconds IRIS passes. The 100% agreement above therefore holds for the 11 synthetic clips only. Say so wherever that figure is quoted. The app is not affected: it uses the WCAG area and catches 2:19 at every slider position.
- **Tested in Coder without GitHub.** The overnight session could not push to the GitHub mirror, which needs the user's login. The branch went to the Coder workspace as a git bundle over `coder ssh` instead, and the suite ran there (`docs/CODER-LOG.md`).

### Native capture (stretch, Sat Nov 14 morning, trail #9)

Taken before the gate, at the user's request: Chromium's capture kept dipping under the 45 fps warning (50 median, 39 to 59) and capped the picture at 960×540, so the smoothed copy looked soft. This reverses "A native capture module is not planned for this weekend".

- **How.** `native/capture` is a C++ N-API module, about 600 lines. A worker thread waits for each new desktop frame with DXGI Desktop Duplication on the primary output's adapter. It copies the frame into one of six shared D3D11 BGRA textures (NT handles) and waits for the copy to finish on the GPU, because Electron's import uses no keyed mutex or fence. Then it hands the slot to the main process. Main imports the texture with Electron's experimental `sharedTexture.importSharedTexture` and sends it with `sendSharedTexture` to the overlay. The overlay's preload passes it to the page, the shape of Electron's own test fixture. The page takes a `VideoFrame`, uploads it with `texImage2D` exactly as it uploaded the `<video>`, and closes it. When every reference is released, main frees the slot. Pass A, the detector and the smoothing passes are unchanged. Only a handle and three numbers cross IPC.
- **Why Desktop Duplication, not Windows Graphics Capture** (which Phase 0 named): it draws no yellow capture border and leaves the cursor out of the image, so no ghost cursor. One consequence: it only delivers a frame when the screen changed. So the module sends the latest frame again after 20 ms without a change (`NATIVE_CAPTURE_REPEAT_MS`), and the filter and the stale-frame rule keep a steady sample rate. 20 ms is just over one 60 Hz frame, so a screen that changes every frame gets no repeats. Timer resolution is raised to 1 ms while capturing so that wait is not rounded up to 15.6 ms.
- **Timestamps** are the frame's own present time from the system's high-resolution clock, as epoch ms, which the overlay puts on its performance clock. Chromium's `captureTime` was stamped late (Phase 0), so the capture-to-callback figures below are the first real ones.
- **Results on the demo laptop:**
  - Plain Node speed test, with a moving bar on screen: 60 fps at 1920×1080. The copy was done 1.1 ms after the present, and JavaScript had it 0.1 ms later. No frame was missed or dropped.
  - In the app, frames per second over 523 s: 60 to 61 most of the time, and under 45 in only one second (43 fps), not counting the partial first second.
  - Capture to frame handler: 1.9 ms median, 2.5 ms p95 (Chromium: 7.5 / 15.4).
  - Capture to decision: 7.7 ms median.
  - Capture to overlay drawn: 14 ms median, 19 ms p95 (Chromium: 20.4 / 28.0, `measurements/latency.md`).
  - Analysis cost per frame: 0.6 to 1.0 ms median at the full 1920×1080. No busy skips while drawn (0 of 4,942).
  - Both GPU self-tests pass.
- **Capture exclusion holds.** With the debug tint, the capture-leak self-check passed: the red-ratio change with the tint on was 0.000 in all three cycles, and the black share was 0.00. Microsoft's page for `WDA_EXCLUDEFROMCAPTURE` does not say which capture methods it covers, so this measurement is the evidence.
- **Colours and the user's check.** The user ran strobe bursts on the native capture, including the red-and-black mode. The red bursts were detected as red hazards (5 to 10 Hz) and smoothed with red desaturation, so the BGRA channel order is right. They judged the result good, and made native capture the default.
- **Fallback and failure.** If the module is missing (it is built with `npm run native:build`) or cannot start, the overlay logs why and opens Chromium's capture. `CALMFRAME_NATIVE_CAPTURE=0` forces Chromium's capture, and the FPS sweep always uses it. If duplication is lost while running, the module recreates it:
  - "Access lost" covers the secure desktop, a mode change, or a full-screen app taking over.
  - While it is gone, no frames arrive, so the stale-frame rule turns the status to Protection off.
  - A display-size change is not recovered: the status stays off until a restart.
- **Packaging.** `build:win` builds the module and electron-builder copies it to `resources/native`.
- **Not done:** secondary displays, rotated displays, and recovery after a display-size change.

### Gate: Saturday 6:00 PM

If every box above is ticked, pick one stretch: regional smoothing (the visual win) or the Typesense hazard index (an extra prize). If any box is open, spend the evening closing it and polishing instead.

**The one stretch is taken (Sat Nov 14, morning, trail #10):** brightness correction per region, as an experimental tick box that is off by default. The user asked for it before the gate, with the Phase 6 slow-motion box still open. See "Stretch: correct brightness per region" under "Mitigation math". Regional smoothing and the hazard index are not built.

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

Screen recorders cannot see the overlay, because it is excluded from capture by design. A screen recording of CalmFrame working shows the raw strobe. For the video, film the laptop with a phone. The dashboard is excluded from capture too (so the detector does not analyse it and the protected preview does not capture itself), which means a screen recorder cannot see the dashboard or its protected-preview pane either. Footage of both comes from the phone, unless Phase 5 adds a switch that lets the dashboard be recorded.

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
- The dashboard window is set always-on-top after the overlay, at the same level, with content protection on, as the debug window's stacking checkbox does today. Nothing in it is smoothed, so nothing in it may flash over a hazardous area.
- The raw thumbnail is drawn from the 96x54 grid, capped at 240x135, and labelled "Raw input (unprotected)".
- Carry over what the debug window does that is still needed: the Step 5a "Ignore movement" switch (on by default; off is the fallback detector) and the hidden freeze shortcut for the watchdog test. Read "Decisions already made" in CLAUDE.md before changing any detector default.
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
