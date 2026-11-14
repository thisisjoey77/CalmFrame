/**
 * GLSL ES 3.00 sources for the overlay's GPU passes. docs/SPEC.md, "The per-frame loop".
 * Constants come from src/shared/config.ts and are spliced in, so nothing is hard-coded.
 */

import {
  GRID_COLS,
  GRID_ROWS,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  SRGB_GAMMA,
  SRGB_LINEAR_CUTOFF,
  SRGB_LINEAR_SLOPE,
  SRGB_OFFSET
} from '../shared/config'

/** A number as a GLSL float literal: GLSL rejects "2" where a float is expected. */
function float(x: number): string {
  const s = String(x)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

/** sRGB to linear light, per channel (Step 1). The CPU twin is srgbToLinear in
 *  src/core/luminance.ts. */
const SRGB_TO_LINEAR = `vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / ${float(SRGB_LINEAR_SLOPE)};
  vec3 hi = pow((c + ${float(SRGB_OFFSET)}) / ${float(1 + SRGB_OFFSET)}, vec3(${float(SRGB_GAMMA)}));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(${float(SRGB_LINEAR_CUTOFF)}))));
}
`

/** Linear light back to sRGB, per channel. The CPU twin is linearToSrgb in
 *  src/core/luminance.ts. The cutoff is the decoding cutoff mapped through the linear
 *  segment, so the two pieces meet at the same point. */
const LINEAR_TO_SRGB = `vec3 linearToSrgb(vec3 l) {
  vec3 lo = l * ${float(SRGB_LINEAR_SLOPE)};
  vec3 hi = ${float(1 + SRGB_OFFSET)} * pow(l, vec3(${float(1 / SRGB_GAMMA)})) - ${float(SRGB_OFFSET)};
  return mix(hi, lo, vec3(lessThanEqual(l, vec3(${float(SRGB_LINEAR_CUTOFF / SRGB_LINEAR_SLOPE)}))));
}
`

/** One triangle that covers the whole viewport, from the vertex index alone. */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  // Vertices 0, 1, 2 -> (-1, -1), (3, -1), (-1, 3).
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`

/**
 * Pass A: linearise and area-average the captured frame to the 96x54 grid (Steps 1 and 2).
 *
 * Drawn into a GRID_COLS x GRID_ROWS float target, one fragment per cell. Each fragment
 * visits every source pixel its cell touches, linearises it, and weights it by the share of
 * the pixel inside the cell, so cells need not hold a whole number of pixels. The source
 * size comes from the texture itself, so a capture-size change needs no new uniforms.
 *
 * Orientation: texel row 0 is the top of the image (uploads are not flipped), and fragment
 * row y reads source rows from the top, so read-back row 0 is the top row of cells. That
 * matches the CPU twin, src/core/gridAverage.ts.
 */
export const GRID_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_src;
out vec4 o_linear;

const vec2 GRID = vec2(${float(GRID_COLS)}, ${float(GRID_ROWS)});

${SRGB_TO_LINEAR}
void main() {
  ivec2 src = textureSize(u_src, 0);
  vec2 scale = vec2(src) / GRID;
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 lo = cell * scale;
  vec2 hi = (cell + 1.0) * scale;
  ivec2 first = ivec2(floor(lo));
  ivec2 end = min(ivec2(ceil(hi)), src);

  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int y = first.y; y < end.y; y++) {
    float wy = min(hi.y, float(y + 1)) - max(lo.y, float(y));
    for (int x = first.x; x < end.x; x++) {
      float wx = min(hi.x, float(x + 1)) - max(lo.x, float(x));
      float w = wx * wy;
      sum += w * srgbToLinear(texelFetch(u_src, ivec2(x, y), 0).rgb);
      total += w;
    }
  }
  o_linear = vec4(sum / total, 1.0);
}
`

/**
 * Pass B: the smoothing filter, S += alpha (X - S), per pixel in linear light ("Mitigation
 * math", "The filter").
 *
 * Drawn into the half-float state target at capture resolution, one fragment per pixel,
 * reading the uploaded frame and the previous state at the same texel. Both keep texel row
 * 0 at the top of the image, so the state does too. Alpha 1 seeds the state from the frame.
 */
export const STATE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_src;
uniform sampler2D u_prev;
uniform float u_alpha;
out vec4 o_state;

${SRGB_TO_LINEAR}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 x = srgbToLinear(texelFetch(u_src, p, 0).rgb);
  vec3 s = texelFetch(u_prev, p, 0).rgb;
  o_state = vec4(s + u_alpha * (x - s), 1.0);
}
`

/**
 * Pass C: what the overlay shows, d * S re-encoded to sRGB, at the given opacity
 * ("Dimming covers what smoothing cannot", "Red flashes").
 *
 * For a red hazard the colour is blended u_desat of the way toward its own grey level
 * (its relative luminance), in linear light, before re-encoding. The output is
 * premultiplied, because the overlay canvas is, so opacity 0 is fully transparent.
 *
 * The state keeps row 0 at the top of the image while a framebuffer's row 0 is at the
 * bottom, so rows are flipped here. The state is scaled to whatever size the target is.
 */
export const DISPLAY_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_state;
uniform vec2 u_target;
uniform float u_dim;
uniform float u_opacity;
uniform float u_desat;
out vec4 o_color;

const vec3 LUMA = vec3(${float(LUMA_R)}, ${float(LUMA_G)}, ${float(LUMA_B)});

${LINEAR_TO_SRGB}
void main() {
  ivec2 size = textureSize(u_state, 0);
  ivec2 p = ivec2(gl_FragCoord.xy * vec2(size) / u_target);
  p.y = size.y - 1 - p.y;
  vec3 lin = u_dim * texelFetch(u_state, p, 0).rgb;
  lin = mix(lin, vec3(dot(lin, LUMA)), u_desat);
  vec3 c = linearToSrgb(clamp(lin, 0.0, 1.0));
  o_color = vec4(c * u_opacity, u_opacity);
}
`
