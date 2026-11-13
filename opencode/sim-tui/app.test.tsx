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
import { MODEL_REF, type Model, reasoning, stall, subagent, text } from "./server.ts"

const FILE = "sim-tui/app.test.tsx"
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 120, height: 36 }
const SEEDS = 20
const STEPS = 30
/** The test plays 40 seed runs in one: its timeout. */
const TIMEOUT_MS = 300_000

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

App.effectTest(
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
  TIMEOUT_MS,
)

App.closeTest()
