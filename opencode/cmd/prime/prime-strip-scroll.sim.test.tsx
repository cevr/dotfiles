// The subagent rows under the composer scroll in place under the wheel, in
// the Prime look, on the simulated TUI (sim-tui/): the fork's real TUI with
// Prime loaded by path, in front of the server double. The parent starts 39
// workers, so the strip draws six rows and counts the rest. Wheel steps down
// over the strip show rows 7–12 with a count line that says where they are;
// a step up and back down there leaves the transcript where it was; the wheel
// over the transcript scrolls it and leaves the strip. Scrolled to the bottom,
// a worker finishes and leaves: the window stays full and the offset stays
// (the clock ticking meanwhile). A click on a row scrolled into view opens
// that row's worker.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { MODEL_REF, type Model, stall, subagent, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-strip-scroll.sim.test.tsx"
/** Seeds this file runs: 39 workers make one seed heavy, so two. */
const SEEDS = 2
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 120, height: 44 }

App.bootTest(BOOT)

const COUNT = 39
const ASK = "Start the thirty-nine workers."
/** The parent's answer: long enough that the transcript scrolls. */
const STARTED = ["All workers are on it.", ...Array.from({ length: 60 }, (_, index) => `- started line ${String(index + 1).padStart(2, "0")}`)].join("\n")
const LAST = "- started line 60"
const title = (index: number) => `Worker ${String(index + 1).padStart(2, "0")}`
const brief = (index: number) => `Worker brief ${String(index + 1).padStart(2, "0")}.`
const WORKING = "Reading the code"
const NAMES = ["top", "scrolled", "back", "transcript", "bottom", "finished", "opened"] as const
type Name = (typeof NAMES)[number]

const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
/** The strip's rows, top to bottom: each frame row naming a worker, past the transcript (the strip sits under the composer). */
const COUNT_LINE = /(\+\d+ more|\d+–\d+ of \d+)/
const countRow = (frame: ReadonlyArray<string>) => frame.findLastIndex((line) => COUNT_LINE.test(line))
const stripRows = (frame: ReadonlyArray<string>) => {
  const end = countRow(frame)
  return frame.slice(Math.max(0, end - 6), end)
}
const workers = (frame: ReadonlyArray<string>) => stripRows(frame).map((line) => /Worker \d\d/.exec(line)?.[0] ?? "")
const countOf = (frame: ReadonlyArray<string>) => (frame[countRow(frame)] ?? "").trim()
/** The transcript's rows: everything above the strip's first row's block (the composer and dock sit between). */
const transcript = (frame: ReadonlyArray<string>) => frame.slice(1, 16)
/** The subagent whose view this is: the top bar ends its breadcrumb with its title. */
const viewing = (frame: ReadonlyArray<string>) => /› (Worker \d\d)/.exec(frame[0] ?? "")?.[1] ?? ""

const play = (seed: number) => {
  const model: Model = ({ text: prompt, step }) => {
    if (prompt === ASK) {
      const calls = Array.from({ length: COUNT }, (_, index) =>
        subagent({ id: `call_w${index}`, input: { agent: "general", description: title(index), prompt: brief(index), background: true }, title: title(index), agent: "general", model: MODEL_REF }),
      )
      return [calls, [text(STARTED)]][step] ?? []
    }
    if (prompt.includes("Worker brief") && step === 0) return [text(WORKING), stall]
    return []
  }
  return App.seed(BOOT, { key: "prime-strip-scroll", seed, model, title: () => "workers" }, (tui) =>
    Effect.gen(function* () {
      const shots = new Map<Name, ReadonlyArray<string>>()
      const save = (name: Name) => Effect.sync(() => shots.set(name, tui.text()))
      const wheel = (direction: "up" | "down", times: number, at: { readonly x: number; readonly y: number }) =>
        Effect.gen(function* () {
          for (let step = 0; step < times; step++) yield* tui.mouse({ action: "scroll", ...at, direction })
          yield* tui.advance(200)
        })
      /** A cell on the strip's last row. */
      const strip = () => ({ x: 30, y: countRow(tui.text()) - 1 })
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("started", (frame) => has(LAST)(frame) && has(`${COUNT} subagents`)(frame) && has("+33 more")(frame), 20_000)
      yield* tui.advance(1_000)
      yield* save("top")
      yield* wheel("down", 6, strip())
      yield* save("scrolled")
      // Up over the strip: the strip moves back, the transcript (at its end, so only up could move it) stays.
      yield* wheel("up", 3, strip())
      yield* save("back")
      yield* wheel("down", 3, strip())
      // The wheel over the transcript scrolls it and leaves the strip.
      yield* wheel("up", 5, { x: 30, y: 8 })
      yield* save("transcript")
      // To the bottom of the strip.
      yield* wheel("down", 40, strip())
      yield* tui.advance(1_000)
      yield* save("bottom")
      // A worker finishes, and past its linger it leaves; the clock ticks all the while.
      const last = tui.server.children(tui.sessionID).at(-1) ?? ""
      tui.server.release(last, " and done.")
      yield* tui.until("finished", has(`${COUNT - 1} subagents`), 10_000)
      yield* tui.advance(31_000)
      yield* tui.until("left", (frame) => !COUNT_LINE.test(countOf(frame)) || countOf(frame).includes(`of ${COUNT - 1}`), 10_000)
      yield* save("finished")
      // A click on the strip's first row opens the worker it shows.
      const at = { x: 30, y: countRow(tui.text()) - 6 }
      yield* tui.mouse({ action: "move", ...at })
      yield* tui.mouse({ action: "down", ...at })
      yield* tui.mouse({ action: "up", ...at })
      yield* tui.until("opened", (frame) => viewing(frame) !== "", 10_000)
      yield* tui.advance(500)
      yield* save("opened")
      const shot = (name: Name) => shots.get(name) ?? []
      return {
        top: shot("top"),
        scrolled: shot("scrolled"),
        back: shot("back"),
        transcript: shot("transcript"),
        bottom: shot("bottom"),
        finished: shot("finished"),
        opened: shot("opened"),
      } satisfies Record<Name, ReadonlyArray<string>>
    }),
  )
}

/** The scenario at `seed`, played once a seed (the tests read the same run). */
const played = new Map<number, Record<Name, ReadonlyArray<string>>>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => title(from - 1 + index))

seeded("at the top the strip draws the first six workers and counts the rest", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(workers(shots.top)).toEqual(range(1, 6))
    expect(countOf(shots.top)).toBe("+33 more · ↓ to see all")
  }),
)

seeded("six wheel steps down over the strip show workers 7–12 and say where they are, the strip keeping its height", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(workers(shots.scrolled)).toEqual(range(7, 12))
    expect(countOf(shots.scrolled)).toBe("7–12 of 39 · 6 above, 27 below · ↓ to see all")
    expect(countRow(shots.scrolled)).toBe(countRow(shots.top))
    expect(shots.scrolled.length).toBe(shots.top.length)
  }),
)

seeded("the wheel over the strip leaves the transcript; the wheel over the transcript leaves the strip", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(workers(shots.back)).toEqual(range(4, 9))
    expect(transcript(shots.back)).toEqual(transcript(shots.top))
    expect(transcript(shots.scrolled)).toEqual(transcript(shots.top))
    expect(transcript(shots.transcript)).not.toEqual(transcript(shots.top))
    expect(workers(shots.transcript)).toEqual(range(7, 12))
    expect(countOf(shots.transcript)).toBe(countOf(shots.scrolled))
  }),
)

seeded("scrolled to the bottom, a worker that finishes and leaves keeps the window full and the offset in place", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(workers(shots.bottom)).toEqual(range(34, 39))
    expect(countOf(shots.bottom)).toBe("34–39 of 39 · 33 above · ↓ to see all")
    expect(countOf(shots.finished)).toBe("33–38 of 38 · 32 above · ↓ to see all")
    expect(workers(shots.finished)).toEqual(range(33, 38))
  }),
)

seeded("a click on a row scrolled into view opens that row's worker", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(viewing(shots.opened)).toBe(title(32))
  }),
)

App.closeTest()
