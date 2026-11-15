// A live browser tab in the showcase pane, the pure part: where the tab's
// frames go in the pane and which page point a cell stands for; what the
// pane's input means (SGR 1006 mouse reports, keys, typed text); and the
// DevTools protocol commands each input becomes. The header line names the
// page and the keys. Quitting: Ctrl-C always; `q` too when no field in the
// page has the focus (in a field it is typed).
import { Data, Option } from "effect"
import { type Cells, type CellPixels, drawBase64, fit, type Size } from "./graphics.ts"
import type { Command, Json } from "./service.ts"
import { viewport } from "./shots.ts"

const ESC = "\u001b"
const DIM = `${ESC}[2m`
const RESET = `${ESC}[0m`

/** The most frames a second the pane draws by default. Measured on the workbox: a long text page in a Mac-sized pane (82 × 35 cells of 12 × 38 px) is a frame of about 540 KiB as written, and the ssh link the Mac app reads the workbox over carries about 9.7 MiB/s, so about 18 such frames a second at most; 6 leaves two thirds of the link. The pane itself took 30 a second of small frames. */
export const LIVE_FPS = 6

/** The lines above the tab's frames: the header. */
export const HEADER_ROWS = 1

/** The image id each frame is drawn under, so a new frame replaces the last in place. */
export const LIVE_IMAGE = 7501

/** Mouse reporting on (presses and releases, drags, SGR 1006 encoding), and off again. */
export const MOUSE_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`
export const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`

/** Where the tab sits in a pane: the rows above it, the cells its frames take, its viewport in CSS pixels, and the largest frame worth sending, in pixels. */
export interface Layout {
  readonly top: number
  readonly cells: Cells
  readonly view: Size
  readonly max: Size
}

/**
 * The layout in a pane of `size` cells of `cell` pixels: the room under the
 * header (a line kept free at the bottom), a viewport `width` CSS pixels
 * wide (else as wide as the room's pixels) and as tall as the room's
 * shape, and frames no larger than the room's pixels.
 */
export const layoutOf = (size: Cells, cell: CellPixels, width: Option.Option<number>): Layout => {
  const room = { cols: Math.max(1, size.cols), rows: Math.max(1, size.rows - HEADER_ROWS - 1) }
  const max = { width: Math.max(1, Math.round(room.cols * cell.width)), height: Math.max(1, Math.round(room.rows * cell.height)) }
  const view = viewport(Option.getOrElse(width, () => max.width), room, cell)
  return { top: HEADER_ROWS, cells: fit(view, room, cell), view, max }
}

/** A point in the page, in CSS pixels. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** The page point the pane's cell at `col`, `row` (1-based, as mouse reports count) stands for: the middle of that cell's part of the page; none off the frames. */
export const toPage = (layout: Layout, col: number, row: number): Option.Option<Point> => {
  const across = col - 1
  const down = row - 1 - layout.top
  if (across < 0 || down < 0 || across >= layout.cells.cols || down >= layout.cells.rows) return Option.none()
  return Option.some({ x: ((across + 0.5) * layout.view.width) / layout.cells.cols, y: ((down + 0.5) * layout.view.height) / layout.cells.rows })
}

/** The keys held with a mouse report or a key. */
export interface Mods {
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
}

export const NO_MODS: Mods = { shift: false, alt: false, ctrl: false }

export type Button = "left" | "middle" | "right"
export type Direction = "up" | "down" | "left" | "right"

/** One SGR mouse report: a press, a release, a move with a button held (none: hovering), or a wheel step, at a 1-based cell. */
export type Mouse = Data.TaggedEnum<{
  Press: { readonly button: Button; readonly col: number; readonly row: number; readonly mods: Mods }
  Release: { readonly button: Button; readonly col: number; readonly row: number; readonly mods: Mods }
  Drag: { readonly button: Option.Option<Button>; readonly col: number; readonly row: number; readonly mods: Mods }
  Wheel: { readonly direction: Direction; readonly col: number; readonly row: number; readonly mods: Mods }
}>
export const Mouse = Data.taggedEnum<Mouse>()

const BUTTONS: ReadonlyArray<Button> = ["left", "middle", "right"]
const DIRECTIONS: ReadonlyArray<Direction> = ["up", "down", "left", "right"]

const modBits = (mods: Mods) => Number(mods.shift) * 4 + Number(mods.alt) * 8 + Number(mods.ctrl) * 16
const modsOf = (code: number): Mods => ({ shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 })

/** `mouse` as the terminal reports it with SGR 1006: `ESC [ < code ; col ; row` and `M`, or `m` for a release. */
export const encodeSgr = (mouse: Mouse): string => {
  const [code, final] = Mouse.$match(mouse, {
    Press: ({ button, mods }) => [BUTTONS.indexOf(button) + modBits(mods), "M"] as const,
    Release: ({ button, mods }) => [BUTTONS.indexOf(button) + modBits(mods), "m"] as const,
    Drag: ({ button, mods }) => [32 + Option.match(button, { onNone: () => 3, onSome: (held) => BUTTONS.indexOf(held) }) + modBits(mods), "M"] as const,
    Wheel: ({ direction, mods }) => [64 + DIRECTIONS.indexOf(direction) + modBits(mods), "M"] as const,
  })
  return `${ESC}[<${code};${mouse.col};${mouse.row}${final}`
}

/** The mouse report `code`, `col`, `row` and its final byte stand for; none for a code SGR does not use. */
export const decodeSgr = (code: number, col: number, row: number, final: string): Option.Option<Mouse> => {
  const mods = modsOf(code)
  const low = code & 3
  if ((code & 64) !== 0) return Option.map(Option.fromUndefinedOr(DIRECTIONS[low]), (direction) => Mouse.Wheel({ direction, col, row, mods }))
  if ((code & 32) !== 0) return Option.some(Mouse.Drag({ button: Option.fromUndefinedOr(BUTTONS[low]), col, row, mods }))
  return Option.map(Option.fromUndefinedOr(BUTTONS[low]), (button) =>
    Option.match(Option.liftPredicate(final, (byte) => byte === "m"), {
      onSome: () => Mouse.Release({ button, col, row, mods }),
      onNone: () => Mouse.Press({ button, col, row, mods }),
    }),
  )
}

/** The named keys the pane passes to the page. */
export type KeyName = "Enter" | "Backspace" | "Tab" | "Escape" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown"

/** What the pane's input means: a mouse report, a key, typed text, the terminal's reply giving its cells' size in pixels, or one of the pane's own keys. */
export type Input = Data.TaggedEnum<{
  Pointer: { readonly mouse: Mouse }
  Key: { readonly key: KeyName; readonly mods: Mods }
  Control: { readonly letter: string }
  Text: { readonly text: string }
  Cell: { readonly cell: CellPixels }
  Quit: {}
  Back: {}
  Reload: {}
}>
export const Input = Data.taggedEnum<Input>()

const CSI_KEYS = { A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End" } satisfies Readonly<Record<string, KeyName>>
const TILDE_KEYS = { "1": "Home", "7": "Home", "4": "End", "8": "End", "3": "Delete", "5": "PageUp", "6": "PageDown" } satisfies Readonly<Record<string, KeyName>>
const BYTE_KEYS = { "\r": "Enter", "\n": "Enter", "\t": "Tab", "\u007f": "Backspace", "\b": "Backspace" } satisfies Readonly<Record<string, KeyName>>

/** The key `name` stands for in `table`, if any. */
const keyIn = (table: Readonly<Record<string, KeyName>>, name: string): Option.Option<KeyName> => Option.fromUndefinedOr(table[name])

/** A CSI key's modifiers from its `1 ; m` parameter (xterm: m - 1 is shift 1, alt 2, ctrl 4). */
const csiMods = (params: string): Mods => {
  const bits = Math.max(0, Number(Option.getOrElse(Option.fromUndefinedOr(params.split(";")[1]), () => "1")) - 1)
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 }
}

/** A key, or Back for Alt-← alone. */
const keyInput = (key: KeyName, mods: Mods): Input =>
  Option.match(
    Option.liftPredicate(key, (name) => name === "ArrowLeft" && mods.alt && !mods.ctrl && !mods.shift),
    { onSome: () => Input.Back(), onNone: () => Input.Key({ key, mods }) },
  )

const CELL_REPLY = new RegExp(String.raw`^\u001b\[6;(\d+);(\d+)t`)
const SGR = new RegExp(String.raw`^\u001b\[<(\d+);(\d+);(\d+)([Mm])`)
const CSI = new RegExp(String.raw`^\u001b\[([0-9;]*)([A-Za-z~])`)
const SS3 = new RegExp(String.raw`^\u001bO([A-DHF])`)
const PARTIAL = new RegExp(String.raw`^\u001b(\[[<0-9;]*|O)?$`)
const PRINTABLE = new RegExp(String.raw`^[^\u0000-\u001f\u007f]+`)

/** One input at the start of `text`, and how many characters it took; none when `text` holds only the start of a sequence. */
const first = (text: string): Option.Option<{ readonly input: Option.Option<Input>; readonly length: number }> => {
  const sgr = SGR.exec(text)
  if (sgr) return Option.some({ input: Option.map(decodeSgr(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4]), (mouse) => Input.Pointer({ mouse })), length: sgr[0].length })
  const reply = CELL_REPLY.exec(text)
  if (reply) return Option.some({ input: Option.some(Input.Cell({ cell: { width: Number(reply[2]), height: Number(reply[1]) } })), length: reply[0].length })
  const csi = CSI.exec(text)
  if (csi) {
    const named = Option.orElse(keyIn(CSI_KEYS, csi[2]), () =>
      Option.filter(keyIn(TILDE_KEYS, csi[1].split(";")[0]), () => csi[2] === "~"),
    )
    const shiftTab = Option.liftPredicate(Input.Key({ key: "Tab", mods: { ...NO_MODS, shift: true } }), () => csi[2] === "Z")
    return Option.some({ input: Option.orElse(Option.map(named, (key) => keyInput(key, csiMods(csi[1]))), () => shiftTab), length: csi[0].length })
  }
  const ss3 = SS3.exec(text)
  if (ss3) return Option.some({ input: Option.map(keyIn(CSI_KEYS, ss3[1]), (key) => keyInput(key, NO_MODS)), length: 3 })
  if (PARTIAL.test(text) && text.length > 1) return Option.none()
  if (text.startsWith(`${ESC}b`)) return Option.some({ input: Option.some(Input.Back()), length: 2 })
  if (text.startsWith(ESC)) return Option.some({ input: Option.some(Input.Key({ key: "Escape", mods: NO_MODS })), length: 1 })
  const char = text[0]
  if (char === "\u0003") return Option.some({ input: Option.some(Input.Quit()), length: 1 })
  if (char === "\u0012") return Option.some({ input: Option.some(Input.Reload()), length: 1 })
  const byteKey = keyIn(BYTE_KEYS, char)
  if (Option.isSome(byteKey)) return Option.some({ input: Option.some(Input.Key({ key: byteKey.value, mods: NO_MODS })), length: 1 })
  const code = char.charCodeAt(0)
  if (code >= 1 && code <= 26) return Option.some({ input: Option.some(Input.Control({ letter: String.fromCharCode(code + 96) })), length: 1 })
  const printable = PRINTABLE.exec(text)
  if (printable) return Option.some({ input: Option.some(Input.Text({ text: printable[0] })), length: printable[0].length })
  return Option.some({ input: Option.none(), length: 1 })
}

/** What a read of the pane's input holds: its inputs, and the start of a sequence the next read ends. */
export interface Read {
  readonly inputs: ReadonlyArray<Input>
  readonly rest: string
}

/** The inputs in `text` (a chunk the pane read), and what is left: the start of a sequence the next chunk ends. */
export const parseInput = (text: string): Read => {
  const inputs: Array<Input> = []
  let at = 0
  while (at < text.length) {
    // A lone ESC is the Escape key when a read holds only it; after other input, it is the start of a sequence the next read ends.
    if (at > 0 && text.slice(at) === ESC) return { inputs, rest: ESC } satisfies Read
    const found = first(text.slice(at))
    if (Option.isNone(found)) return { inputs, rest: text.slice(at) } satisfies Read
    if (Option.isSome(found.value.input)) inputs.push(found.value.input.value)
    at += found.value.length
  }
  return { inputs, rest: "" } satisfies Read
}

/** The DevTools protocol's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiers = (mods: Mods) => Number(mods.alt) + Number(mods.ctrl) * 2 + Number(mods.shift) * 8

/** The protocol's `buttons` bit for each button. */
const BUTTON_BITS: Readonly<Record<Button, number>> = { left: 1, right: 2, middle: 4 }

const mouseEvent = (type: string, at: Point, params: Readonly<Record<string, Json>>, mods: Mods): Command => ({
  method: "Input.dispatchMouseEvent",
  params: { type, x: at.x, y: at.y, modifiers: modifiers(mods), ...params },
})

/** The pixels one wheel step scrolls. */
const WHEEL_STEP = 100

const WHEEL: Readonly<Record<Direction, Point>> = { up: { x: 0, y: -WHEEL_STEP }, down: { x: 0, y: WHEEL_STEP }, left: { x: -WHEEL_STEP, y: 0 }, right: { x: WHEEL_STEP, y: 0 } }

/** The commands a mouse report becomes in `layout`: none off the frames. */
export const mouseCommands = (mouse: Mouse, layout: Layout): ReadonlyArray<Command> =>
  Option.match(toPage(layout, mouse.col, mouse.row), {
    onNone: () => [],
    onSome: (at) =>
      Mouse.$match(mouse, {
        Press: ({ button, mods }) => [mouseEvent("mousePressed", at, { button, buttons: BUTTON_BITS[button], clickCount: 1 }, mods)],
        Release: ({ button, mods }) => [mouseEvent("mouseReleased", at, { button, buttons: 0, clickCount: 1 }, mods)],
        Drag: ({ button, mods }) => [
          mouseEvent(
            "mouseMoved",
            at,
            Option.match(button, { onNone: () => ({ button: "none", buttons: 0 }), onSome: (held) => ({ button: held, buttons: BUTTON_BITS[held] }) }),
            mods,
          ),
        ],
        Wheel: ({ direction, mods }) => [mouseEvent("mouseWheel", at, { deltaX: WHEEL[direction].x, deltaY: WHEEL[direction].y }, mods)],
      }),
  })

/** Each named key's DOM code and Windows key code, and the text it types. */
const KEYS: Readonly<Record<KeyName, { readonly code: string; readonly vk: number; readonly text: string }>> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8, text: "" },
  Tab: { code: "Tab", vk: 9, text: "" },
  Escape: { code: "Escape", vk: 27, text: "" },
  Delete: { code: "Delete", vk: 46, text: "" },
  ArrowUp: { code: "ArrowUp", vk: 38, text: "" },
  ArrowDown: { code: "ArrowDown", vk: 40, text: "" },
  ArrowLeft: { code: "ArrowLeft", vk: 37, text: "" },
  ArrowRight: { code: "ArrowRight", vk: 39, text: "" },
  Home: { code: "Home", vk: 36, text: "" },
  End: { code: "End", vk: 35, text: "" },
  PageUp: { code: "PageUp", vk: 33, text: "" },
  PageDown: { code: "PageDown", vk: 34, text: "" },
}

const keyEvent = (type: string, params: Readonly<Record<string, Json>>): Command => ({ method: "Input.dispatchKeyEvent", params: { type, ...params } })

/** A key down (typing its text when it has one) and up. */
const press = (key: string, code: string, vk: number, text: string, mods: Mods): ReadonlyArray<Command> => {
  const fields = { key, code, windowsVirtualKeyCode: vk, modifiers: modifiers(mods) }
  const down = Option.match(Option.liftPredicate(text, (typed) => typed !== ""), {
    onNone: () => keyEvent("rawKeyDown", fields),
    onSome: (typed) => keyEvent("keyDown", { ...fields, text: typed, unmodifiedText: typed }),
  })
  return [down, keyEvent("keyUp", fields)]
}

/** The commands a key, a Ctrl-letter or typed text becomes: one character as a key press (so the page sees it typed), more (a paste) inserted at once. */
export const keyCommands = (input: Input): ReadonlyArray<Command> =>
  Input.$match(input, {
    Key: ({ key, mods }) => press(key, KEYS[key].code, KEYS[key].vk, Option.getOrElse(Option.liftPredicate(KEYS[key].text, () => !mods.ctrl && !mods.alt), () => ""), mods),
    Control: ({ letter }) => press(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), "", { ...NO_MODS, ctrl: true }),
    Text: ({ text }) =>
      Option.match(Option.liftPredicate(text, (typed) => Array.from(typed).length === 1), {
        onSome: (char) => press(char, "", char.toUpperCase().charCodeAt(0), char, NO_MODS),
        onNone: () => [{ method: "Input.insertText", params: { text } }],
      }),
    Pointer: () => [],
    Quit: () => [],
    Cell: () => [],
    Back: () => [BACK],
    Reload: () => [RELOAD],
  })

/** Back in the tab's history, and reload. */
export const BACK: Command = { method: "Runtime.evaluate", params: { expression: "history.back()" } }
export const RELOAD: Command = { method: "Page.reload", params: {} }

/** Whether a field in the page has the focus (an input, a text area, a select or editable content): there `q` is typed, not a quit. */
export const EDITING = `(() => { const at = document.activeElement; return Boolean(at) && (at.isContentEditable || /^(input|textarea|select)$/i.test(at.tagName)) })()`

/** The commands that size the tab to `layout` and (re)start its screencast at the largest frame worth sending. */
export const viewCommands = (layout: Layout): ReadonlyArray<Command> => [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: layout.view.width, height: layout.view.height, deviceScaleFactor: 1, mobile: false } },
  { method: "Page.stopScreencast", params: {} },
  { method: "Page.startScreencast", params: { format: "png", maxWidth: layout.max.width, maxHeight: layout.max.height, everyNthFrame: 1 } },
]

const cut = (text: string, cols: number) => Array.from(text).slice(0, Math.max(1, cols)).join("")

const KEYS_LINE = "Alt-← back · Ctrl-R reload · Ctrl-C quit"

/** The header in `cols` columns: the page's address, then the keys while the address keeps a dozen columns. */
export const headerText = (url: string, cols: number): string => {
  const room = cols - Array.from(KEYS_LINE).length - 3
  if (room < 12) return cut(url, cols)
  return `${cut(url, room)} · ${KEYS_LINE}`
}

/** The header line drawn again in place (the cursor left where it was not needed). */
export const drawHeader = (url: string, cols: number): string => `${ESC}[1;1H${ESC}[2K${DIM}${headerText(url, cols)}${RESET}`

/** The pane made ready for the tab: pictures and screen cleared, the cursor hidden, the header, a line saying what opens, and `status` (the tally's report, or its clearing). */
export const drawIntro = (url: string, cols: number, status: string): string =>
  `${ESC}[?25l${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[H${ESC}[2J${ESC}[3J${drawHeader(url, cols)}\r\n${DIM}${cut(`opening ${url}…`, cols)}${RESET}${status}`

/** A frame drawn in place under the header, replacing the last. */
export const drawFrame = (frame: { readonly data: string }, layout: Layout): string =>
  `${ESC}[${layout.top + 1};1H${drawBase64(frame.data, layout.cells, `i=${LIVE_IMAGE},C=1,`)}`
