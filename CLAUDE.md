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

- `npm run dev`: run the app (Phase 3 state: the overlay is invisible and runs live detection, and the debug window shows the graph, timings and hazard log; Ctrl+Alt+Shift+C toggles the overlay, and closing the debug window quits; the debug window's "Ignore movement" box switches the Step 5a concurrency rule off and on, and off is the fallback to the detector as first specified)
- `CALMFRAME_DEBUG_TINT=1 npm run dev`: also shows the Phase 0 red tint on the overlay and runs the automatic capture-leak check
- `CALMFRAME_FPS_SWEEP=1 npm run dev`: measures the capture frame rate at each size cap with a moving test bar and logs a summary. Use it to check the demo-laptop setup.
- `npm test`: Vitest, run once (`npm run test:watch` to watch)
- `npm run typecheck`: three projects. core (src/core + src/shared, pure), node (main, preload, tests, tools), web (renderers)
- `npm run lint`
- `npm run build:win`: packaged Windows installer

Before every commit, `npm run typecheck && npm run lint && npm test` must pass.

**Demo-laptop setup (Phase 0 found the capture rate depends on it).** Display at 1920×1080 and 60 Hz, mains power, Turbo mode, discrete GPU off, and no other heavy apps. The native 2880×1800 screen only captures at about 24 fps. See "Phase 0 results" in the spec.

**Launching the app from Claude Code inside VS Code.** Its shells inherit `ELECTRON_RUN_AS_NODE=1` from VS Code. Electron then starts as plain Node and crashes with `Cannot read properties of undefined (reading 'isPackaged')`. Launch with `env -u ELECTRON_RUN_AS_NODE npm run dev` (Bash tool), or `Remove-Item Env:ELECTRON_RUN_AS_NODE; npm run dev` (PowerShell). A normal terminal doesn't need this.

## Working rules

- docs/SPEC.md is the source of truth. If the code must deviate, say so and update the spec in the same commit.
- src/core is pure TypeScript with no Electron, DOM or Node imports. Everything in it has unit tests.
- All per-frame work stays in the overlay renderer. Never send frames over IPC.
- Never assume the capture size. Read it from each frame (`video.videoWidth/videoHeight`) and size GPU textures from it, reallocating if it changes. The 960×540 cap is a Phase 0 tuning choice we expect to raise later (faster hardware, auto-tuning, or a native capture module).
- Timing logic uses capture timestamps, never frame counts.
- Fail open: on any error, hide the overlay and report "Protection off".
- Safety: never auto-play a strobe. Test content starts paused, low contrast and small, with an auto-stop.
- Check Electron and WebGL API details against the current official documentation before relying on them. Do not guess option names.
- Small commits that each leave the tests green. Do not add a dependency without saying why.
- Build only what the current phase's checklist asks for.

### How the rules are enforced

- **Constants.** `src/shared/config.ts` holds every value from the spec's "Defaults, in one place" table, plus the other fixed numbers the spec names. No other file may hard-code them. Import from config, and add new constants there.
- **Pure core.** `tsconfig.core.json` typechecks src/core and src/shared with ES libraries only and no `types`. So `document`, `window`, `process`, `performance` and `console` don't exist there. ESLint blocks `electron`, `@electron-toolkit/*` and Node built-in imports in the same folders. Test files (`*.test.ts`) and `src/core/testing/` are exempt.
- **Renderer pages.** The electron-vite renderer root is `src/`, with entries `src/overlay/index.html` and `src/dashboard/index.html`. The main process loads them with `loadPage(win, 'overlay' | 'dashboard')`.
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

## Open questions

- **Dashboard vs overlay stacking (decide before Phase 5).** While the overlay is solid, it covers the whole screen, including the dashboard. The judge would see a smoothed, lagging copy of the graph, the raw thumbnail smoothed to grey, and a "protected preview" that captures itself. Phase 0 showed the fix works: a window set always-on-top after the overlay, with content protection, sits above it and stays out of the capture (tested with the debug window's stacking checkbox). Waiting on the user's go-ahead before changing the spec.
