// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// Determinism of the simulated TUI: for 20 seeds, a sequence the seed draws
// (send a prompt, the reply streamed in pieces the seed cuts, a key, a resize,
// time moved, a child session started and ended; up to 30 steps) run twice in
// one app gives the same trace: every frame's text and styles, every request
// the TUI made, in order, at its virtual time (ids named by first appearance,
// as two runs in one app draw different ones). Across the 20 seeds at least 5
// traces differ, and no trace holds a wall-clock value.
import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import * as App from "./app.ts"
import { effectTest } from "./effect-test.ts"
import { MODEL_REF, type Model, reasoning, stall, subagent, text } from "./server.ts"
import { hangGuard } from "../tests/hang-guard.ts"

const FILE = "sim-tui/app.test.tsx"
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 120, height: 36 }
const SEEDS = 20
const STEPS = 30

const WORDS = ["parser", "helper", "docs", "tests", "money", "rename", "split", "cache"]
const BRIEF = "Worker brief."

/** The scripted model: a reply from the prompt's words; `spawn` starts one background worker, which thinks and holds. */
const model: Model = ({ text: prompt, step }) => {
  if (prompt.includes(BRIEF)) return [reasoning("Looking at it first."), stall]
  if (step > 0) return []
  if (prompt.includes("spawn"))
    return [
      text("Starting a worker."),
      subagent({
        id: "call_worker",
        input: { description: "Check the parser", prompt: BRIEF, background: true },
        title: "Check the parser",
        agent: "worker",
        model: MODEL_REF,
      }),
    ]
  return [text(`About the ${prompt.split(" ").at(-1) ?? "ask"}: it is done, in a few words more than one.`)]
}

/** One step of a generated sequence. */
const Step = Schema.TaggedUnion({
  Send: { text: Schema.String },
  Key: { name: Schema.String },
  Resize: { cols: Schema.Number },
  Advance: { ms: Schema.Number },
  EndChild: {},
})
type Step = typeof Step.Type

/** The sequence `seed` draws: its length, then each step. */
const sequence = (seed: number): ReadonlyArray<Step> => {
  const draw = App.drawFrom(seed * 7919)
  const length = 5 + draw(STEPS - 4)
  return Array.from({ length }, (): Step => {
    const pick = draw(6)
    if (pick === 0) return Step.cases.Send.make({ text: `spawn a worker for the ${WORDS[draw(WORDS.length)]}` })
    if (pick === 1) return Step.cases.Send.make({ text: `Look at the ${WORDS[draw(WORDS.length)]}` })
    if (pick === 2) return Step.cases.Key.make({ name: ["x", "escape"][draw(2)] ?? "x" })
    if (pick === 3) return Step.cases.Resize.make({ cols: 90 + draw(70) })
    if (pick === 4) return Step.cases.Advance.make({ ms: 100 + draw(4_900) })
    return Step.cases.EndChild.make({})
  })
}

/** Runs `seed`'s sequence once (`run` picks the ids) and returns its trace. */
const play = (seed: number, run: number) =>
  App.seed(BOOT, { key: "determinism", seed, run, model }, (tui) =>
    Effect.gen(function* () {
      for (const step of sequence(seed)) {
        if (step._tag === "Send") {
          yield* tui.type(step.text)
          yield* tui.press({ name: "enter" })
        }
        if (step._tag === "Key") yield* tui.press({ name: step.name })
        if (step._tag === "Resize") yield* tui.resize(step.cols, BOOT.height)
        if (step._tag === "Advance") yield* tui.advance(step.ms)
        if (step._tag === "EndChild") {
          for (const child of tui.server.children(tui.sessionID)) tui.server.release(child, " Done.")
          yield* tui.settle
        }
      }
      return App.canonical(tui.trace())
    }),
  )

App.bootTest(BOOT)

effectTest(
  "a seed's sequence run twice gives one trace; the seeds give at least 5; no trace holds the wall clock",
  Effect.gen(function* () {
    const traces = new Set<string>()
    for (let seed = 1; seed <= SEEDS; seed++) {
      const first = yield* play(seed, 0)
      const second = yield* play(seed, 1)
      expect({ seed, trace: second }).toEqual({ seed, trace: first })
      expect(first.filter((line) => line.includes(" frame ")).length).toBeGreaterThan(0)
      expect(first.filter((line) => line.includes(" request ")).length).toBeGreaterThan(0)
      traces.add(first.join("\n"))
      // A wall-clock value is a number of milliseconds within a day of now; the trace's times are virtual.
      const wall = yield* App.wallNow
      const numbers = first.join(" ").match(/\d{12,}/g) ?? []
      expect(numbers.filter((value) => Math.abs(Number(value) - wall) < 86_400_000)).toEqual([])
    }
    expect(traces.size).toBeGreaterThanOrEqual(5)
  }),
  hangGuard("acceptance"),
)

/** Whether the frame draws the reply to the prompt that ends in `word`. */
const draws = (text: ReadonlyArray<string>, word: string) => text.some((line) => line.includes(`About the ${word}: it is done`))

// The client drops an event stream silent for 45 s and reconnects, and a reconnect draws a blank body; the real
// server's heartbeat keeps a quiet one open. A seed quiet past 45 s of virtual time keeps its stream (`settle`
// fails on a drop or a reopen) and its body: every frame drawn over the quiet stretch, and after the next turn,
// still draws the turn drawn before it.
effectTest(
  "a stream quiet past the client's 45 s idle watchdog stays open and its body stays drawn: the harness sends the server's heartbeat",
  App.seed(BOOT, { key: "quiet", seed: 1, model }, (tui) =>
    Effect.gen(function* () {
      yield* tui.type("Look at the docs")
      yield* tui.press({ name: "enter" })
      yield* tui.until("the first reply", (text) => draws(text, "docs"))
      const from = tui.elapsed()
      const [, quiet] = yield* tui.record(tui.advance(50_000))
      // A reconnect fetches the session's messages again: a request the quiet stretch makes only by reconnecting.
      const refetched = tui
        .trace()
        .filter((entry) => entry.kind === "request" && entry.at >= from && entry.value.startsWith(`GET /api/session/${tui.sessionID}/message`))
        .map((entry) => `${entry.at} ${entry.value}`)
      yield* tui.type("Look at the tests")
      yield* tui.press({ name: "enter" })
      yield* tui.until("the second reply", (text) => draws(text, "tests"))
      expect({ refetched, blank: quiet.filter((frame) => !draws(frame, "docs")), afterNext: draws(tui.text(), "docs") }).toEqual({ refetched: [], blank: [], afterNext: true })
    }),
  ),
  hangGuard("acceptance"),
)

// The renderer keeps the last pointer and lights whatever comes to sit under it. A seed starts with the pointer off
// the screen: a seed after one that left it over the footer's Theme item draws what it draws after one that did not.
const asked = (run: number) =>
  App.seed(BOOT, { key: "pointer", seed: 1, run, model }, (tui) =>
    Effect.gen(function* () {
      yield* tui.type("Look at the docs")
      yield* tui.press({ name: "enter" })
      yield* tui.until("the reply", (text) => draws(text, "docs"))
      return App.canonical(tui.trace())
    }),
  )
/** A line's text and colours, to tell a lit item from an unlit one. */
const styled = (frame: App.Frame, line: number) => frame.lines[line]?.spans ?? []

effectTest(
  "a pointer the seed before left over an item lights nothing in the next seed",
  Effect.gen(function* () {
    const alone = yield* asked(0)
    const lit = yield* App.seed(BOOT, { key: "pointer-left", seed: 1, model }, (tui) =>
      Effect.gen(function* () {
        yield* tui.settle
        const line = tui.text().findLastIndex((row) => row.includes("Theme"))
        const before = styled(tui.frame(), line)
        yield* tui.mouse({ action: "move", x: (tui.text()[line] ?? "").indexOf("Theme") + 1, y: line })
        return { line, before, after: styled(tui.frame(), line) }
      }),
    )
    // The pointer lit the item it was left over.
    expect(lit.line).toBeGreaterThan(0)
    expect(lit.after).not.toEqual(lit.before)
    expect(yield* asked(1)).toEqual(alone)
  }),
  hangGuard("acceptance"),
)

App.closeTest()
