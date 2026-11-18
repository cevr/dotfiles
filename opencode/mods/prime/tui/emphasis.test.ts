// The emphasis adapter on the pinned opentui: a MarkdownRenderable in
// opentui's test renderer and its native Markdown engine, hooked by `attach` as Prose hooks the host's Markdown. The final
// frame draws each chip with its colours, a table cell draws one, a streamed
// reply never shows a closed pill as typed, code and the source view stay as
// typed, and the hook runs after one the host set.
import { describe, expect } from "bun:test"
import { MarkdownRenderable, RGBA, SyntaxStyle, TextAttributes, type CapturedSpan } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect, Option, Schedule } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { SYMBOLS } from "@dotfiles/opencode-subagents/line"
import { attach, FILTER, findMarkdown, type Look } from "./emphasis.ts"

/** Each test boots a renderer and waits on tree-sitter's worker, in wall time. */
const TIMEOUT_MS = 20_000
/** Looks a frame may take to show what it waits for, one each `POLL`. */
const PASSES = 400
const POLL = "20 millis"

const SUCCESS = RGBA.fromHex("#22aa44")
const ERROR = RGBA.fromHex("#dd3333")
const INFO = RGBA.fromHex("#3388dd")
const WARNING = RGBA.fromHex("#ddaa22")
const GROUND = RGBA.fromHex("#113322")
const CODE = RGBA.fromHex("#00ff00")

const tone = (name: string) => {
  if (name === "error") return ERROR
  if (name === "info") return INFO
  if (name === "warning") return WARNING
  return SUCCESS
}

/** A look whose colours a span can be checked against: a soft chip its tone on GROUND, a solid one black on its tone. */
const look: Look = {
  chip: (pill) => {
    if (pill.word.form === "solid") return { fg: RGBA.fromValues(0, 0, 0, 1), bg: tone(pill.word.tone), attributes: TextAttributes.BOLD }
    return { fg: tone(pill.word.tone), bg: GROUND, attributes: 0 }
  },
  mark: (label) => tone(label.tone),
}

const REPLY = [
  "**Result:** [[Done]] the build passed. `[[Guess]]` is code, [[acknowledge-before-processing]] a wiki link.",
  "",
  "- **Waiting on you:** merge 21810. [[Irreversible]]",
  "- **Next:** the deep run [[Skipped]]",
  "",
  "| unit | state |",
  "|---|---|",
  "| draw | [[Failed: 3 tests]] |",
].join("\n")

/** A test renderer for one test, destroyed when it ends. */
const renderer = Effect.acquireRelease(
  Effect.promise(() => createTestRenderer({ width: 90, height: 16 })),
  (setup) => Effect.promise(() => setup.dispose()),
)

/** A Markdown as the host's ui.Markdown makes it (top-level blocks), on the renderer's root. */
const markdown = (setup: TestRendererSetup, options: { readonly conceal: boolean; readonly streaming: boolean; readonly content: string }) => {
  const syntaxStyle = SyntaxStyle.fromStyles(
    {
      default: { fg: RGBA.fromHex("#ffffff") },
      "markup.raw": { fg: CODE },
      "markup.strong": { fg: RGBA.fromHex("#ffffff"), bold: true },
      "markup.link.label": { fg: RGBA.fromHex("#8888ff") },
    },
    setup.renderer.nativeScene,
  )
  const made = new MarkdownRenderable(setup.renderer, { syntaxStyle, tableOptions: { style: "grid", cellPaddingX: 1 }, ...options })
  setup.renderer.root.add(made)
  return made
}

/** The frame once it shows what `ready` waits for: tree-sitter answers from its worker, in wall time. */
const until = (setup: TestRendererSetup, ready: (frame: string) => boolean) =>
  Effect.promise(() => setup.renderOnce()).pipe(
    Effect.map(() => setup.captureCharFrame()),
    Effect.filterOrFail(ready, () => "the frame never showed it"),
    Effect.retry({ schedule: Schedule.spaced(POLL), times: PASSES }),
    Effect.orDie,
  )

/** The span on screen whose text holds `text`. */
const spanOf = (setup: TestRendererSetup, text: string) =>
  Option.fromNullishOr(
    setup
      .captureSpans()
      .lines.flatMap((line): ReadonlyArray<CapturedSpan> => line.spans)
      .find((span) => span.text.includes(text)),
  )

/** A colour as 0–255 channels, however the capture carries it. */
const channels = (color: { readonly r: number; readonly g: number; readonly b: number }) => [color.r, color.g, color.b].map((value) => Math.round(value * 255))
const style = (span: Option.Option<CapturedSpan>) =>
  Option.map(span, (found) => ({ fg: channels(found.fg), bg: channels(found.bg), bold: (found.attributes & TextAttributes.BOLD) !== 0 }))

describe("attach on the pinned opentui", () => {
  effectTest(
    "runs after the host's own hook, on its blocks and on the ones that may hold a pill or a label",
    Effect.gen(function* () {
      const setup = yield* renderer
      const made = markdown(setup, { conceal: true, streaming: false, content: "ses_x then [[Done]]" })
      made.inlineHookFilter = ["ses_"]
      made.inlineHook = (spans) => spans.map((span) => ({ ...span, text: span.text.replace("ses_x", "@Title") }))
      attach(made, look)
      expect(made.inlineHookFilter).toEqual(["ses_", ...FILTER])
      const frame = yield* until(setup, (shown) => shown.includes("@Title"))
      expect(frame.split("\n")[0]?.trimEnd()).toBe("@Title then  ✓ Done")
      expect(Option.isSome(findMarkdown(setup.renderer.root))).toBe(true)
    }).pipe(Effect.scoped),
    TIMEOUT_MS,
  )

  effectTest(
    "the final frame: chips as wide as their source, labels' diamonds, code and unknown words as typed, a chip in a table cell",
    Effect.gen(function* () {
      const setup = yield* renderer
      const made = markdown(setup, { conceal: true, streaming: false, content: REPLY })
      attach(made, look)
      const frame = yield* until(setup, (shown) => shown.includes("Done") && shown.includes("Failed"))
      const lines = frame.split("\n").map((line) => line.trimEnd())
      expect(lines[0]).toBe("Result:  ✓ Done  the build passed. [[Guess]] is code, [acknowledge-before-processing] a")
      expect(lines).toContain(`- ${SYMBOLS.blocked} Waiting on you: merge 21810.  ! Irreversible`)
      expect(lines).toContain(`- ${SYMBOLS.idle} Next: the deep run  ◌ Skipped`)
      expect(lines.some((line) => line.includes(" ✗ Failed: 3 tests "))).toBe(true)
      expect(frame).not.toContain("[[Done]]")
      expect(frame).not.toContain("[Done]")
      expect(style(spanOf(setup, " ✓ Done "))).toEqual(Option.some({ fg: channels(SUCCESS), bg: channels(GROUND), bold: false }))
      expect(style(spanOf(setup, " ! Irreversible "))).toEqual(Option.some({ fg: [0, 0, 0], bg: channels(ERROR), bold: true }))
      expect(style(spanOf(setup, " ✗ Failed: 3 tests "))).toEqual(Option.some({ fg: channels(ERROR), bg: channels(GROUND), bold: false }))
      expect(Option.map(spanOf(setup, "[[Guess]]"), (span) => channels(span.fg))).toEqual(Option.some(channels(CODE)))
      expect(Option.map(spanOf(setup, SYMBOLS.blocked), (span) => channels(span.fg))).toEqual(Option.some(channels(WARNING)))
      expect(made.content).toBe(REPLY)
    }).pipe(Effect.scoped),
    TIMEOUT_MS,
  )

  effectTest(
    "a streamed reply: once a pill closes, no frame shows it as typed",
    Effect.gen(function* () {
      const setup = yield* renderer
      const made = markdown(setup, { conceal: true, streaming: true, content: "" })
      attach(made, look)
      const text = "**Running (mine):** the [[Done]] watch, then [[Measured]] disk at 89%.\n\nAnd a tail [[Blocked]] here."
      const raw: Array<string> = []
      for (let end = 4; end <= text.length; end += 3) {
        const shown = text.slice(0, end)
        made.content = shown
        yield* Effect.promise(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        for (const [index, pill] of ["[[Done]]", "[[Measured]]", "[[Blocked]]"].entries()) {
          const closed = shown.includes(pill)
          const word = ["Done", "Measured", "Blocked"][index] ?? ""
          if (closed && (frame.includes(pill) || frame.includes(`[${word}]`))) raw.push(`${end}: ${pill}`)
        }
      }
      made.content = text
      made.streaming = false
      const frame = yield* until(setup, (shown) => shown.includes(" ◆ Blocked ") && shown.includes(" ✓ Done "))
      expect(raw).toEqual([])
      expect(frame).toContain(`${SYMBOLS.working} Running (mine): the  ✓ Done  watch`)
    }).pipe(Effect.scoped),
    TIMEOUT_MS,
  )

  effectTest(
    "shown as source (conceal off), nothing is decorated",
    Effect.gen(function* () {
      const setup = yield* renderer
      const made = markdown(setup, { conceal: false, streaming: false, content: "**Next:** the [[Done]] run" })
      attach(made, look)
      const frame = yield* until(setup, (shown) => shown.includes("Done"))
      expect(frame.split("\n")[0]?.trimEnd()).toBe("**Next:** the [[Done]] run")
    }).pipe(Effect.scoped),
    TIMEOUT_MS,
  )
})
