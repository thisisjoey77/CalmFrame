/**
 * The little drawing the offline render needs (render.ts): an RGBA canvas, filled
 * rectangles, copying a picture in, and text in a built-in 5x7 dot font. No dependency and
 * no font file, so the labels come out the same on Windows and in the Coder workspace.
 *
 * Text is upper case only. A character the font does not have is drawn as a space.
 */

export type Rgb = readonly [number, number, number]

/** sRGB RGBA8, row-major, row 0 at the top: the layout ffmpeg reads and averageToGrid takes. */
export interface Canvas {
  width: number
  height: number
  data: Uint8Array
}

export function newCanvas(width: number, height: number, background: Rgb): Canvas {
  const canvas = { width, height, data: new Uint8Array(width * height * 4) }
  fillRect(canvas, 0, 0, width, height, background)
  return canvas
}

/** Fill a rectangle, clipped to the canvas. */
export function fillRect(c: Canvas, x: number, y: number, w: number, h: number, color: Rgb): void {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(c.width, x + w)
  const y1 = Math.min(c.height, y + h)
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0, p = (yy * c.width + x0) * 4; xx < x1; xx++, p += 4) {
      c.data[p] = color[0]
      c.data[p + 1] = color[1]
      c.data[p + 2] = color[2]
      c.data[p + 3] = 255
    }
  }
}

/** Copy an RGBA picture in with its top-left corner at (x, y), clipped to the canvas. */
export function blit(
  c: Canvas,
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  x: number,
  y: number
): void {
  const x0 = Math.max(0, x)
  const x1 = Math.min(c.width, x + srcWidth)
  if (x1 <= x0) return
  for (let sy = 0; sy < srcHeight; sy++) {
    const yy = y + sy
    if (yy < 0 || yy >= c.height) continue
    const from = (sy * srcWidth + (x0 - x)) * 4
    c.data.set(src.subarray(from, from + (x1 - x0) * 4), (yy * c.width + x0) * 4)
  }
}

export const GLYPH_WIDTH = 5
export const GLYPH_HEIGHT = 7
/** Columns from one character to the next: the glyph and one column of space. */
const ADVANCE = GLYPH_WIDTH + 1

// Seven rows of five dots per character, '#' for a lit dot.
const GLYPHS: Record<string, readonly string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....']
}

/** Whether the font can draw this character (letters count in either case). */
export function hasGlyph(char: string): boolean {
  return char === ' ' || char.toUpperCase() in GLYPHS
}

/** Width in pixels of a line of text at this scale (pixels per font dot). */
export function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : (text.length * ADVANCE - 1) * scale
}

/**
 * Draw one line of text with its top-left corner at (x, y), clipped to the canvas.
 * @param scale pixels per font dot: a line is 7 x scale pixels high
 * @returns the x just past the text, for text that continues on the same line
 */
export function drawText(
  c: Canvas,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgb
): number {
  let cx = x
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char]
    if (glyph) {
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        for (let col = 0; col < GLYPH_WIDTH; col++) {
          if (glyph[row][col] === '#') {
            fillRect(c, cx + col * scale, y + row * scale, scale, scale, color)
          }
        }
      }
    }
    cx += ADVANCE * scale
  }
  return cx
}
