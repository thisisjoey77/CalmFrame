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

/** Hazard when hot cells fill at least this fraction of some window. Step 6. */
export const AREA_LIMIT = 0.25
/** WCAG window size as a fraction of the grid in each direction. Step 6. */
export const AREA_WINDOW_FRACTION = 1 / 3
/** WCAG window width in cells (32). */
export const AREA_WINDOW_COLS = Math.round(GRID_COLS * AREA_WINDOW_FRACTION)
/** WCAG window height in cells (18). */
export const AREA_WINDOW_ROWS = Math.round(GRID_ROWS * AREA_WINDOW_FRACTION)

/** Target residual swing after smoothing, under WCAG's 0.10. "Choosing alpha". */
export const TARGET_RESIDUAL = 0.08
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
/** Capture resolution cap. "Capture requirements". */
export const CAPTURE_MAX_WIDTH = 1920
export const CAPTURE_MAX_HEIGHT = 1080

// ---------------------------------------------------------------------------
// Other fixed values the spec names outside the defaults table
// ---------------------------------------------------------------------------

/** Scale for the red value v = RED_SCALE * max(0, R - G - B). Step 3. */
export const RED_SCALE = 320

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

/** Raw-input thumbnail size cap, under the area limit at 1080p. Phase 5. */
export const THUMBNAIL_MAX_WIDTH = 240
export const THUMBNAIL_MAX_HEIGHT = 135

/** Global shortcut that moves to Disabled and hides the overlay. "Safety mechanisms". */
export const KILL_SWITCH_ACCELERATOR = 'Control+Alt+Shift+C'

// ---------------------------------------------------------------------------
// Phase 0 spike and debug tooling (not product behaviour)
// ---------------------------------------------------------------------------

/** Opacity of the red tint the overlay shows during the Phase 0 spike. */
export const DEBUG_TINT_OPACITY = 0.3
/** Phase 0 pass bar for capture rate on moving content. */
export const PHASE0_MIN_FPS = 50

/** The debug window's own capture preview, kept small and slow so it barely loads the real capture. */
export const DEBUG_PREVIEW_FPS = 15
export const DEBUG_PREVIEW_MAX_WIDTH = 480

/** Capture size caps the debug window can switch between, to find one that reaches 50 fps. */
export const DEBUG_CAPTURE_SIZES: readonly { maxWidth: number; maxHeight: number }[] = [
  { maxWidth: CAPTURE_MAX_WIDTH, maxHeight: CAPTURE_MAX_HEIGHT },
  { maxWidth: 1280, maxHeight: 720 },
  { maxWidth: 960, maxHeight: 540 }
]
/** FPS sweep (env CALMFRAME_FPS_SWEEP=1): wait before starting, then per size a warm-up
 *  and a measuring period. */
export const FPS_SWEEP_LEAD_MS = 10000
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
