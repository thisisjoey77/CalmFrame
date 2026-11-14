# Built and tested in Coder

Evidence for the Coder for Good challenge: one line per run of the test suite (or other real work) inside the team's Coder workspace, `thisisjoey77/CalmFrame` on the organizers' deployment. The Electron overlay itself is built on the Windows demo laptop, because it needs the real Windows desktop; everything platform-independent runs here too.

| When | Commit | What ran in the workspace | Result |
| --- | --- | --- | --- |
| Fri Nov 13, 11:15 PM | `7b86c62` (Phase 3 merged) | Pulled `main`, `npm ci --ignore-scripts`, `npx vitest run` on Node 26.13 | 11 files, 155 tests passed in 6.4 s |
