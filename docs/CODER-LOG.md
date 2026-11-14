# Built and tested in Coder

Evidence for the Coder for Good challenge: one line per run of the test suite (or other real work) inside the team's Coder workspace, `thisisjoey77/CalmFrame` on the organizers' deployment. The Electron overlay itself is built on the Windows demo laptop, because it needs the real Windows desktop; everything platform-independent runs here too.

| When | Commit | What ran in the workspace | Result |
| --- | --- | --- | --- |
| Fri Nov 13, 11:15 PM | `7b86c62` (Phase 3 merged) | Pulled `main`, `npm ci --ignore-scripts`, `npx vitest run` on Node 26.13 | 11 files, 155 tests passed in 6.4 s |
| Sat Nov 14, 12:40 AM | `d18c7e0` (branch `motion-flip-gate`, Step 5a) | Pulled the branch, `npm ci --ignore-scripts`, `npx vitest run` on Node 26.13 | 14 files, 197 tests passed in 11.5 s, including the 34 new movement and concurrency tests |
| Sat Nov 14, 1:08 AM | `f0388b4` (branch `phase-4-smoothing-overlay`, target residual 0.07 and Phase 4 results) | Pulled the branch, `npm ci --ignore-scripts`, `npx vitest run` on Node 26.13 | 14 files, 197 tests passed in 11.3 s |
| Sat Nov 14, 1:25 AM | `45cc1e5` (`main`: Phase 4 merged, plus the pre-arm merge from GitHub) | Pulled `main`, `npm ci --ignore-scripts`, `npx vitest run` on Node 26.13 | 15 files, 221 tests passed |
