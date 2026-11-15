// A picture's shape on screen: `fit` with the terminal's own cell size keeps
// the picture's aspect (a 600 × 600 PNG in Rex's 12 × 38 px cells is square
// on screen, not the 1 : 1.6 the old 1 : 2 guess drew), and the cell size
// comes from the terminal's replies to CSI 16 t, else CSI 14 t.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type CellPixels, fit } from "./graphics.ts"
import { answered, CELL_QUERIES, cellOf } from "./terminal.ts"

const REX_CELL: CellPixels = { width: 12, height: 38 }
const ESC = "\u001b"

/** A seeded generator of numbers in [0, 1) (mulberry32). */
const drawer = (seed: number) => {
  const state = { at: seed >>> 0 }
  return () => {
    state.at = (state.at + 0x6d2b79f5) >>> 0
    const mixed = Math.imul(state.at ^ (state.at >>> 15), 1 | state.at)
    const more = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((more ^ (more >>> 14)) >>> 0) / 4294967296
  }
}

const between = (draw: () => number, low: number, high: number) => low + Math.floor(draw() * (high - low + 1))

/** The aspect `cells` of `cell` pixels make on screen, over the picture's own: 1 when kept exactly. */
const aspectKept = (picture: { width: number; height: number }, cells: { cols: number; rows: number }, cell: CellPixels) =>
  (cells.cols * cell.width) / (cells.rows * cell.height) / (picture.width / picture.height)

describe("fitting a picture to the pane", () => {
  test("a square PNG in Rex's 12 × 38 px cells is square on screen", () => {
    const cells = fit({ width: 600, height: 600 }, { cols: 82, rows: 32 }, REX_CELL)
    expect(cells).toEqual({ cols: 82, rows: 26 })
    expect(Math.abs(aspectKept({ width: 600, height: 600 }, cells, REX_CELL) - 1)).toBeLessThanOrEqual(0.02)
  })

  test("without a cell size, cells are taken as twice as tall as wide", () => {
    expect(fit({ width: 600, height: 300 }, { cols: 80, rows: 40 })).toEqual({ cols: 80, rows: 20 })
    expect(fit({ width: 300, height: 600 }, { cols: 80, rows: 20 })).toEqual({ cols: 20, rows: 20 })
  })

  test("any picture, pane and cell: inside the pane, one side filling it, the shape kept within 2% once it spans 25 cells each way", () => {
    for (const seed of Array.from({ length: 2000 }, (_, at) => at)) {
      const draw = drawer(seed)
      const picture = { width: between(draw, 16, 4000), height: between(draw, 16, 4000) }
      const space = { cols: between(draw, 1, 300), rows: between(draw, 1, 120) }
      const cell = { width: between(draw, 4, 24), height: between(draw, 8, 60) }
      const cells = fit(picture, space, cell)
      const where = { seed, picture, space, cell, cells }
      expect({ ...where, inside: cells.cols >= 1 && cells.rows >= 1 && cells.cols <= space.cols && cells.rows <= space.rows }).toMatchObject({ inside: true })
      expect({ ...where, fills: cells.cols === space.cols || cells.rows === space.rows }).toMatchObject({ fills: true })
      if (cells.cols >= 25 && cells.rows >= 25) expect({ ...where, off: Math.abs(aspectKept(picture, cells, cell) - 1) <= 0.02 }).toMatchObject({ off: true })
    }
  })
})

describe("the cell size the terminal reports", () => {
  test("asks for the cell's size, then the text area's", () => {
    expect(CELL_QUERIES).toBe(`${ESC}[16t${ESC}[14t`)
  })

  test("takes the cell reply, else the text area's divided by the pane's cells, else none", () => {
    const cells = { cols: 82, rows: 35 }
    expect(cellOf(`${ESC}[6;38;12t${ESC}[4;1330;984t`, cells)).toEqual(Option.some({ width: 12, height: 38 }))
    expect(cellOf(`x${ESC}[4;1330;984t`, cells)).toEqual(Option.some({ width: 984 / 82, height: 1330 / 35 }))
    expect(cellOf("typed text", cells)).toEqual(Option.none())
    expect(cellOf(`${ESC}[6;0;12t`, cells)).toEqual(Option.none())
  })

  test("waits until a reply is in", () => {
    expect(answered("")).toBe(false)
    expect(answered(`${ESC}[6;38`)).toBe(false)
    expect(answered(`${ESC}[6;38;12t`)).toBe(true)
  })
})
