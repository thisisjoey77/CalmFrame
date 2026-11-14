import { describe, expect, it } from 'vitest'
import { DARK_LIMIT, RED_RATIO } from '../shared/config'
import { SRGB8_TO_LINEAR, redRatio, redValue, relativeLuminance, srgbToLinear } from './luminance'

describe('luminance (Step 1)', () => {
  it('decodes the ends of the sRGB range exactly', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(1)).toBeCloseTo(1, 12)
  })

  it('puts mid-grey sRGB 128 at Y = 0.22', () => {
    const y = SRGB8_TO_LINEAR[128]
    expect(relativeLuminance(y, y, y)).toBeCloseTo(0.22, 2)
  })

  it('puts the 0.80 dark limit at sRGB 231', () => {
    expect(SRGB8_TO_LINEAR[231]).toBeLessThan(DARK_LIMIT)
    expect(SRGB8_TO_LINEAR[232]).toBeGreaterThan(DARK_LIMIT)
  })

  it('builds the 8-bit table from the same formula', () => {
    for (let code = 0; code < 256; code++) {
      expect(SRGB8_TO_LINEAR[code]).toBeCloseTo(srgbToLinear(code / 255), 6)
    }
  })

  it('gives white Y = 1 and a grey its own level', () => {
    expect(relativeLuminance(1, 1, 1)).toBeCloseTo(1, 12)
    expect(relativeLuminance(0.3, 0.3, 0.3)).toBeCloseTo(0.3, 12)
    expect(relativeLuminance(0, 0, 0)).toBe(0)
  })

  it('averages a 1-pixel checkerboard to 0.5 in linear light, not 0.21 (Step 2)', () => {
    // The Step 2 acceptance number. The GPU pass is tested on a generated texture in
    // Phase 3; this pins down the arithmetic it has to reproduce.
    const linearAverage = (SRGB8_TO_LINEAR[0] + SRGB8_TO_LINEAR[255]) / 2
    const gammaAverage = srgbToLinear((0 + 1) / 2)
    expect(linearAverage).toBeCloseTo(0.5, 6)
    expect(gammaAverage).toBeCloseTo(0.21, 2)
  })
})

describe('red quantities (Step 3)', () => {
  it('scores pure red as fully saturated with v = 320', () => {
    expect(redRatio(1, 0, 0)).toBe(1)
    expect(redValue(1, 0, 0)).toBe(320)
  })

  it('treats black as ratio 0 rather than NaN', () => {
    expect(redRatio(0, 0, 0)).toBe(0)
    expect(redValue(0, 0, 0)).toBe(0)
  })

  it('clamps negative R - G - B to zero', () => {
    expect(redValue(0.5, 0.5, 0.5)).toBe(0)
    expect(redValue(0.2, 0.9, 0)).toBe(0)
  })

  it('separates saturated red from orange at the 0.8 ratio', () => {
    expect(redRatio(1, 0.1, 0.1)).toBeGreaterThanOrEqual(RED_RATIO)
    expect(redRatio(1, 0.5, 0)).toBeLessThan(RED_RATIO)
  })
})
