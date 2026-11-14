# CalmFrame: rules for Claude Code

CalmFrame is a Windows desktop app (Electron + TypeScript) that watches the whole screen, detects flashing that breaks the WCAG 2.3.1 flash thresholds, and covers it with a smoothed copy. We're building it at EmoryHacks 2026 (Nov 13 to 15).

**Read docs/SPEC.md in full before doing anything.** It is the source of truth for the math, the architecture, the default values and the acceptance criteria. Each build phase has a checklist under "Build plan", and its prompt is under "Claude Code prompts".

## Team and machines

The spec's four roles (A to D) collapse to two laptops. Windows 11 is the only target OS.

| Laptop | Owns | Notes |
| --- | --- | --- |
| Windows 11 (demo machine) | src/main, src/preload, src/overlay, src/dashboard, the tray, all live testing | The only place the app runs. Overlay, capture exclusion, GPU passes and anything Electron does at runtime are verified here and nowhere else. |
| Mac | src/core and its tests, tools/strobe, tools/validate, measurements | Pure TypeScript, Vitest, a static HTML page and the validator CLI. Never report an overlay, capture or Electron feature as working from a Mac run. Hand on-screen checks to the Windows laptop with exact steps. |

- **From Phase 4 on (Fri Nov 13, 11:30 PM), the Windows laptop does every remaining phase**, including `src/core`, `tools/strobe`, `tools/validate` and measurements. The Mac column above still says which code is pure (no Electron), and that code is still what runs in the Coder workspace. Because no one else works in Coder, its evidence now comes from this laptop: run the suite there after each push, and run the Phase 6 validator there too (see "Coder" below).
- One branch per phase (e.g. `phase0-overlay`, `phase1-core`). Merge to `main` when that phase's checklist is ticked and checks are green.
- The two laptops' folders don't overlap. The first real merge point is Phase 3, when core is wired into the overlay.

## Commands

- `npm run dev`: run the app (Phase 5 state: the overlay runs live detection, stays invisible until a hazard and then shows the smoothed copy. The dashboard sits above it with the status, graph, thumbnails, event log, sensitivity slider, "Ignore movement" switch (Step 5a; off is the fallback to the detector as first specified) the experimental "Keep motion sharp" tick box (off by default; ticked, a hazard is drawn with brightness correction per region instead of the smoothing filter) and the "Flash limit (for testing)" slider (3 to 10 flashes a second; 3 is the WCAG limit and the default). The tray icon has the on/off switch and Quit. Ctrl+Alt+Shift+C toggles protection. Closing the dashboard hides it to the tray, so quit from the tray or stop the dev server. Only one copy runs at a time: a second launch shows the first one's dashboard and exits.)
- `npm run native:build`: builds the native capture module (`native/capture`, C++, needs the Visual Studio 2022 Build Tools). `npm run dev` uses it by default and falls back to Chromium's capture, with a log line, if it is missing or fails to start. `CALMFRAME_NATIVE_CAPTURE=0 npm run dev` forces Chromium's capture. See "Native capture" in the spec.
- `CALMFRAME_DEBUG_WINDOW=1 npm run dev`: also opens the Phase 0 to 4 debug window (capture stats, per-stage latency tables, capture-leak self-check, capture size cap, unprotected live preview)
- `CALMFRAME_DEBUG_TINT=1 npm run dev`: also shows the Phase 0 red tint on the overlay and runs the automatic capture-leak check
- `CALMFRAME_FPS_SWEEP=1 npm run dev`: opens the debug window, measures Chromium's capture frame rate at each size cap with its moving test bar, and logs a summary. It always uses Chromium's capture.
- Settings (slider, Ignore movement, Keep motion sharp, dashboard position) live in `%APPDATA%\calmframe\settings.json`. Delete it to get the defaults back. Protection is not saved: it starts on at every launch. The flash limit is not restored either: it is 3 at every launch.
- `npm test`: Vitest, run once (`npm run test:watch` to watch)
- `npm run typecheck`: three projects. core (src/core + src/shared, pure), node (main, preload, tests, tools), web (renderers)
- `npm run lint`
- `npm run validate:all`: the Phase 6 IRIS comparison. Makes the 11 test clips, runs IRIS and the validator, writes `measurements/iris-comparison.md`. Needs the IRIS virtualenv in `%USERPROFILE%\.calmframe\iris-venv` (README, "Compared against IRIS"). `npm run validate -- <video>` checks one file.
- `npm run render -- <video>`: the offline render for demo footage, since no screen recorder can see the overlay. Writes `<video name>.calmframe.mp4` next to the source: the protected picture beside the original, made with the app's own detector, state machine and filter arithmetic. Options are the app's settings (`--sensitivity 2|3|4|strict`, `--ignore-movement on|off`, `--keep-motion-sharp on|off`, `--flash-limit 3..10`), plus `--layout big-small|equal|protected-only`, `--delay-frames`, `--fps`, `--start`, `--duration`, `--out`. It needs only Node and ffmpeg. The Coder workspace has no ffmpeg yet, so only its tests have run there. It is a simulation, not a recording of the live overlay: keep the line that says so in the footage. Spec: "The offline render".
- `npm run build:win`: packaged Windows installer. It builds the native capture module first, and electron-builder copies it to `resources/native`. On Sat Nov 14 packaging into `dist/` failed with EBUSY on `default_app.asar`: something held a lock on files there, probably VS Code watching the workspace. Building outside the workspace worked (`npx electron-builder --dir --config.directories.output=<folder outside the repo>`), and that packaged app ran with native capture.

Before every commit, `npm run typecheck && npm run lint && npm test` must pass.

**Demo-laptop setup (Phase 0 found the capture rate depends on it).** Display at 1920×1080 and 60 Hz, mains power, Turbo mode, discrete GPU off, and no other heavy apps. The native 2880×1800 screen only captures at about 24 fps with Chromium's capture. See "Phase 0 results" in the spec. The native capture module holds 60 fps at full size, but keep the setup for the fallback.

**Launching the app from Claude Code inside VS Code.** Its shells inherit `ELECTRON_RUN_AS_NODE=1` from VS Code. Electron then starts as plain Node and crashes with `Cannot read properties of undefined (reading 'isPackaged')`. Launch with `env -u ELECTRON_RUN_AS_NODE npm run dev` (Bash tool), or `Remove-Item Env:ELECTRON_RUN_AS_NODE; npm run dev` (PowerShell). A normal terminal doesn't need this.

## Working rules

- docs/SPEC.md is the source of truth. If the code must deviate, say so and update the spec in the same commit.
- src/core is pure TypeScript with no Electron, DOM or Node imports. Everything in it has unit tests.
- All per-frame work stays in the overlay renderer. Never send frames over IPC.
- Never assume the capture size. Read it from each frame and size GPU textures from it, reallocating if it changes. The native capture is full size (1920×1080 on the demo laptop); Chromium's fallback keeps the Phase 0 960×540 cap.
- Timing logic uses capture timestamps, never frame counts.
- Fail open: on any error, hide the overlay and report "Protection off".
- Safety: never auto-play a strobe. Test content starts paused, low contrast and small, with an auto-stop.
- Check Electron and WebGL API details against the current official documentation before relying on them. Do not guess option names.
- Small commits that each leave the tests green. Do not add a dependency without saying why.
- Build only what the current phase's checklist asks for.

### How the rules are enforced

- **Constants.** `src/shared/config.ts` holds every value from the spec's "Defaults, in one place" table, plus the other fixed numbers the spec names. No other file may hard-code them. Import from config, and add new constants there.
- **Pure core.** `tsconfig.core.json` typechecks src/core and src/shared with ES libraries only and no `types`. So `document`, `window`, `process`, `performance` and `console` don't exist there. ESLint blocks `electron`, `@electron-toolkit/*` and Node built-in imports in the same folders. Test files (`*.test.ts`) and `src/core/testing/` are exempt.
- **Renderer pages.** The electron-vite renderer root is `src/`, with entries `src/overlay/index.html`, `src/dashboard/index.html` and `src/debug/index.html`. The main process loads them with `loadPage(win, 'overlay' | 'dashboard' | 'debug')`.
- **The status is never stored.** Protected, Smoothing and Protection off come from `deriveStatus` in `src/shared/status.ts`, re-derived from the latest heartbeat and its age. A new failure mode gets a rule there, with a test, that can only turn the status off.
- **The one exception to the constants rule: `tools/strobe`.** The strobe page must stay one static page with no build step and no dependencies, so it cannot import config. It copies the five detection thresholds it displays, and `tools/strobe/strobe.test.ts` asserts the copies still equal `src/shared/config.ts`. Keep that test passing rather than editing the copies by hand. The page's own logic lives in `tools/strobe/strobe.js` as a classic script so the test can load it; ESLint's TypeScript return-type rule is switched off for `tools/strobe/**/*.js`.

## Entire (we're entering MLH "Best Use of Entire")

Entire is enabled for Claude Code in this repo (`.entire/settings.json`, hooks in `.claude/settings.json`). It captures every Claude Code session, and each git commit gets a checkpoint linking it to the prompts and transcript that produced it. Checkpoints are stored as git refs (`refs/entire/checkpoints/...`) and upload automatically on `git push`. The repo is hosted on Entire as `et/calmframe/calmframe` (remote `origin`).

The spec says to start a fresh session for each phase, across two laptops. Entire carries the context between those sessions, so use it:

- **At the start of every session**, after reading the spec, search past sessions for the area you're about to touch: `entire search "<topic>" --json --compact`, then `entire checkpoint explain <id>` on the best hit. Once pushed, the other laptop's sessions show up here too. Use the `entire-search` skill. Do this instead of re-deriving decisions.
- **Before changing code you don't understand**, run `entire why <file>:<line>` to see the commit, prompt and session behind it.
- **Commit small and often, with messages that say why.** Each commit becomes a searchable checkpoint.
- **Push at least after every finished checklist item**, so the other laptop sees your work and checkpoints.
- **One trail per phase.** When starting a phase from `main`, create its trail and branch (e.g. title "Phase 0: overlay spike"). Run `entire agent-help trail create` for the exact flags first.
- **Don't guess Entire flags.** Run `entire agent-help`, then `entire agent-help <command>`, or use the `entire` skill.
- **Git Bash on Windows rewrites `/et/...` arguments into file paths.** Prefix those commands with `MSYS_NO_PATHCONV=1` (e.g. `MSYS_NO_PATHCONV=1 entire repo view /et/calmframe/calmframe`), or use PowerShell.
- **Don't** edit Entire's hooks (in `.claude/settings.json` or `.git/hooks`), delete `refs/entire/*`, or rewrite pushed history.
- **GitHub mirror, code only.** https://github.com/thisisjoey77/CalmFrame (remote `github`) is the public copy for Devpost and for the Coder workspaces. Entire's pre-push hook may upload session transcripts to whichever remote it is given, and the team decided transcripts stay on Entire. So push to GitHub only with `git push --no-verify github <branch>` (the user approved skipping the hook for this remote only), and never push `refs/entire/*` there. Pushes to `origin` (Entire) stay normal. Keep the two in step: after pulling work from one remote, push it to the other.
- **Ask first.** Commands the CLI marks as user-owned (`enable`, `configure`, `login`, `repo`, `project`, `org`) are for the user to run. Suggest them; don't run them unless asked.
- **Transcripts are uploaded with checkpoints.** Never put secrets, tokens or personal details in prompts or commits.

### Going for the prize: make the Entire story visible

We don't know the judging criteria yet (ask at the Saturday 4:30 PM MLH workshop, then update this section). Until then, aim for a history a judge can browse and a demo moment that shows it off:

- **Trails carry the plan.** Each phase's trail body states the goal and pastes that phase's checklist from the spec. When the checklist is ticked, mark the trail ready and merge through it rather than with a bare `git merge` (check `entire agent-help trail ready` and `entire agent-help trail merge` first).
- **Commit messages name the spec item they satisfy.** For example, "Phase 1: early mode fires on the third fast transition". Then `entire why <file>:<line>` goes from any line of the detector to the prompt, the session and the spec checkbox behind it. That makes a 20-second pitch moment: "every line traces back to the standard and the session that wrote it".
- **Log the moments Entire paid off.** When `entire search` or `entire why` changes what you do, add one line to `docs/ENTIRE-LOG.md`: date, laptop, query, what it changed. This is the evidence for the write-up, so keep it honest and don't pad it.
- **Before submission (Saturday night):**
  - Run `entire recap --week --static` and `entire dispatch` to draft the Devpost "How we built it" section.
  - Add a "Built with Entire" section to the README that links each phase's trail.

### Setting up the Mac (once)

1. Install the Entire CLI (https://docs.entire.com/installation), then run `entire login`. The repo owner grants access with `entire project grant add calmframe <provider>:<handle> --role writer`.
2. Clone with `entire repo clone /et/calmframe/calmframe`, then run `npm install`.
3. In the clone, run `entire enable --agent claude-code`. Git hooks aren't cloned, so this step reinstalls them. `entire status` should then show the repo as enabled.
4. Start Claude Code in the clone. Its first message should be "Read CLAUDE.md and docs/SPEC.md".

## Coder (we're entering the Coder for Good side challenge)

The challenge requires that we build, test and collaborate in Coder workspaces. The organizers host Coder at https://coder.c1.workshop.cdr.dev (GitHub sign-in, "Tech Stack Builder" template). The team workspace is `thisisjoey77/CalmFrame`. It clones the GitHub mirror into `~/CalmFrame`.

- **What runs there:** `src/core` and its tests, `tools/strobe` and `tools/validate` (Node, Python, ffmpeg). The overlay can't, because it needs the real Windows desktop. Say that plainly in the write-up.
- **Mac work happens in the workspace** where possible (core, validator, IRIS comparison), pushed from there to GitHub. Pull it on another machine and push it on to Entire, so both remotes match (see the GitHub mirror rule above).
- **From the Windows laptop, Claude Code drives the workspace with the Coder CLI** at `C:\Program Files\Coder\bin\coder.exe` (not on PATH; in Git Bash use `"/c/Program Files/Coder/bin/coder.exe"`). The user is logged in. If a command says otherwise, ask the user to run `& "C:\Program Files\Coder\bin\coder.exe" login https://coder.c1.workshop.cdr.dev` in their own terminal. Never ask for the session token in chat: transcripts are uploaded.
- **After pushing a branch to GitHub, run the test suite in the workspace and add a line to `docs/CODER-LOG.md`.** That log is the "tested in Coder" evidence. Node comes from nvm, which non-interactive shells don't load, and the tests don't need Electron:
  ```
  coder.exe ssh thisisjoey77/CalmFrame -- 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd ~/CalmFrame && git fetch -q origin && git checkout -q <branch> && git pull -q --ff-only origin <branch> && npm ci --ignore-scripts && npx vitest run'
  ```
- The workspace runs Node 26 and this laptop Node 24.12. The client/server version-mismatch warning (2.39 vs 2.38) is harmless.

## Safety and wording

- Nobody with known or suspected photosensitivity runs strobe tests. Use low-contrast test flashes by default, in short bursts, in a small window.
- In the README, Devpost, the UI and the pitch, never say "prevents seizures", "certified", "WCAG compliant" or "validated by EA". Say "reduces exposure", "implements the WCAG flash thresholds" and "compared against IRIS (Python port)".

## Decisions already made (do not undo without asking the user)

These were settled with the user on Sat Nov 14 after testing on the real screen. The spec has the reasoning and the numbers. If a later phase seems to need one changed, stop and ask.

- **The concurrency rule (spec Step 5a) is on by default.** Without it, scrolling, dragging and opening windows switched the overlay on constantly. A reversal only counts when a quarter of an area window reverses the same way in the same captured frame. See "Movement false triggers" in the spec and `src/core/motion.test.ts`.
  - **Keep the fallback reachable.** `concurrency: 'off'` is the detector as first specified, and the user asked for a switch back to it. Since Phase 5 it is the dashboard's "Ignore movement" switch (saved in the settings). Later phases must keep it.
  - **Do not loosen `CONCURRENCY_MAX_OPPOSING` (0.25).** At 0.35 and above, 3,000 px/s scrolling triggers again.
- **Some false triggers are accepted for now.** Very fast scrolling, fast camera turns in games, a tab switch that repaints three times, and lightning in video still trigger. The next lever is N = 4 on the Phase 5 sensitivity slider. A check for "the new frame is the old one shifted" was discussed and not built. Do not weaken the early trigger or the area rule to hide these.
- **The flash limit is a testing slider, and 3 stays the default (Sat Nov 14).** The user asked for it to try real content at 5 or 7 flashes a second. Spec: Step 7, "The flash limit".
  - **Above 3 the app no longer implements the WCAG threshold,** so the dashboard says so, and the limit goes back to 3 at every launch. Do not make a raised limit persist or become the default without asking.
  - **Never run a demo, a measurement or the IRIS comparison with it raised** unless the result says so. The validator does not use it.
- **The smoothing target is 0.07** (`TARGET_RESIDUAL`). At 0.08 one live reading was over WCAG's 0.10. The user chose 0.07 over 0.06 to keep motion trails shorter.
- **The dashboard sits above the overlay and is excluded from capture** (Phase 5 checklist).
- **The pre-arm (spec Step 7a, a teammate's work) stays off** (`PREARM_ENABLED = false`) unless the user asks for it. Asked again in Phase 5 (Sat Nov 14): the sensitivity slider has no pre-arm position, and the overlay still ignores pre-arm's outputs.
- **The one stretch is taken: brightness correction per region (Sat Nov 14, morning, trail #10).** This is the friend's proposal, in corrected form: show the current frame and scale each region's brightness to its running average, with no blending of old frames. The user asked for it before the 6 PM gate, after an offline test on a real clip. Spec: "Stretch: correct brightness per region".
  - **It is an experimental tick box, "Keep motion sharp", off by default.** The smoothing filter stays the default and must keep working. Do not make the new method the default without asking: the user has not yet checked it on screen.
  - **Its known weaknesses are pinned by tests** in `src/core/regionCorrect.test.ts`: a flickering rim at a hard edge, and no effect on detail finer than a cell. Do not delete those tests to make it look better.
  - **No further stretch.** Smoothing only the flashing region is not built: an offline test of a close relative gained almost nothing on action content.
- **Native capture is built and is the default (Sat Nov 14, morning).** This reversed the earlier "no native capture module this weekend". The user asked for it after Chromium's capture kept dipping under 45 fps, and approved making it the default after their strobe and red-flash checks passed. It uses Desktop Duplication, not Windows Graphics Capture (no yellow border, no cursor in the image). Chromium's capture stays as the automatic fallback and behind `CALMFRAME_NATIVE_CAPTURE=0`; keep both working. Never send pixels over IPC: only the shared-texture handle and a few numbers cross. Trail #9, "Native capture" in the spec.

## Open questions

- **Dashboard vs overlay stacking: decided (Sat Nov 14), built in Phase 5.** The dashboard sits above the overlay and is excluded from capture. One consequence is still open: a screen recorder can't see the dashboard or its protected-preview pane, so demo footage of them comes from the phone. Phase 5 built no recording switch.
