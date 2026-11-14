# CalmFrame: rules for Claude Code

CalmFrame is a Windows desktop app (Electron + TypeScript) that watches the whole screen, detects flashing that breaks the WCAG 2.3.1 flash thresholds, and covers it with a smoothed copy. We're building it at EmoryHacks 2026 (Nov 13 to 15).

**Read docs/SPEC.md in full before doing anything.** It is the source of truth for the math, the architecture, the default values and the acceptance criteria. Each build phase has a checklist under "Build plan", and its prompt is under "Claude Code prompts".

## Team and machines

The spec's four roles (A to D) collapse to two laptops. Windows 11 is the only target OS.

| Laptop | Owns | Notes |
| --- | --- | --- |
| Windows 11 (demo machine) | src/main, src/preload, src/overlay, src/dashboard, the tray, all live testing | The only place the app runs. Overlay, capture exclusion, GPU passes and anything Electron does at runtime are verified here and nowhere else. |
| Mac | src/core and its tests, tools/strobe, tools/validate, measurements | Pure TypeScript, Vitest, a static HTML page and the validator CLI. Never report an overlay, capture or Electron feature as working from a Mac run. Hand on-screen checks to the Windows laptop with exact steps. |

- One branch per phase (e.g. `phase0-overlay`, `phase1-core`). Merge to `main` when that phase's checklist is ticked and checks are green.
- The two laptops' folders don't overlap. The first real merge point is Phase 3, when core is wired into the overlay.

## Commands

- `npm run dev`: run the app (currently opens an empty dashboard window)
- `npm test`: Vitest, run once (`npm run test:watch` to watch)
- `npm run typecheck`: three projects. core (src/core + src/shared, pure), node (main, preload, tests, tools), web (renderers)
- `npm run lint`
- `npm run build:win`: packaged Windows installer

Before every commit, `npm run typecheck && npm run lint && npm test` must pass.

**Launching the app from Claude Code inside VS Code.** Its shells inherit `ELECTRON_RUN_AS_NODE=1` from VS Code. Electron then starts as plain Node and crashes with `Cannot read properties of undefined (reading 'isPackaged')`. Launch with `env -u ELECTRON_RUN_AS_NODE npm run dev` (Bash tool), or `Remove-Item Env:ELECTRON_RUN_AS_NODE; npm run dev` (PowerShell). A normal terminal doesn't need this.

## Working rules

- docs/SPEC.md is the source of truth. If the code must deviate, say so and update the spec in the same commit.
- src/core is pure TypeScript with no Electron, DOM or Node imports. Everything in it has unit tests.
- All per-frame work stays in the overlay renderer. Never send frames over IPC.
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
- **Ask first.** Commands the CLI marks as user-owned (`enable`, `configure`, `login`, `repo`, `project`, `org`) are for the user to run. Suggest them; don't run them unless asked.
- **Transcripts are uploaded with checkpoints.** Never put secrets, tokens or personal details in prompts or commits.

### Setting up the Mac (once)

1. Install the Entire CLI (https://docs.entire.com/installation), then run `entire login`. The repo owner grants access with `entire project grant add calmframe <provider>:<handle> --role writer`.
2. Clone with `entire repo clone /et/calmframe/calmframe`, then run `npm install`.
3. In the clone, run `entire enable --agent claude-code`. Git hooks aren't cloned, so this step reinstalls them. `entire status` should then show the repo as enabled.
4. Start Claude Code in the clone. Its first message should be "Read CLAUDE.md and docs/SPEC.md".

## Safety and wording

- Nobody with known or suspected photosensitivity runs strobe tests. Use low-contrast test flashes by default, in short bursts, in a small window.
- In the README, Devpost, the UI and the pitch, never say "prevents seizures", "certified", "WCAG compliant" or "validated by EA". Say "reduces exposure", "implements the WCAG flash thresholds" and "compared against IRIS (Python port)".

## Open questions (settle in the phase named)

- **Dashboard vs overlay stacking (Phase 0, then Phase 5).** While the overlay is solid, it covers the whole screen, including the dashboard. The judge would then see a smoothed, lagging copy of the graph. The "raw input" thumbnail would be smoothed to grey. And the "protected preview" pane would capture itself. Proposed fix: give the dashboard content protection too, and keep it above the overlay. In Phase 0, check whether two always-on-top windows can be ordered reliably on Windows. Don't change the spec until the user agrees.
