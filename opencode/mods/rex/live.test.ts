// The live tab's pure part: a click at a cell lands inside that cell's part
// of the page (a property over pane sizes, cells and widths), the SGR 1006
// mouse reports the pane reads (encoded and read back, split across reads),
// the keys and the pane's own keys, and the commands each becomes.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { decodeSgr, encodeSgr, Input, keyCommands, layoutOf, Mouse, mouseCommands, NO_MODS, parseInput, toPage } from "./live.ts"

/** A seeded draw in [0, 1), so a failing case names its seed. */
const drawsOf = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    const more = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((more ^ (more >>> 14)) >>> 0) / 4294967296
  }
}
const between = (draw: () => number, low: number, high: number) => low + Math.floor(draw() * (high - low + 1))

describe("where a click lands", () => {
  test("a click at any cell of the frames lands inside that cell's part of the page; a cell off them lands nowhere", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const draw = drawsOf(seed)
      const size = { cols: between(draw, 10, 220), rows: between(draw, 4, 90) }
      const cell = { width: between(draw, 4, 24), height: between(draw, 8, 48) }
      const width = Option.liftPredicate(between(draw, 0, 2000), (px) => px >= 200)
      const layout = layoutOf(size, cell, width)
      const across = between(draw, 0, layout.cells.cols - 1)
      const down = between(draw, 0, layout.cells.rows - 1)
      const at = toPage(layout, across + 1, down + 1 + layout.top)
      const box = {
        left: (across * layout.view.width) / layout.cells.cols,
        right: ((across + 1) * layout.view.width) / layout.cells.cols,
        top: (down * layout.view.height) / layout.cells.rows,
        bottom: ((down + 1) * layout.view.height) / layout.cells.rows,
      }
      const inside = Option.match(at, { onNone: () => false, onSome: (point) => point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom })
      expect({ seed, inside }).toEqual({ seed, inside: true })
      for (const [col, row] of [[across + 1, layout.top], [layout.cells.cols + 1, down + 1 + layout.top], [across + 1, layout.top + layout.cells.rows + 1], [0, down + 1]]) {
        expect({ seed, col, row, at: toPage(layout, col, row) }).toEqual({ seed, col, row, at: Option.none() })
      }
    }
  })

  test("the frames fill the room under the header, at the pane's pixels unless a width is asked", () => {
    const layout = layoutOf({ cols: 82, rows: 35 }, { width: 12, height: 38 }, Option.none())
    expect(layout).toEqual({ top: 1, cells: { cols: 82, rows: 33 }, view: { width: 984, height: 1254 }, max: { width: 984, height: 1254 } })
    expect(layoutOf({ cols: 82, rows: 35 }, { width: 12, height: 38 }, Option.some(1280)).view).toEqual({ width: 1280, height: 1631 })
  })
})

describe("the pane's mouse reports", () => {
  test("encode as SGR 1006: the button, wheel and drag codes, the held keys, M for a press and m for a release", () => {
    expect(encodeSgr(Mouse.Press({ button: "left", col: 9, row: 3, mods: NO_MODS }))).toBe("\u001b[<0;9;3M")
    expect(encodeSgr(Mouse.Release({ button: "left", col: 9, row: 3, mods: NO_MODS }))).toBe("\u001b[<0;9;3m")
    expect(encodeSgr(Mouse.Press({ button: "right", col: 1, row: 2, mods: { ...NO_MODS, ctrl: true } }))).toBe("\u001b[<18;1;2M")
    expect(encodeSgr(Mouse.Wheel({ direction: "down", col: 40, row: 18, mods: NO_MODS }))).toBe("\u001b[<65;40;18M")
    expect(encodeSgr(Mouse.Drag({ button: Option.some("left"), col: 5, row: 6, mods: NO_MODS }))).toBe("\u001b[<32;5;6M")
    expect(encodeSgr(Mouse.Drag({ button: Option.none(), col: 5, row: 6, mods: { shift: true, alt: true, ctrl: false } }))).toBe("\u001b[<47;5;6M")
  })

  test("any report reads back as itself, also when a read ends inside it", () => {
    const buttons = ["left", "middle", "right"] as const
    const directions = ["up", "down", "left", "right"] as const
    for (let seed = 1; seed <= 300; seed++) {
      const draw = drawsOf(seed)
      const at = { col: between(draw, 1, 400), row: between(draw, 1, 200), mods: { shift: draw() < 0.3, alt: draw() < 0.3, ctrl: draw() < 0.3 } }
      const kind = between(draw, 0, 3)
      const button = buttons[between(draw, 0, 2)]
      const mouse = [
        Mouse.Press({ button, ...at }),
        Mouse.Release({ button, ...at }),
        Mouse.Drag({ button: Option.liftPredicate(button, () => draw() < 0.5), ...at }),
        Mouse.Wheel({ direction: directions[between(draw, 0, 3)], ...at }),
      ][kind]
      const sent = encodeSgr(mouse)
      expect({ seed, read: parseInput(sent) }).toEqual({ seed, read: { inputs: [Input.Pointer({ mouse })], rest: "" } })
      const split = between(draw, 1, sent.length - 1)
      const head = parseInput(`a${sent.slice(0, split)}`)
      expect({ seed, inputs: head.inputs, rest: head.rest }).toEqual({ seed, inputs: [Input.Text({ text: "a" })], rest: sent.slice(0, split) })
      expect({ seed, read: parseInput(head.rest + sent.slice(split)).inputs }).toEqual({ seed, read: [Input.Pointer({ mouse })] })
    }
    expect(decodeSgr(67, 1, 1, "M")).toEqual(Option.some(Mouse.Wheel({ direction: "right", col: 1, row: 1, mods: NO_MODS })))
    expect(decodeSgr(3, 1, 1, "M")).toEqual(Option.none())
  })
})

describe("the pane's keys", () => {
  test("Ctrl-C quits, Ctrl-R reloads, Alt-← goes back; other keys, Ctrl-letters and text go to the page; the cell reply is read", () => {
    expect(parseInput("\u0003\u0012\u001b[1;3D\u001bb").inputs).toEqual([Input.Quit(), Input.Reload(), Input.Back(), Input.Back()])
    expect(parseInput("hi q\r\u007f\t\u001b[Z\u001b[3~\u001b[A\u001bOD\u001b[1;5D").inputs).toEqual([
      Input.Text({ text: "hi q" }),
      Input.Key({ key: "Enter", mods: NO_MODS }),
      Input.Key({ key: "Backspace", mods: NO_MODS }),
      Input.Key({ key: "Tab", mods: NO_MODS }),
      Input.Key({ key: "Tab", mods: { ...NO_MODS, shift: true } }),
      Input.Key({ key: "Delete", mods: NO_MODS }),
      Input.Key({ key: "ArrowUp", mods: NO_MODS }),
      Input.Key({ key: "ArrowLeft", mods: NO_MODS }),
      Input.Key({ key: "ArrowLeft", mods: { ...NO_MODS, ctrl: true } }),
    ])
    expect(parseInput("\u001b")).toEqual({ inputs: [Input.Key({ key: "Escape", mods: NO_MODS })], rest: "" })
    expect(parseInput("\u0001\u001b")).toEqual({ inputs: [Input.Control({ letter: "a" })], rest: "\u001b" })
    expect(parseInput("\u001b[6;38;12t\u001b[4;836;984t").inputs).toEqual([Input.Cell({ cell: { width: 12, height: 38 } })])
    expect(parseInput("x\u001b[1;3").rest).toBe("\u001b[1;3")
  })
})

describe("what the page is sent", () => {
  const layout = layoutOf({ cols: 80, rows: 24 }, { width: 8, height: 16 }, Option.none())

  test("a press and release at a cell are the mouse at that cell's middle in the page; the header takes no clicks; a wheel step scrolls", () => {
    expect(mouseCommands(Mouse.Press({ button: "left", col: 9, row: 3, mods: NO_MODS }), layout)).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 68, y: 24, modifiers: 0, button: "left", buttons: 1, clickCount: 1 } },
    ])
    expect(mouseCommands(Mouse.Release({ button: "left", col: 9, row: 3, mods: NO_MODS }), layout)).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 68, y: 24, modifiers: 0, button: "left", buttons: 0, clickCount: 1 } },
    ])
    expect(mouseCommands(Mouse.Press({ button: "left", col: 9, row: 1, mods: NO_MODS }), layout)).toEqual([])
    expect(mouseCommands(Mouse.Wheel({ direction: "down", col: 1, row: 2, mods: { ...NO_MODS, shift: true } }), layout)).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 4, y: 8, modifiers: 8, deltaX: 0, deltaY: 100 } },
    ])
  })

  test("a typed character is a key press that types it, a paste is inserted, Enter types a return, back and reload are the tab's own", () => {
    expect(keyCommands(Input.Text({ text: "q" }))).toEqual([
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "q", code: "", windowsVirtualKeyCode: 81, modifiers: 0, text: "q", unmodifiedText: "q" } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "q", code: "", windowsVirtualKeyCode: 81, modifiers: 0 } },
    ])
    expect(keyCommands(Input.Text({ text: "hello rex" }))).toEqual([{ method: "Input.insertText", params: { text: "hello rex" } }])
    expect(keyCommands(Input.Key({ key: "Enter", mods: NO_MODS }))[0].params).toMatchObject({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
    expect(keyCommands(Input.Key({ key: "Backspace", mods: NO_MODS }))[0].params).toMatchObject({ type: "rawKeyDown", key: "Backspace", windowsVirtualKeyCode: 8 })
    expect(keyCommands(Input.Control({ letter: "a" }))[0].params).toMatchObject({ type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 })
    expect(keyCommands(Input.Back())).toEqual([{ method: "Runtime.evaluate", params: { expression: "history.back()" } }])
    expect(keyCommands(Input.Reload())).toEqual([{ method: "Page.reload", params: {} }])
  })
})
