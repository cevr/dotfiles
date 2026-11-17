// The emphasis vocabulary and its splitting, with no renderer: which `[[…]]`
// is a pill and how it draws, which bold lead span is a queue label, the
// edits over drawn runs on both of opentui's paths, the width law, and the
// prompt section built from the same table.
import { describe, expect, test } from "bun:test"
import { SYMBOLS } from "@dotfiles/opencode-subagents/line"
import { Option } from "effect"
import {
  ACCEPTED,
  chipText,
  decorate,
  emphasisOn,
  finalEdits,
  guidance,
  labelOf,
  leadLabel,
  pillOf,
  pillsIn,
  previewEdits,
  splice,
  WORDS,
  type Piece,
  type Run,
} from "./emphasis.ts"

/** A run with a style tag, so a test sees which run a piece of text kept. */
interface Styled extends Run {
  readonly style: string
}

const run = (text: string, style = "plain"): Styled => ({ text, style })

/** A piece drawn as its text, styled by what it is. */
const draw = (base: Styled, piece: Piece): Styled => {
  if (piece.kind === "mark") return { text: `${piece.label.mark} `, style: `mark:${piece.label.state}:${base.style}` }
  return { text: chipText(piece.pill), style: `chip:${piece.pill.word.word}:${base.style}` }
}

const shown = (runs: ReadonlyArray<Styled>) => runs.map((one) => one.text).join("")
const word = (text: string) => Option.map(pillOf(text), (pill) => pill.word.word)

describe("pills", () => {
  test("each taught word draws with its mark, tone and form", () => {
    const drawn = WORDS.map((entry) => [entry.word, entry.mark, entry.tone, entry.form])
    expect(drawn).toEqual([
      ["Measured", "●", "success", "soft"],
      ["Inferred", "○", "info", "soft"],
      ["Guess", "?", "warning", "soft"],
      ["Done", "✓", "success", "soft"],
      ["Failed", "✗", "error", "soft"],
      ["Blocked", "◆", "warning", "soft"],
      ["Skipped", "◌", "warning", "soft"],
      ["Costs money", "$", "error", "solid"],
      ["Irreversible", "!", "error", "solid"],
    ])
    for (const entry of WORDS) expect(word(entry.word)).toEqual(Option.some(entry.word))
  })

  test("a known word may carry detail after a space or a colon, kept as typed", () => {
    expect(Option.map(pillOf("Done 12/12"), chipText)).toEqual(Option.some(" ✓ Done 12/12 "))
    expect(Option.map(pillOf("Failed: 3 tests"), chipText)).toEqual(Option.some(" ✗ Failed: 3 tests "))
    expect(word("Costs money $40")).toEqual(Option.some("Costs money"))
  })

  test("accepted words draw as the taught word they mean, with their own text", () => {
    expect(ACCEPTED).toEqual([
      ["Passed", "Done"],
      ["Unverified", "Guess"],
    ])
    expect(Option.map(pillOf("Passed"), chipText)).toEqual(Option.some(" ✓ Passed "))
    expect(Option.map(pillOf("Unverified"), chipText)).toEqual(Option.some(" ? Unverified "))
  })

  test("anything else is not a pill: an unknown word, a longer word, another case, past 32 characters", () => {
    for (const text of ["acknowledge-before-processing", " -f x ", "Doneness", "done", "Costs", "Done-ish", `Done ${"x".repeat(28)}`])
      expect(pillOf(text)).toEqual(Option.none())
    expect(word(`Done ${"x".repeat(27)}`)).toEqual(Option.some("Done"))
    expect(pillsIn("see [[acknowledge-before-processing]] and [[ -f x ]] and [[Done]]").map((found) => found.pill.text)).toEqual(["Done"])
  })

  test("the width law: every chip is exactly as wide as its source", () => {
    const texts = [...WORDS.map((entry) => entry.word), ...ACCEPTED.map(([name]) => name), "Done 12/12", "Failed: 3 tests", "Blocked on the owner's login"]
    for (const text of texts)
      Option.match(pillOf(text), {
        onNone: () => expect(text).toBe("a pill"),
        onSome: (pill) => expect(Array.from(chipText(pill)).length).toBe(`[[${text}]]`.length),
      })
  })
})

describe("queue labels", () => {
  test("each lead label names its state, drawn with the subagent rows' diamond and tone", () => {
    const read = (text: string) => Option.map(labelOf(text), (label) => [label.state, label.mark, label.tone])
    expect(read("Running (mine):")).toEqual(Option.some(["working", SYMBOLS.working, "success"]))
    expect(read("Waiting on you:")).toEqual(Option.some(["blocked", SYMBOLS.blocked, "warning"]))
    expect(read("Waiting (yours):")).toEqual(Option.some(["blocked", SYMBOLS.blocked, "warning"]))
    expect(read("Waiting (other session):")).toEqual(Option.some(["waiting", SYMBOLS.waiting, "warning"]))
    expect(read("Dated:")).toEqual(Option.some(["latched", SYMBOLS.latched, "info"]))
    expect(read("Scheduled (mine, 18:00):")).toEqual(Option.some(["latched", SYMBOLS.latched, "info"]))
    expect(read("Held")).toEqual(Option.some(["latched", SYMBOLS.latched, "info"]))
    expect(read("Next:")).toEqual(Option.some(["idle", SYMBOLS.idle, "muted"]))
  })

  test("a bold span is a label only when it opens the block and names one", () => {
    expect(Option.isSome(leadLabel("**Running (mine):** the 95% watch."))).toBe(true)
    expect(Option.isSome(leadLabel("The **Running** row stays."))).toBe(false)
    expect(Option.isSome(leadLabel("**Nextjs:** an upgrade"))).toBe(false)
    expect(Option.isSome(leadLabel("**What wf10 did:**"))).toBe(false)
    expect(Option.isSome(leadLabel("Running (mine): no bold"))).toBe(false)
  })
})

describe("the final path: tree-sitter's runs with their source ranges", () => {
  // `**Result:** [[Done]] the build passed. `[[Guess]]` is code.` as tree-sitter hands it over:
  // the `**` and the inner brackets hidden, the code's backticks hidden.
  const content = "**Result:** [[Done]] the build passed. `[[Guess]]` is code."
  const runs = [run("Result:", "bold"), run(" [", "plain"), run("Done", "link"), run("] the build passed. ", "plain"), run("[[Guess]]", "code"), run(" is code.")]
  const ranges = [
    { start: 2, end: 9 },
    { start: 11, end: 13 },
    { start: 14, end: 18 },
    { start: 19, end: 39 },
    { start: 40, end: 49 },
    { start: 50, end: 59 },
  ]
  const raw: ReadonlyArray<readonly [number, number]> = [[39, 50]]

  test("a pill split over runs draws as one chip from its first run; code is left as typed", () => {
    const drawn = decorate(runs, { content, ranges, raw }, draw)
    expect(shown(drawn)).toBe("Result:  ✓ Done  the build passed. [[Guess]] is code.")
    expect(drawn.map((one) => one.style)).toEqual(["bold", "plain", "chip:Done:plain", "plain", "code", "plain"])
  })

  test("a pill inside bold draws as a chip over the bold run", () => {
    const source = "and **[[Failed]] here**"
    const bold = [run("and ", "plain"), run("[", "bold"), run("Failed", "bold-link"), run("] here", "bold")]
    const drawn = decorate(bold, { content: source, ranges: [{ start: 0, end: 4 }, { start: 6, end: 7 }, { start: 8, end: 14 }, { start: 15, end: 21 }], raw: [] }, draw)
    expect(shown(drawn)).toBe("and  ✗ Failed  here")
    expect(drawn.map((one) => one.style)).toEqual(["plain", "chip:Failed:bold", "bold"])
  })

  test("a run whose text is not as long as its source range leaves the pill over it as typed", () => {
    const edits = finalEdits([run("see "), run("[Done]")], { content: "see [[Done]]", ranges: [{ start: 0, end: 4 }, { start: 4, end: 12 }], raw: [] })
    expect(edits).toEqual([])
  })

  test("a lead label puts its diamond in front of the block", () => {
    const source = "**Waiting on you:** merge 21810."
    const drawn = decorate([run("Waiting on you:", "bold"), run(" merge 21810.")], { content: source, ranges: [{ start: 2, end: 17 }, { start: 19, end: 32 }], raw: [] }, draw)
    expect(shown(drawn)).toBe(`${SYMBOLS.blocked} Waiting on you: merge 21810.`)
    expect(drawn.map((one) => one.style)).toEqual(["mark:blocked:bold", "bold", "plain"])
  })

  test("with no highlights the source is one run, and its pills still draw", () => {
    const source = "**Next:** [[Skipped]] the deep run"
    const drawn = decorate([run(source)], { content: source, ranges: [{ start: 0, end: source.length }], raw: [] }, draw)
    expect(shown(drawn)).toBe(`${SYMBOLS.idle} **Next:**  ◌ Skipped  the deep run`)
  })
})

describe("the preview path: marked's runs, streaming and in table cells", () => {
  test("pills in the drawn text draw as chips; a run of code is left as typed", () => {
    const runs = [run("Result:", "bold"), run(" [[Done]] the build. "), run("[[Guess]]", "code"), run(" tail [[Measured]]")]
    const edits = previewEdits(runs, [false, false, true, false], labelOf("Result:"))
    expect(shown(splice(runs, edits, draw))).toBe("Result:  ✓ Done  the build. [[Guess]] tail  ● Measured ")
  })

  test("an open pill mid-stream stays as typed until its `]]` arrives", () => {
    expect(shown(splice([run("a [[Do")], previewEdits([run("a [[Do")], [false], Option.none()), draw))).toBe("a [[Do")
    expect(shown(splice([run("a [[Done]")], previewEdits([run("a [[Done]")], [false], Option.none()), draw))).toBe("a [[Done]")
    expect(shown(splice([run("a [[Done]]")], previewEdits([run("a [[Done]]")], [false], Option.none()), draw))).toBe("a  ✓ Done ")
  })

  test("a pill split over marked's runs draws once, in its first run's style", () => {
    const runs = [run("x [", "plain"), run("[Blocked]", "plain"), run("] y", "other")]
    const drawn = splice(runs, previewEdits(runs, [false, false, false], Option.none()), draw)
    expect(drawn.map((one) => [one.text, one.style])).toEqual([
      ["x ", "plain"],
      [" ◆ Blocked ", "chip:Blocked:plain"],
      [" y", "other"],
    ])
  })

  test("the label's diamond leads the preview as it leads the final block", () => {
    const runs = [run("Running (mine):", "bold"), run(" the watch")]
    expect(shown(splice(runs, previewEdits(runs, [false, false], labelOf("Running (mine):")), draw))).toBe(`${SYMBOLS.working} Running (mine): the watch`)
  })
})

describe("the prompt section", () => {
  test("names every taught word, and no pill that is not one", () => {
    const text = guidance()
    for (const entry of WORDS) expect(text).toContain(`[[${entry.word}]]`)
    for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) expect(Option.isSome(pillOf(match[1] ?? "")) || match[1] === "Word").toBe(true)
    for (const [name] of ACCEPTED) expect(text).not.toContain(name)
  })

  test("stays under 1,400 characters and is the same every time", () => {
    expect(guidance().length).toBeLessThan(1400)
    expect(guidance()).toBe(guidance())
    expect(guidance()).toStartWith("<reply_style>")
    expect(guidance()).toEndWith("</reply_style>")
  })
})

test("the option `emphasis` is on unless set to false", () => {
  expect(emphasisOn({})).toBe(true)
  expect(emphasisOn({ emphasis: true })).toBe(true)
  expect(emphasisOn({ emphasis: false })).toBe(false)
})
