# Latency and capture rate from the app's own log

Sat Nov 14, 7:00 AM, Windows demo laptop. Demo setup: 1920×1080 at 60 Hz, mains power (100%), High performance power plan, integrated AMD Radeon 890M only. CalmFrame was on default settings: early trigger N = 3, Ignore movement on. Capture was capped at 960×540, with VS Code and the browser (showing the strobe page) still open.

The run lasted 201 s, with five low-contrast strobe bursts (5, 10, 10, 15 and 15 Hz, 0.2 swing). All five were detected and smoothed. The overlay drew 1,281 frames, and no frame was skipped because the pipeline was busy.

## Latency per stage (ms)

The app logs one line per second, and each line gives the median and p95 over the last 120 captured frames. Each value below is the median of those per-second figures across the run, with the range in brackets.

| Stage | Median | p95 |
| --- | --- | --- |
| Captured → frame callback | 7.5 (0.7 to 9.5) | 15.4 (4.1 to 16.4) |
| Callback → grid ready (GPU round trip) | 5.7 (5.5 to 12.0) | 10.2 (6.9 to 12.2) |
| Grid → decision | 0.2 (0.1 to 1.8) | 0.4 (0.3 to 2.7) |
| Captured → decision | 13.8 (10.9 to 16.2) | 21.9 (17.9 to 23.1) |
| Decision → overlay drawn | 4.8 (4.8 to 5.3) | 5.9 (5.7 to 6.5) |
| **Captured → overlay drawn** | **20.4** (19.3 to 21.2) | **28.0** (26.5 to 29.9) |

The 25 log lines taken while the overlay was smoothing give the same picture: captured → drawn 20.2 median, 27.8 p95.

These figures understate the true delay. Chromium stamps `captureTime` late (Phase 0), and the time for the drawn frame to reach the glass is not included. The end-to-end number comes from the slow-motion footage.

## Capture rate (fps, one reading per second)

| Part of the run | Seconds | Median | 10th percentile | Range | Seconds under 45 |
| --- | --- | --- | --- | --- | --- |
| Whole run | 201 | 50 | 44 | 39 to 59 | 30 (15%) |
| While smoothing | 25 | 49 | 44 | 41 to 58 | 3 (12%) |

Phase 0 measured a mean of 54 fps (range 44 to 59) on the same setup, using a moving test bar and no other apps. The dashboard's warning shows when any one-second reading is under 45 and then stays up for 5 s, so it was visible for about 47% of this run. A 5 s rolling mean dropped under 45 for only 13 s, with a lowest value of 43.2.
