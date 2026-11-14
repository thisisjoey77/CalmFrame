/**
 * Every tunable number in CalmFrame lives here. No other file may hard-code these.
 * Source of truth: docs/SPEC.md, "Defaults, in one place". The section names in
 * the comments point back to where each value is defined or derived.
 *
 * Units: luminance values are linear relative luminance in 0..1, times are
 * milliseconds (capture timestamps), sizes are cells or pixels as named.
 */

// ---------------------------------------------------------------------------
// Defaults table ("Defaults, in one place")
// ---------------------------------------------------------------------------

/** Analysis grid width in cells. Step 2. */
export const GRID_COLS = 96
/** Analysis grid height in cells. Step 2. */
export const GRID_ROWS = 54
/** Total cells in the analysis grid (5,184). */
export const GRID_CELLS = GRID_COLS * GRID_ROWS

/** Minimum luminance reversal that counts as a transition. Step 4. */
export const LUMINANCE_THRESHOLD = 0.1
/** A transition only counts if the darker of its two states is below this. Step 4, rule 5. */
export const DARK_LIMIT = 0.8

/** Minimum change in the red value v that counts as a red transition. Step 3. */
export const RED_THRESHOLD = 20
/** Saturated red: R / (R + G + B) at or above this in at least one state. Step 3. */
export const RED_RATIO = 0.8

/** Max gap between transitions for them to extend a streak (1/6 s, rounded). Step 5. */
export const FAST_TRANSITION_INTERVAL_MS = 167
/** Window over which a cell's transition count c is taken. Step 5. */
export const COUNT_WINDOW_MS = 1000

export type TriggerMode = 'early' | 'strict'
/** Default trigger mode. Step 7. */
export const DEFAULT_TRIGGER_MODE: TriggerMode = 'early'
/** Early trigger: a cell is hot when its streak s reaches N. Step 7. */
export const EARLY_TRIGGER_STREAK = 3

/**
 * The concurrency rule, Step 5a: which reversals count as transitions.
 * - 'one-way': only reversals that at least AREA_LIMIT of some area window makes in the
 *   same captured frame and the same direction. Scrolling and dragging make cells reverse
 *   one after another and both ways at once, so they stop counting.
 * - 'off': every reversal counts, the detector as first specified. The fallback.
 */
export type ConcurrencyRule = 'one-way' | 'off'
export const DEFAULT_CONCURRENCY_RULE: ConcurrencyRule = 'one-way'
/** One-way rule: reversals the other way, in the same window and frame, may number at most
 *  this share of the reversals being counted. Step 5a. */
export const CONCURRENCY_MAX_OPPOSING = 0.25

/** Hazard when hot cells fill at least this fraction of some window. Step 6. */
export const AREA_LIMIT = 0.25
/** WCAG window size as a fraction of the grid in each direction. Step 6. */
export const AREA_WINDOW_FRACTION = 1 / 3
/** WCAG window width in cells (32). */
export const AREA_WINDOW_COLS = Math.round(GRID_COLS * AREA_WINDOW_FRACTION)
/** WCAG window height in cells (18). */
export const AREA_WINDOW_ROWS = Math.round(GRID_ROWS * AREA_WINDOW_FRACTION)

/** Target residual swing after smoothing, under WCAG's 0.10. "Choosing alpha". */
export const TARGET_RESIDUAL = 0.07
/** Smallest alpha allowed; below this the image smears. "Choosing alpha". */
export const ALPHA_MIN = 0.03
/** Largest alpha allowed during a hazard. "Choosing alpha". */
export const ALPHA_MAX = 0.3
/** Alpha used while safe, keeping the filter warm. "Three implementation requirements". */
export const ALPHA_WARM = 0.25

/** Brightness scale d never goes below this. "Dimming covers what smoothing cannot". */
export const DIM_MIN = 0.4

/** Active state is held until no hazard for this long. "On fast, off slow". */
export const HOLD_MS = 1500
/** Release fade duration. "On fast, off slow". */
export const FADE_MS = 750

/** Overlay renderer heartbeat interval. "Safety mechanisms". */
export const HEARTBEAT_MS = 250
/** Main process hides the overlay after this much heartbeat silence. "Safety mechanisms". */
export const WATCHDOG_MS = 750

/** Requested capture frame rate. "Capture requirements". */
export const CAPTURE_FPS = 60
/** Capture resolution cap. "Capture requirements". Lowered from the spec's original
 *  1920x1080 in Phase 0: only 960x540 held >= 50 fps on the demo laptop (see the spec's
 *  "Phase 0 results"). Detection is unaffected (96x54 grid); the smoothed copy is softer. */
export const CAPTURE_MAX_WIDTH = 960
export const CAPTURE_MAX_HEIGHT = 540

// ---------------------------------------------------------------------------
// Other fixed values the spec names outside the defaults table
// ---------------------------------------------------------------------------

/** Pre-arm (Step 7a), an optional state ahead of the early trigger that starts smoothing on
 *  the first reversal instead of the third. Off by default: arming on a single reversal also
 *  arms on scene cuts and alt-tab, which costs about half a second of softening on ordinary
 *  use. It belongs at the most sensitive end of the Phase 5 slider, past N = 2. */
export const PREARM_ENABLED = false
/** A cell is armed at this streak. 1 is the early trigger with N = 1, so arming inherits the
 *  dark limit and the frame-gap streak reset. Step 7a. */
export const PREARM_TRIGGER_STREAK = 1
/** Filter strength while armed. The "How much flicker survives" table's 0.15 row: it leaves
 *  0.24 of a full-contrast 10 Hz swing, about a quarter of the exposure. Still a flash by
 *  the standard, which is what Active's adaptive alpha is for. Step 7a. */
export const PREARM_ALPHA = 0.15
/** Overlay opacity while armed. Showing the whole smoothed copy rather than blending: at 0.5
 *  the live screen re-admits its own swing (0.5 x 1.0 + 0.5 x 0.24 = 0.62), so partial
 *  transparency would barely help. Step 7a. */
export const PREARM_OPACITY = 1
/** Pre-arm's fade back to Safe. Shorter than the release fade, since pre-arm is not
 *  protecting anything by the time it starts. Step 7a. */
export const PREARM_FADE_MS = 300
/** Longest a single armed episode may last. One counting window: if the trigger has not
 *  fired within the window the detector measures over, there is nothing to wait for. Bounds
 *  cases that keep a window freshly armed without any cell reaching the trigger, such as a
 *  moving flashing band. Step 7a. */
export const PREARM_MAX_MS = 1000
/** Arm must have been absent this long before pre-arm may arm again, so that sustained
 *  sub-trigger flashing gets one episode at its leading edge and nothing after. Matches
 *  TRACKER_IDLE_RESET_MS, the time a cell takes to return to idle. Step 7a. */
export const PREARM_REARM_QUIET_MS = 1000

/** Scale for the red value v = RED_SCALE * max(0, R - G - B). Step 3. */
export const RED_SCALE = 320

/** sRGB decoding (Step 1): channel values (0..1) at or below the cutoff are on the linear
 *  segment, divided by the slope; above it, ((C + offset) / (1 + offset)) ^ gamma. */
export const SRGB_LINEAR_CUTOFF = 0.04045
export const SRGB_LINEAR_SLOPE = 12.92
export const SRGB_OFFSET = 0.055
export const SRGB_GAMMA = 2.4
/** Relative luminance weights for linear R, G and B. Step 1. */
export const LUMA_R = 0.2126
export const LUMA_G = 0.7152
export const LUMA_B = 0.0722

/** Per-cell ring of transition times behind the 1 s count c. A cell records at most one
 *  transition per frame, so 64 covers 60 fps capture; faster input saturates c at 64. */
export const TRACKER_RING_CAPACITY = 64

/** Flash size dL is this percentile of swing over hot cells. Step 8. */
export const FLASH_SIZE_PERCENTILE = 0.9

/** IRIS extended failure, validator only ("Test clips"): a 1 s transition count in
 *  [MIN, MAX] over the area limit, sustained for EXTENDED_FAIL_MS within any
 *  EXTENDED_FAIL_WINDOW_MS. Above MAX is an outright failure (the strict trigger). */
export const EXTENDED_FAIL_MIN_TRANSITIONS = 4
export const EXTENDED_FAIL_MAX_TRANSITIONS = 6
export const EXTENDED_FAIL_MS = 4000
export const EXTENDED_FAIL_WINDOW_MS = 5000
/** Frames remembered for the extended-failure window (5 s at up to ~200 fps). */
export const EXTENDED_FAIL_RING_CAPACITY = 1024

/** Strict trigger: a cell is hot when its 1 s count c reaches this. Step 7. */
export const STRICT_TRIGGER_COUNT = 7
/** Sensitivity slider steps for N; the step after the last is strict mode. Step 7. */
export const SENSITIVITY_STREAK_STEPS: readonly number[] = [2, 3, 4]

/** A cell with no transition for this long returns to idle. Step 4, rule 6. */
export const TRACKER_IDLE_RESET_MS = 1000
/** A frame gap longer than this resets all streaks. "Known behaviour at the edges". */
export const FRAME_GAP_RESET_MS = 250

/** Width of the visual field the WCAG area rule is defined on, in degrees. Step 6. */
export const VISUAL_FIELD_DEGREES = 10
/** Calibrated area mode: viewing distance used when none is set (the spec's example). Step 6. */
export const DEFAULT_VIEWING_DISTANCE_CM = 60

export type AreaMode = 'wcag' | 'calibrated' | 'iris'
/** Default area mode. Step 6. */
export const DEFAULT_AREA_MODE: AreaMode = 'wcag'

/** Flashes-per-second limit line drawn on the hazard graph. Step 8. */
export const GRAPH_LIMIT_FLASHES_PER_SEC = 3

/** Blend toward grey applied to the output during a red hazard. "Red flashes". */
export const RED_DESATURATION = 0.5

/** Warn in the dashboard when capture falls below this rate. "Known behaviour at the edges". */
export const LOW_FPS_WARNING = 45

/** Send stats and the grid thumbnail to the dashboard every N frames. "The per-frame loop". */
export const STATS_EVERY_N_FRAMES = 3

/** Raw-input thumbnail size cap in device pixels, under the area limit at 1080p. Phase 5. */
export const THUMBNAIL_MAX_WIDTH = 240
export const THUMBNAIL_MAX_HEIGHT = 135

/** The overlay stops this many DIP short of the bottom of the display. A topmost window
 *  that exactly covers the monitor makes Windows treat it as a fullscreen app and hide the
 *  taskbar. One uncovered row is far below any flash-area limit. Found in Phase 0. */
export const OVERLAY_BOTTOM_INSET = 1

/** Global shortcut that moves to Disabled and hides the overlay. "Safety mechanisms". */
export const KILL_SWITCH_ACCELERATOR = 'Control+Alt+Shift+C'

// ---------------------------------------------------------------------------
// Phase 3: live detection
// ---------------------------------------------------------------------------

/** Step 2 acceptance: a 1-pixel black and white checkerboard averages to this Y in linear
 *  light (point-sampling the gamma-encoded values would give 0.21). */
export const CHECKERBOARD_Y = 0.5
/** Pass A startup self-test sizes: whole pixels per cell (960x540, 1920x1080) and a
 *  fractional number (1366x768 is 14.23 x 14.22 pixels per cell). */
export const GRID_SELF_TEST_SIZES: readonly { width: number; height: number }[] = [
  { width: 960, height: 540 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 }
]
/** Largest allowed |Y - CHECKERBOARD_Y| in any cell. Whole-pixel cells read exactly 0.5.
 *  Fractional cells can be off by half a pixel's share of the cell: 0.0025 at 1366x768. */
export const GRID_SELF_TEST_CHECKER_TOLERANCE = 0.005
/** Noise image for the GPU-versus-CPU check, fractional cells in both directions. */
export const GRID_SELF_TEST_NOISE_SIZE = { width: 1366, height: 771 }
/** Largest allowed difference, per cell and channel, between the GPU and CPU grids. */
export const GRID_SELF_TEST_MAX_DIFF = 1e-3

/** Grid read-backs that may be in flight at once. Read-back is asynchronous (a pixel buffer
 *  and a fence) because a synchronous readPixels waited a whole vsync, about 17 ms,
 *  whenever another window of the app was animating (Phase 3). The GPU normally finishes
 *  within a frame, so 3 is headroom. When all are busy the new frame is skipped, so the
 *  main thread never waits for the GPU. */
export const GRID_READBACK_SLOTS = 3

/** Phase 3 budget for analysis per frame: upload, Pass A, read-back, detector, state. */
export const ANALYSIS_BUDGET_MS = 4
/** Analysis-time median and 95th percentile are taken over this many recent frames. */
export const ANALYSIS_STATS_WINDOW = 120

// ---------------------------------------------------------------------------
// Phase 4: smoothing overlay
// ---------------------------------------------------------------------------

/** Startup self-test of Passes B and C: a generated image goes through linearise, the
 *  half-float state and re-encoding, and each output byte must be within this many 8-bit
 *  codes of the CPU twin's value. */
export const SMOOTH_SELF_TEST_TOLERANCE = 1
/** Self-test image size: every 8-bit code across, a few distinct rows down so a flipped
 *  picture is caught. */
export const SMOOTH_SELF_TEST_WIDTH = 256
export const SMOOTH_SELF_TEST_HEIGHT = 8
/** The self-test's filter step, dim and opacity: arbitrary values away from 0 and 1, so a
 *  pass that ignores any of them fails. */
export const SMOOTH_SELF_TEST_ALPHA = 0.25
export const SMOOTH_SELF_TEST_DIM = 0.5
export const SMOOTH_SELF_TEST_OPACITY = 0.5

/** Viewer check: the residual swing of what the viewer sees is the peak-to-peak luminance
 *  of each cell over the last COUNT_WINDOW_MS, kept as this many blocks, so the window
 *  slides in steps of COUNT_WINDOW_MS / RESIDUAL_BLOCKS. */
export const RESIDUAL_BLOCKS = 4

// ---------------------------------------------------------------------------
// Phase 5: dashboard and controls
// ---------------------------------------------------------------------------

/** The status reads "Protection off" when the overlay has had no captured frame for this
 *  long. Chromium captures on a cadence and delivers a frame even when nothing on screen
 *  changed (Phase 5 measurement: up to 19 of 45 frames a second were identical to the one
 *  before, and the longest gap between frames was 49 ms), so a still screen never looks
 *  stalled. Four times the frame-gap streak reset. */
export const FRAME_STALE_MS = 1000
/** The dashboard and the tray re-derive the status this often, so heartbeats that stop
 *  arriving turn the status off within WATCHDOG_MS plus this. */
export const STATUS_REFRESH_MS = HEARTBEAT_MS

/** The sensitivity slider shows the spec's Step 7 prediction of flashes seen before
 *  smoothing starts, F = (N - 1) / 2 + f L, for this strobe and this pipeline latency.
 *  A prediction until the Phase 6 slow-motion measurement replaces it. */
export const SLIDER_EXAMPLE_HZ = 10
export const SLIDER_EXAMPLE_LATENCY_MS = 75

/** The thumbnails are also no wider (and no taller) than this share of the screen, in
 *  device pixels: 240 of 1920. The WCAG window is AREA_WINDOW_FRACTION of the screen each
 *  way and the area limit is a quarter of it, so anything under sqrt(AREA_LIMIT) x
 *  AREA_WINDOW_FRACTION = 1/6 each way stays under the limit, on any screen. */
export const THUMBNAIL_MAX_SCREEN_FRACTION = 1 / 8
/** Entries in the linear-to-sRGB table that encodes the thumbnails. 4096 keeps every
 *  value within one 8-bit code of the exact formula. */
export const THUMBNAIL_LUT_SIZE = 4096

/** Flash events (the dashboard's log and counter): hazards closer together than this are
 *  one event. It is how long the overlay stays up after the last hazard frame (the hold
 *  plus the fade), so with protection on, one event is one smoothing episode. */
export const FLASH_EVENT_MERGE_MS = HOLD_MS + FADE_MS
/** Per-frame frequency estimates kept for an event. Its frequency is their median, because
 *  the estimate is inflated at the edges of a burst (Phase 3 results). */
export const FLASH_EVENT_FREQUENCY_SAMPLES = 600
/** Event log lines kept in the dashboard. */
export const EVENT_LOG_MAX = 200

/** The low capture-rate warning stays up this long after the last reading under
 *  LOW_FPS_WARNING, so a rate hovering around the line does not make it come and go. */
export const LOW_FPS_WARNING_HOLD_MS = 5000

/** Dashboard window size in DIP, its smallest size, and its distance from the edges of the
 *  work area when placed for the first time (top right). */
export const DASHBOARD_WIDTH = 460
export const DASHBOARD_HEIGHT = 820
export const DASHBOARD_MIN_WIDTH = 380
export const DASHBOARD_MIN_HEIGHT = 420
export const DASHBOARD_MARGIN = 16
/** Dashboard graph: time span shown, and the smallest top of its y axis. */
export const DASHBOARD_GRAPH_WINDOW_MS = 30000
export const DASHBOARD_GRAPH_MIN_Y_MAX = 12

/** Settings file, in the app's userData folder, and how long after a change it is written
 *  (a slider dragged across its range writes once). */
export const SETTINGS_FILE_NAME = 'settings.json'
export const SETTINGS_SAVE_DELAY_MS = 500

/** Tray icon: size in pixels at scale factor 1, and the scale factors it is drawn for. */
export const TRAY_ICON_BASE_SIZE = 16
export const TRAY_ICON_SCALES: readonly number[] = [1, 1.25, 1.5, 2]

// ---------------------------------------------------------------------------
// Debug tooling: overlay watchdog test
// ---------------------------------------------------------------------------

/** Hidden debug command (dev builds only): freezes the overlay renderer's main thread so
 *  the watchdog can be tested. Not shown in any UI. */
export const DEBUG_FREEZE_ACCELERATOR = 'Control+Alt+Shift+F'
/** How long the debug freeze blocks the renderer. Long enough for the watchdog to fire
 *  well before it ends, short enough that the app recovers by itself. */
export const DEBUG_FREEZE_MS = 5000

// ---------------------------------------------------------------------------
// Phase 0 spike and debug tooling (not product behaviour)
// ---------------------------------------------------------------------------

/** Debug window graph: time span shown, and the smallest top of its y axis, in flashes
 *  per second (a 10 Hz strobe reads about 10). */
export const DEBUG_GRAPH_WINDOW_MS = 20000
export const DEBUG_GRAPH_MIN_Y_MAX = 12
/** Hazard start and end lines kept in the debug window. */
export const DEBUG_HAZARD_LOG_MAX = 100

/** Opacity of the red tint the overlay shows during the Phase 0 spike. */
export const DEBUG_TINT_OPACITY = 0.3
/** Phase 0 pass bar for capture rate on moving content. */
export const PHASE0_MIN_FPS = 50

/** Capture size caps the debug window can switch between, to find one that reaches 50 fps. */
export const DEBUG_CAPTURE_SIZES: readonly { maxWidth: number; maxHeight: number }[] = [
  { maxWidth: 1920, maxHeight: 1080 },
  { maxWidth: 1280, maxHeight: 720 },
  { maxWidth: 960, maxHeight: 540 }
]
/** FPS sweep (env CALMFRAME_FPS_SWEEP=1): wait before starting, then per size a warm-up
 *  and a measuring period. */
export const FPS_SWEEP_LEAD_MS = 15000
export const FPS_SWEEP_WARMUP_MS = 3000
export const FPS_SWEEP_MEASURE_MS = 9000
/** Capture frame rate is counted over this rolling window. */
export const FPS_WINDOW_MS = 1000
/** Capture-delay median and 95th percentile are taken over this many recent frames. */
export const DELAY_STATS_WINDOW = 120
/** Main process logs capture stats to the terminal at most this often. */
export const DEBUG_LOG_INTERVAL_MS = 1000

/** Capture-leak self-check: toggle the tint off/on this many times. */
export const SELF_CHECK_CYCLES = 3
/** Wait after toggling the tint before sampling (protection applies on the next composition). */
export const SELF_CHECK_SETTLE_MS = 300
/** Samples of the captured frame per state, and their spacing. */
export const SELF_CHECK_SAMPLES = 8
export const SELF_CHECK_SAMPLE_INTERVAL_MS = 50
/** Sampling canvas size; only the average colour matters. */
export const SELF_CHECK_CANVAS_WIDTH = 64
export const SELF_CHECK_CANVAS_HEIGHT = 40
/** Red-ratio change (tint on minus off) that means the tint is in the capture. A leak of a
 *  30% red tint moves it by about 0.08 on a white screen and more on darker ones. */
export const SELF_CHECK_LEAK_DELTA = 0.03
/** Red-ratio change below which a cycle counts as clean. */
export const SELF_CHECK_CLEAN_DELTA = 0.01
/** A sampled pixel is near black when all channels are at or below this (0..255). */
export const SELF_CHECK_BLACK_LEVEL = 3
/** The capture counts as a black rectangle when this share of pixels is near black. */
export const SELF_CHECK_BLACK_FRACTION = 0.95

// ---------------------------------------------------------------------------
// Phase 6: validator (tools/validate)
// ---------------------------------------------------------------------------

/** The synthetic test clips ("Test clips"): 10-second 1080p60 files with a 3-second steady
 *  lead-in, so the ground truth is known by construction. */
export const VALIDATE_CLIP_MS = 10000
export const VALIDATE_CLIP_LEAD_IN_MS = 3000
export const VALIDATE_CLIP_FPS = 60
export const VALIDATE_CLIP_WIDTH = 1920
export const VALIDATE_CLIP_HEIGHT = 1080
/** x264 quality for the clips: near lossless, so the greys keep their levels within a code
 *  or two, while staying in the High profile every decoder reads. */
export const VALIDATE_CLIP_CRF = 4
/** Verdicts are compared one second at a time ("Comparison with IRIS", step 4). */
export const VALIDATE_SECOND_MS = 1000

// ---------------------------------------------------------------------------
// Stretch: native screen capture (native/capture, trail #9)
// ---------------------------------------------------------------------------

/** Environment variable that switches the overlay to the native capture module
 *  (Desktop Duplication into shared textures) instead of Chromium's screen capture. */
export const NATIVE_CAPTURE_ENV = 'CALMFRAME_NATIVE_CAPTURE'
/** Desktop Duplication only delivers a frame when the screen changed. When nothing has
 *  changed for this long, the module sends the latest frame again, so detection and the
 *  smoothing filter keep sampling at a steady rate, as with Chromium's capture. Just over
 *  one 60 Hz frame (16.7 ms), so a screen that changes every frame gets no repeats. */
export const NATIVE_CAPTURE_REPEAT_MS = 20
