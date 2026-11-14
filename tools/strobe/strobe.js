/**
 * CalmFrame strobe test page: every piece of pure logic the page needs.
 *
 * Loaded by index.html as a classic script, so the page stays one static page with no
 * build step and no dependencies (docs/SPEC.md, "Prompt 4: strobe test page"). A static
 * page cannot import src/shared/config.ts, so the five detection thresholds below are
 * copied from it. tools/strobe/strobe.test.ts asserts the copies still match, which keeps
 * config.ts the source of truth without an import. See CLAUDE.md, "How the rules are
 * enforced", and the note under the Phase 2 checklist in docs/SPEC.md.
 *
 * The luminance and red math is docs/SPEC.md "Detection math", Steps 1 and 3.
 */
;(function (global) {
  'use strict'

  // -------------------------------------------------------------------------
  // Detection thresholds. Copied from src/shared/config.ts; see the note above.
  // -------------------------------------------------------------------------

  /** Minimum luminance reversal that counts as a transition. Step 4. */
  const LUMINANCE_THRESHOLD = 0.1
  /** A transition only counts if the darker of its two states is below this. Step 4, rule 5. */
  const DARK_LIMIT = 0.8
  /** Minimum change in the red value v that counts as a red transition. Step 3. */
  const RED_THRESHOLD = 20
  /** Saturated red: R / (R + G + B) at or above this in at least one state. Step 3. */
  const RED_RATIO = 0.8
  /** Scale for the red value v = RED_SCALE * max(0, R - G - B). Step 3. */
  const RED_SCALE = 320

  // -------------------------------------------------------------------------
  // Page defaults. From the Phase 2 checklist and prompt 4 in docs/SPEC.md.
  // -------------------------------------------------------------------------

  /** Frequency control range, before snapping to what the display can show. */
  const FREQ_MIN_HZ = 1
  const FREQ_MAX_HZ = 30
  /** Opening frequency. 10 Hz is one of the spec's three standard test frequencies. */
  const DEFAULT_FREQ_HZ = 10
  /** "Use 5, 10 and 15 Hz as the standard test frequencies everywhere." Step 7. */
  const STANDARD_FREQS_HZ = [5, 10, 15]
  /** Default luminance swing between the two greys: low contrast. */
  const DEFAULT_SWING = 0.2
  /** Luminance of the default dark grey, so the default pair sits well under DARK_LIMIT. */
  const DEFAULT_DARK_LUMINANCE = 0.1
  /** Default flashing area as a share of the window. */
  const DEFAULT_AREA_SHARE = 0.25
  /** Default burst length. */
  const DEFAULT_BURST_MS = 3000
  /** Hard stop, whatever the burst length says. */
  const HARD_STOP_MS = 5000
  /** Steady grey lead-in before every burst. */
  const LEAD_IN_MS = 2000
  /**
   * Largest swing allowed while the full-contrast toggle is off. The spec fixes the
   * default swing (0.2) and says full contrast is a separate toggle, off by default, used
   * for the slow-motion measurement only; it does not name the cap in between. 0.3 keeps
   * the unlocked range "low contrast" in the sense of CLAUDE.md's safety rule while still
   * leaving room to explore either side of the 0.1 detection threshold.
   */
  const MAX_SWING_WITHOUT_FULL_CONTRAST = 0.3
  /** Frames used to estimate the display refresh rate. */
  const REFRESH_SAMPLE_FRAMES = 30
  /** Used until enough frames have been seen to estimate the refresh rate. */
  const FALLBACK_REFRESH_HZ = 60

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value
  }

  // -------------------------------------------------------------------------
  // Step 1: linear light
  // -------------------------------------------------------------------------

  /** sRGB channel in 0..1 to linear light. Step 1. */
  function srgbToLinear(channel) {
    return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  }

  /** The exact inverse of srgbToLinear, for picking a grey that hits a target luminance. */
  function linearToSrgb(linear) {
    return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
  }

  /** 8-bit sRGB channel value to linear light. */
  function byteToLinear(byte) {
    return srgbToLinear(clamp(byte, 0, 255) / 255)
  }

  /** Relative luminance Y of an 8-bit sRGB colour. Step 1. */
  function relativeLuminance(r, g, b) {
    return 0.2126 * byteToLinear(r) + 0.7152 * byteToLinear(g) + 0.0722 * byteToLinear(b)
  }

  /** Y of a neutral grey, where the three coefficients sum to 1. */
  function greyLuminance(byte) {
    return byteToLinear(byte)
  }

  /** The 8-bit neutral grey whose luminance is closest to y. */
  function greyByteForLuminance(y) {
    return Math.round(clamp(linearToSrgb(clamp(y, 0, 1)), 0, 1) * 255)
  }

  /** The two greys the page opens with: a DEFAULT_SWING swing, both under DARK_LIMIT. */
  function defaultGreyBytes() {
    return {
      dark: greyByteForLuminance(DEFAULT_DARK_LUMINANCE),
      light: greyByteForLuminance(DEFAULT_DARK_LUMINANCE + DEFAULT_SWING)
    }
  }

  /**
   * Pull the light grey down until the pair's swing fits maxSwing. Used while the
   * full-contrast toggle is off. greyByteForLuminance rounds to the nearest byte, which
   * can round up over the target, so step down until the swing really is inside the cap:
   * this is a safety limit, not a hint.
   */
  function clampGreysToSwing(darkByte, lightByte, maxSwing) {
    const yDark = greyLuminance(darkByte)
    if (greyLuminance(lightByte) - yDark <= maxSwing) {
      return { dark: darkByte, light: lightByte }
    }
    let candidate = greyByteForLuminance(yDark + maxSwing)
    while (candidate > darkByte && greyLuminance(candidate) - yDark > maxSwing) candidate--
    return { dark: darkByte, light: candidate }
  }

  // -------------------------------------------------------------------------
  // Step 3: the red channel
  // -------------------------------------------------------------------------

  /** Red ratio p = R / (R + G + B) on linear values. Step 3. */
  function redRatio(r, g, b) {
    const rl = byteToLinear(r)
    const sum = rl + byteToLinear(g) + byteToLinear(b)
    return sum > 0 ? rl / sum : 0
  }

  /** Red value v = 320 * max(0, R - G - B) on linear values. Step 3. */
  function redValue(r, g, b) {
    return RED_SCALE * Math.max(0, byteToLinear(r) - byteToLinear(g) - byteToLinear(b))
  }

  // -------------------------------------------------------------------------
  // Would the detector count this pair of states as a flash?
  // -------------------------------------------------------------------------

  /** Step 4 for a pair of greys: a reversal of at least 0.10 with the darker under 0.80. */
  function classifyGreyFlash(darkByte, lightByte) {
    const yLow = greyLuminance(Math.min(darkByte, lightByte))
    const yHigh = greyLuminance(Math.max(darkByte, lightByte))
    const swing = yHigh - yLow
    const meetsThreshold = swing >= LUMINANCE_THRESHOLD
    const darkerUnderLimit = yLow < DARK_LIMIT
    return {
      yLow,
      yHigh,
      swing,
      meetsThreshold,
      darkerUnderLimit,
      countsAsFlash: meetsThreshold && darkerUnderLimit
    }
  }

  /** Step 3 for a pair of colours: v changes by more than 20 with p >= 0.8 in one state. */
  function classifyRedFlash(a, b) {
    const ratioA = redRatio(a[0], a[1], a[2])
    const ratioB = redRatio(b[0], b[1], b[2])
    const vA = redValue(a[0], a[1], a[2])
    const vB = redValue(b[0], b[1], b[2])
    const deltaV = Math.abs(vA - vB)
    const saturated = Math.max(ratioA, ratioB) >= RED_RATIO
    const meetsThreshold = deltaV > RED_THRESHOLD
    return {
      ratioA,
      ratioB,
      vA,
      vB,
      deltaV,
      saturated,
      meetsThreshold,
      countsAsRedFlash: saturated && meetsThreshold
    }
  }

  // -------------------------------------------------------------------------
  // Frequency: snapped to what the display can show
  // -------------------------------------------------------------------------

  /**
   * The square-wave frequencies a display of this refresh rate can show exactly: each
   * half-cycle is a whole number of frames n, so f = refresh / (2n). On a 60 Hz display
   * that is 30, 15, 10, 7.5, 6, 5 and so on, which is the set the spec names in Step 7.
   * Returned coarse-to-fine, each entry carrying the frames per half-cycle that drives it.
   */
  function achievableFrequencies(refreshHz, minHz, maxHz) {
    const low = typeof minHz === 'number' ? minHz : FREQ_MIN_HZ
    const high = typeof maxHz === 'number' ? maxHz : FREQ_MAX_HZ
    const out = []
    if (!(refreshHz > 0)) return out
    for (let n = 1; refreshHz / (2 * n) >= low; n++) {
      const hz = refreshHz / (2 * n)
      if (hz <= high) out.push({ framesPerHalfCycle: n, hz })
    }
    return out
  }

  /** The achievable frequency closest to the request. Ties go to the gentler (lower) one. */
  function snapFrequency(requestedHz, refreshHz, minHz, maxHz) {
    const options = achievableFrequencies(refreshHz, minHz, maxHz)
    if (options.length === 0) return null
    let best = options[0]
    for (const option of options) {
      const delta = Math.abs(option.hz - requestedHz)
      const bestDelta = Math.abs(best.hz - requestedHz)
      if (delta < bestDelta || (delta === bestDelta && option.hz < best.hz)) best = option
    }
    return best
  }

  /**
   * Refresh rate from a run of frame timestamps, using the median gap so a dropped frame
   * or a slow first frame cannot skew it. Needs at least two timestamps.
   */
  function estimateRefreshHz(timestamps) {
    if (!timestamps || timestamps.length < 2) return null
    const gaps = []
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1]
      if (gap > 0) gaps.push(gap)
    }
    if (gaps.length === 0) return null
    gaps.sort((x, y) => x - y)
    const mid = Math.floor(gaps.length / 2)
    const median = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
    return 1000 / median
  }

  /** Frequency actually achieved, from completed half-cycles and the time they took. */
  function achievedHz(halfCycles, elapsedMs) {
    if (halfCycles < 1 || elapsedMs <= 0) return null
    return (halfCycles * 1000) / (2 * elapsedMs)
  }

  // -------------------------------------------------------------------------
  // Area as a share of the window
  // -------------------------------------------------------------------------

  /**
   * A centred rectangle covering exactly `share` of a window, keeping the window's
   * aspect ratio so the share holds in both directions.
   */
  function rectForShare(share, windowWidth, windowHeight) {
    const scale = Math.sqrt(clamp(share, 0, 1))
    return {
      width: Math.round(windowWidth * scale),
      height: Math.round(windowHeight * scale)
    }
  }

  // -------------------------------------------------------------------------
  // Burst sequencing
  // -------------------------------------------------------------------------

  /**
   * The lead-in, the flash and the stop, driven by frame timestamps rather than frame
   * counts for the timing and by frame counts for the flash itself, so every half-cycle
   * lasts a whole number of display frames.
   *
   * It lives here rather than in the page so the safety behaviour the Phase 2 checklist
   * names - a steady lead-in, and a stop after at most HARD_STOP_MS - is unit-tested.
   * The requested burst length is clamped to the hard stop on construction, so no caller
   * can ask for a longer one.
   */
  function createBurstRunner(options) {
    const leadInMs = typeof options.leadInMs === 'number' ? options.leadInMs : LEAD_IN_MS
    const burstMs = Math.min(options.burstMs, HARD_STOP_MS)
    const framesPerHalfCycle = Math.max(1, Math.round(options.framesPerHalfCycle))

    let phase = 'idle'
    let startedAt = 0
    let burstStartedAt = 0
    let burstFrame = 0
    let halfCycles = 0
    let half = -1
    // Transition times, so the achieved frequency is measured between two real
    // transitions rather than over a span ending mid-half-cycle.
    let firstChangeAt = null
    let lastChangeAt = null

    function measuredMs() {
      return firstChangeAt === null || lastChangeAt === null ? 0 : lastChangeAt - firstChangeAt
    }

    function idleStatus(stopped, reason) {
      return {
        phase: 'idle',
        leadInRemainingMs: 0,
        elapsedMs: 0,
        burstFrame,
        half: null,
        halfCycles,
        measuredMs: measuredMs(),
        changed: false,
        stopped: Boolean(stopped),
        reason: reason || null
      }
    }

    return {
      get phase() {
        return phase
      },
      get burstMs() {
        return burstMs
      },
      start(now) {
        phase = 'leadIn'
        startedAt = now
        burstFrame = 0
        halfCycles = 0
        half = -1
        firstChangeAt = null
        lastChangeAt = null
      },
      stop() {
        if (phase === 'idle') return idleStatus(false, null)
        phase = 'idle'
        half = -1
        return idleStatus(true, 'stopped')
      },
      tick(now) {
        if (phase === 'idle') return idleStatus(false, null)

        if (phase === 'leadIn') {
          const leadInElapsed = now - startedAt
          if (leadInElapsed < leadInMs) {
            return {
              phase: 'leadIn',
              leadInRemainingMs: leadInMs - leadInElapsed,
              elapsedMs: 0,
              burstFrame: 0,
              half: null,
              halfCycles: 0,
              measuredMs: 0,
              changed: false,
              stopped: false,
              reason: null
            }
          }
          phase = 'burst'
          burstStartedAt = now
        }

        const elapsedMs = now - burstStartedAt
        if (elapsedMs >= burstMs) {
          phase = 'idle'
          half = -1
          return idleStatus(true, elapsedMs >= HARD_STOP_MS ? 'hard stop' : 'burst complete')
        }

        const nextHalf = Math.floor(burstFrame / framesPerHalfCycle) % 2
        const changed = nextHalf !== half
        if (changed) {
          if (firstChangeAt === null) {
            firstChangeAt = now
          } else {
            halfCycles++
            lastChangeAt = now
          }
        }
        half = nextHalf
        burstFrame++

        return {
          phase: 'burst',
          leadInRemainingMs: 0,
          elapsedMs,
          burstFrame,
          half,
          halfCycles,
          measuredMs: measuredMs(),
          changed,
          stopped: false,
          reason: null
        }
      }
    }
  }

  global.CalmFrameStrobe = {
    LUMINANCE_THRESHOLD,
    DARK_LIMIT,
    RED_THRESHOLD,
    RED_RATIO,
    RED_SCALE,
    FREQ_MIN_HZ,
    FREQ_MAX_HZ,
    DEFAULT_FREQ_HZ,
    STANDARD_FREQS_HZ,
    DEFAULT_SWING,
    DEFAULT_DARK_LUMINANCE,
    DEFAULT_AREA_SHARE,
    DEFAULT_BURST_MS,
    HARD_STOP_MS,
    LEAD_IN_MS,
    MAX_SWING_WITHOUT_FULL_CONTRAST,
    REFRESH_SAMPLE_FRAMES,
    FALLBACK_REFRESH_HZ,
    clamp,
    srgbToLinear,
    linearToSrgb,
    byteToLinear,
    relativeLuminance,
    greyLuminance,
    greyByteForLuminance,
    defaultGreyBytes,
    clampGreysToSwing,
    redRatio,
    redValue,
    classifyGreyFlash,
    classifyRedFlash,
    achievableFrequencies,
    snapFrequency,
    estimateRefreshHz,
    achievedHz,
    rectForShare,
    createBurstRunner
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
