/**
 * A grid of cells attached to the scrolling scene, not to the screen. Experimental, and so
 * far only in the offline render. docs/SPEC.md, "Game mode: hold the usual look".
 *
 * In a side-scrolling game a cell fixed to the screen sees whatever scrolls through it, so
 * anything remembered per screen cell is a blur of the level. This lattice moves with the
 * picture's content (scroll.ts measures by how much), so one cell stays on one piece of the
 * level for as long as that piece is on screen.
 *
 * This class is only the bookkeeping: where the lattice is on this frame, the mean of each
 * visible cell, which stored slot belongs to which cell, and the tables for interpolating
 * per-cell values at every pixel. What is remembered per slot is up to the caller.
 *
 * Nothing is ever resampled: a cell's slot is found from its place in the scene, so its
 * stored values stay exactly what was written, however far the scene scrolls.
 */

/** Cell area still counts as whole within this many square pixels. */
const WHOLE_SLACK = 1e-6
/** A cell with less than this area on screen has no mean. */
const MIN_AREA = 1e-9

export class SceneGrid {
  /** Cells that can be on screen at once, across and down. Per-frame arrays use this size,
   *  indexed row * cols + col from the top-left visible cell. */
  readonly cols: number
  readonly rows: number
  readonly cells: number
  /** Stored cells. A caller keeps its own per-slot arrays of this length. */
  readonly slots: number

  /** This frame: linear R, G, B mean of each visible cell, over the part on screen. */
  readonly mean: Float32Array
  /** This frame: the slot of each visible cell, or -1 where no cell is on screen. */
  readonly slotOf: Int32Array
  /** This frame: 1 where the whole cell is on screen. */
  readonly whole: Uint8Array
  /** This frame: 1 where the slot already held this cell and it had been seen whole before.
   *  0 means the caller must give the slot its first values. */
  readonly settled: Uint8Array

  /** Interpolation between cell centres at every pixel column and row: the left (top) cell
   *  and the weight of the next one, clamped to cells at least half on screen. */
  readonly columnCell: Int32Array
  readonly columnWeight: Float32Array
  readonly rowCell: Int32Array
  readonly rowWeight: Float32Array

  /** How far the scene has scrolled since the first frame, in pixels. */
  offsetX = 0
  offsetY = 0

  private readonly storeCols: number
  private readonly storeRows: number
  private readonly idCol: Int32Array
  private readonly idRow: Int32Array
  private readonly seenWhole: Uint8Array
  private readonly sum: Float64Array
  private readonly rowSum: Float64Array
  private readonly colArea: Float64Array
  private readonly rowArea: Float64Array
  private readonly pixelCol: Int32Array
  private readonly pixelColWeight: Float32Array
  private readonly pixelRow: Int32Array
  private readonly pixelRowWeight: Float32Array
  private first = true

  /** @param cell the cell size in pixels, a whole number of at least 1 */
  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell: number
  ) {
    if (!Number.isInteger(cell) || cell < 1) {
      throw new Error(`The cell size must be a whole number of pixels, got ${cell}`)
    }
    if (width < 2 * cell || height < 2 * cell) {
      throw new Error(`A ${width}x${height} picture is too small for ${cell} px cells`)
    }
    this.cols = Math.ceil(width / cell) + 2
    this.rows = Math.ceil(height / cell) + 2
    this.cells = this.cols * this.rows
    this.storeCols = this.cols + 1
    this.storeRows = this.rows + 1
    this.slots = this.storeCols * this.storeRows
    this.idCol = new Int32Array(this.slots).fill(-2147483648)
    this.idRow = new Int32Array(this.slots).fill(-2147483648)
    this.seenWhole = new Uint8Array(this.slots)
    this.mean = new Float32Array(this.cells * 3)
    this.slotOf = new Int32Array(this.cells).fill(-1)
    this.whole = new Uint8Array(this.cells)
    this.settled = new Uint8Array(this.cells)
    this.sum = new Float64Array(this.cells * 3)
    this.rowSum = new Float64Array(this.cols * 3)
    this.colArea = new Float64Array(this.cols)
    this.rowArea = new Float64Array(this.rows)
    this.pixelCol = new Int32Array(width)
    this.pixelColWeight = new Float32Array(width)
    this.pixelRow = new Int32Array(height)
    this.pixelRowWeight = new Float32Array(height)
    this.columnCell = new Int32Array(width)
    this.columnWeight = new Float32Array(width)
    this.rowCell = new Int32Array(height)
    this.rowWeight = new Float32Array(height)
  }

  /** Screen position, in pixels, of the centre of a visible cell's column or row. */
  centreX(col: number): number {
    return (
      (col + 0.5) * this.cell - (this.offsetX - Math.floor(this.offsetX / this.cell) * this.cell)
    )
  }
  centreY(row: number): number {
    return (
      (row + 0.5) * this.cell - (this.offsetY - Math.floor(this.offsetY / this.cell) * this.cell)
    )
  }

  /**
   * One frame: move the lattice with the scene and measure the visible cells.
   * @param image linear R, G, B per pixel, row-major, row 0 at the top
   * @param dx, dy how far the picture's content moved left and up since the last frame, in
   *        pixels. Ignored on the first frame.
   */
  step(image: ArrayLike<number>, dx: number, dy: number): void {
    const { width, height, cell, cols, rows } = this
    if (image.length < width * height * 3) {
      throw new Error(`Expected ${width * height * 3} values, got ${image.length}`)
    }
    if (!this.first) {
      this.offsetX += dx
      this.offsetY += dy
    }
    this.first = false
    const col0 = Math.floor(this.offsetX / cell)
    const row0 = Math.floor(this.offsetY / cell)

    // Each pixel column and row falls in one cell, or is split between two.
    const { pixelCol, pixelColWeight, pixelRow, pixelRowWeight, colArea, rowArea } = this
    colArea.fill(0)
    rowArea.fill(0)
    for (let x = 0; x < width; x++) {
      const at = x + this.offsetX
      const c = Math.floor(at / cell)
      const w = Math.min(1, (c + 1) * cell - at)
      pixelCol[x] = c - col0
      pixelColWeight[x] = w
      colArea[c - col0] += w
      colArea[c - col0 + 1] += 1 - w
    }
    for (let y = 0; y < height; y++) {
      const at = y + this.offsetY
      const r = Math.floor(at / cell)
      const w = Math.min(1, (r + 1) * cell - at)
      pixelRow[y] = r - row0
      pixelRowWeight[y] = w
      rowArea[r - row0] += w
      rowArea[r - row0 + 1] += 1 - w
    }

    // Area sums: each image row reduced to cell columns, then added to its cell row or two.
    const { sum, rowSum } = this
    const stride = cols * 3
    sum.fill(0)
    for (let y = 0; y < height; y++) {
      rowSum.fill(0)
      let p = y * width * 3
      for (let x = 0; x < width; x++, p += 3) {
        const k = pixelCol[x] * 3
        const w = pixelColWeight[x]
        const r = image[p]
        const g = image[p + 1]
        const b = image[p + 2]
        rowSum[k] += w * r
        rowSum[k + 1] += w * g
        rowSum[k + 2] += w * b
        if (w < 1) {
          const rest = 1 - w
          rowSum[k + 3] += rest * r
          rowSum[k + 4] += rest * g
          rowSum[k + 5] += rest * b
        }
      }
      const a = pixelRow[y] * stride
      const v = pixelRowWeight[y]
      for (let k = 0; k < stride; k++) sum[a + k] += v * rowSum[k]
      if (v < 1) {
        const rest = 1 - v
        for (let k = 0; k < stride; k++) sum[a + stride + k] += rest * rowSum[k]
      }
    }

    const { mean, slotOf, whole, settled, idCol, idRow, seenWhole, storeCols, storeRows } = this
    const wholeArea = cell * cell - WHOLE_SLACK
    for (let j = 0; j < rows; j++) {
      const sceneRow = row0 + j
      const storeRow = ((sceneRow % storeRows) + storeRows) % storeRows
      for (let i = 0; i < cols; i++) {
        const l = j * cols + i
        const area = colArea[i] * rowArea[j]
        if (area <= MIN_AREA) {
          slotOf[l] = -1
          whole[l] = 0
          settled[l] = 0
          mean[l * 3] = mean[l * 3 + 1] = mean[l * 3 + 2] = 0
          continue
        }
        mean[l * 3] = sum[l * 3] / area
        mean[l * 3 + 1] = sum[l * 3 + 1] / area
        mean[l * 3 + 2] = sum[l * 3 + 2] / area
        const sceneCol = col0 + i
        const slot = storeRow * storeCols + (((sceneCol % storeCols) + storeCols) % storeCols)
        slotOf[l] = slot
        if (idCol[slot] !== sceneCol || idRow[slot] !== sceneRow) {
          idCol[slot] = sceneCol
          idRow[slot] = sceneRow
          seenWhole[slot] = 0
        }
        settled[l] = seenWhole[slot]
        const isWhole = area >= wholeArea
        whole[l] = isWhole ? 1 : 0
        if (isWhole) seenWhole[slot] = 1
      }
    }

    // Interpolation tables, clamped to cells at least half on screen.
    const half = 0.5 * cell
    let loX = 0
    while (loX < cols - 1 && colArea[loX] < half) loX++
    let hiX = cols - 1
    while (hiX > loX && colArea[hiX] < half) hiX--
    let loY = 0
    while (loY < rows - 1 && rowArea[loY] < half) loY++
    let hiY = rows - 1
    while (hiY > loY && rowArea[hiY] < half) hiY--
    const { columnCell, columnWeight, rowCell, rowWeight } = this
    for (let x = 0; x < width; x++) {
      const g = (x + 0.5 + this.offsetX) / cell - 0.5 - col0
      let i = Math.floor(g)
      let f = g - i
      if (i < loX) {
        i = loX
        f = 0
      } else if (i >= hiX) {
        i = Math.max(loX, hiX - 1)
        f = hiX > loX ? 1 : 0
      }
      columnCell[x] = i
      columnWeight[x] = f
    }
    for (let y = 0; y < height; y++) {
      const g = (y + 0.5 + this.offsetY) / cell - 0.5 - row0
      let j = Math.floor(g)
      let f = g - j
      if (j < loY) {
        j = loY
        f = 0
      } else if (j >= hiY) {
        j = Math.max(loY, hiY - 1)
        f = hiY > loY ? 1 : 0
      }
      rowCell[y] = j
      rowWeight[y] = f
    }
  }
}
