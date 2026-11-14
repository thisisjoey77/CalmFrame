# Where Entire changed what we did

One line each time `entire search`, `entire why` or a checkpoint changed a decision or saved rework. Evidence for the "Best Use of Entire" write-up, so only real entries.

| When | Laptop | Query or command | What it changed |
| --- | --- | --- | --- |
| Fri Nov 13, 11:10 PM | Mac | `entire search "pre-arm"`, `"early mode"`, `"detector state machine"` | "pre-arm" matched only the unmerged `phase-3-live-detection` branch, so there was no earlier decision to honour and the design was settled from SPEC.md rather than re-derived from a past session. It also pointed at that branch before it reaches main: diffing it showed its `src/shared/config.ts` additions sit right after `KILL_SWITCH_ACCELERATOR`, so the pre-arm constants went near the trigger block instead, and Step 7a went in as one contiguous block between Steps 7 and 8, away from the protection-mode and latency text that session owns. |
| Fri Nov 13, 11:30 PM | Mac | `entire search "strobe test page"`, `"Phase 1"`, `"detector core tracker luminance"` | Showed Phase 1 had pushed nothing yet, so the strobe page's luminance helper was written against SPEC.md Step 1 with a reference-implementation test standing in for `src/core/luminance.ts`, instead of waiting on the other laptop or guessing at its API. |
| Fri Nov 13, 10:33 PM | Windows | `entire search "discrete GPU"`, then `entire checkpoint explain` on the Phase 0 cap commit | Asked whether the RTX 5070 Ti would cut latency. The Phase 0 session had already weighed the dGPU-direct (Ultimate) mode, never tested it, and found capture is limited by CPU-side copying, so the answer became "one A/B test with the sweep" instead of a re-derivation or a switch to the dGPU. |
