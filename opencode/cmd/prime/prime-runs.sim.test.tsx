// tests/prime-runs.test.ts's names on the simulated TUI (sim-tui/), each at
// its first SEEDS seeds: the fork's real TUI in this process with Prime loaded
// by path, in front of the server double, on a virtual clock. Where a run of
// calls breaks in the Prime look: each model step is a group of its own, so a
// step's parallel calls share one header, the next step's call opens its own
// line even with nothing drawn between, and the assistant's text or a message
// the reader sent while the turn ran ends a group too; a long command running
// is the newest row. scenarios/prime-runs.ts step for step: two shells in one
// step, one in the next, then the text and a 6 s command the reader writes
// under, then a read of notes.md once the message is in.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { longShell, type Model, ranRead, ranShell, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-runs.sim.test.tsx"
/** Seeds this file runs: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime"],
  width: 106,
  height: 48,
  // Each call its own row, as these frames read them; the default (low) folds a turn's calls into one.
  config: { session: { verbosity: "medium" } },
}

App.bootTest(BOOT)

const ASK = "Check the build, then run the long suite."
const STEER = "Also read the notes file."
const LONG = "sleep 6; printf 'suite ok\\n'"
/** How long the long command runs: `sleep 6`. */
const LONG_MS = 6_000

const model: Model = ({ step, users }) => {
  const steps = [
    // One step with two calls in parallel, then a step of one call with nothing drawn between.
    [ranShell({ id: "call_a", command: "printf 'build a ok\\n'", output: "build a ok\n" }), ranShell({ id: "call_b", command: "printf 'build b ok\\n'", output: "build b ok\n" })],
    [ranShell({ id: "call_lint", command: "printf 'lint ok\\n'", output: "lint ok\n" })],
    // The long command, held until the test ends it LONG_MS later.
    [text("Both builds pass. Running the long suite."), longShell({ id: "call_long", command: LONG })],
    // Without the reader's message the model would just answer; with it, it reads the notes first.
    [[text("Suite passed.")], [ranRead({ id: "call_notes", path: "notes.md", output: "ship it\n" })]][Number(users.includes(STEER))] ?? [],
    [text("Suite passed; the notes say ship it.")],
  ]
  return steps[step] ?? []
}

const NAMES = ["runs-running", "runs", "runs-all", "runs-overview"] as const
type Name = (typeof NAMES)[number]

/** The hint line's index: the row right above the composer's rail, the frame's last run of ` ┃` rows. */
const hintAt = (frame: ReadonlyArray<string>) => {
  const last = frame.findLastIndex((line) => line.startsWith(" ┃"))
  return frame.slice(0, last + 1).findLastIndex((line) => !line.startsWith(" ┃"))
}

/** The frame's transcript from the prompt on, up to Prime's hint line, with the blank rows dropped. */
const transcript = (frame: ReadonlyArray<string>): ReadonlyArray<string> => {
  const start = frame.findIndex((line) => line.includes("┃ Check the build"))
  const end = hintAt(frame)
  // Up to the hint when it is below the prompt, else to the frame's end.
  return frame.slice(start, Math.max(end, frame.length * Number(end <= start))).filter((line) => line.trim() !== "")
}

/** A row's exact line; `<t>` stands for a duration such as `12ms` or `6.0s`. */
const row = (line: string) =>
  new RegExp(
    `^${line
      .split("<t>")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("(?:\\d+m )?\\d+(?:\\.\\d+)?m?s")}$`,
  )

interface Played {
  readonly frames: Record<Name, ReadonlyArray<string>>
  readonly golden: ReadonlyArray<string>
}

const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-runs", seed, model, title: () => "long suite" }, (tui) =>
    Effect.gen(function* () {
      const frames = new Map<Name, ReadonlyArray<string>>()
      const save = (name: Name) => Effect.sync(() => frames.set(name, tui.text()))
      const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("runs-running", has("Running sleep 6"))
      const started = tui.elapsed()
      yield* save("runs-running")
      // The reader writes while the long command runs; the model reads it on the next step.
      yield* tui.type(STEER)
      yield* tui.press({ name: "enter" })
      // Sent: it waits for the call's step to end, out of the composer.
      yield* tui.until("steered", () => tui.server.inbox(tui.sessionID).length > 0)
      yield* tui.advance(Math.max(0, started + LONG_MS - tui.elapsed()))
      tui.server.exit(tui.sessionID, "suite ok\n")
      yield* tui.until("runs", (frame) => has("the notes say ship it")(frame) && !has("Executing")(frame))
      yield* tui.advance(500)
      yield* save("runs")
      for (const mode of ["runs-all", "runs-overview"] as const) {
        yield* tui.press({ name: "o", ctrl: true })
        yield* tui.advance(300)
        yield* save(mode)
      }
      // The view mode outlives the seed in this app (the real run's TUI ends here): one more Ctrl+O comes back to Details.
      yield* tui.press({ name: "o", ctrl: true })
      yield* tui.until("details again", has("● Ran printf 'build a ok\\n', printf 'build b ok\\n'"))
      const shown = (name: Name) => frames.get(name) ?? []
      const all: Record<Name, ReadonlyArray<string>> = { "runs-running": shown("runs-running"), runs: shown("runs"), "runs-all": shown("runs-all"), "runs-overview": shown("runs-overview") }
      const golden = yield* Effect.forEach(NAMES, (name) => Effect.map(Golden.check("prime-runs", name, all[name]), (lines) => lines.map((line) => `${name} ${line}`)))
      return { frames: all, golden: golden.flat() } satisfies Played
    }),
  )

/** The scenario at `seed`, played once a seed (the four tests read the same run). */
const played = new Map<number, Played>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

seeded("while it runs, the long command after the text is its own row, the newest in the transcript", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { frames, golden } = yield* scenario(seed)
    expect(golden).toEqual([])
    const shown = transcript(frames["runs-running"])
    const at = shown.findIndex((line) => line.includes("Running sleep 6"))
    expect(shown[at]).toMatch(/^ {2}[○●] Running sleep 6; printf 'suite ok\\n'$/)
    expect(shown[at - 1]).toBe("  Both builds pass. Running the long suite.")
    // No tree connector: it hangs under no earlier group, and only the loader follows it.
    expect(shown.slice(at + 1).every((line) => /Executing/.test(line))).toBe(true)
    expect(frames["runs-running"].join("\n")).not.toMatch(/[├└] Running sleep 6/)
  }),
)

seeded("Details: a step's two parallel calls share a group; the next step, the text and the reader's message each start one", ({ seed, expect }) =>
  Effect.gen(function* () {
    expect(transcript((yield* scenario(seed)).frames.runs)).toEqual([
      " ┃ Check the build, then run the long suite.",
      "  ● Ran printf 'build a ok\\n', printf 'build b ok\\n'",
      "    │ build b ok",
      "  ● Ran printf 'lint ok\\n'",
      "    │ lint ok",
      "  Both builds pass. Running the long suite.",
      "  ● Ran sleep 6; printf 'suite ok\\n'",
      "    │ suite ok",
      " ┃ Also read the notes file.",
      "  ● Read notes.md",
      "  Suite passed; the notes say ship it.",
    ])
  }),
)

seeded("All: the first group keeps its header and tree; each call after a message is the group's line alone", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = transcript((yield* scenario(seed)).frames["runs-all"])
    const lines = [
      "  ● Ran 2 commands",
      "  ├ ✓ shell · printf 'build a ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      "  └ ✓ shell · printf 'build b ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      "  ✓ shell · printf 'lint ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      "  Both builds pass. Running the long suite.",
      "  ✓ shell · sleep 6; printf 'suite ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      " ┃ Also read the notes file.",
      "  ✓ read · notes.md · ↑ 1 ↓ 2 lines · <t>",
    ]
    const at = lines.map((line) => shown.findIndex((item) => row(line).test(item)))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  }),
)

seeded("Overview: a header per group, between the messages that end them", ({ seed, expect }) =>
  Effect.gen(function* () {
    expect(transcript((yield* scenario(seed)).frames["runs-overview"])).toEqual([
      " ┃ Check the build, then run the long suite.",
      "  ● Ran 2 commands",
      "  ● Ran 1 command",
      "  Both builds pass. Running the long suite.",
      "  ● Ran 1 command",
      " ┃ Also read the notes file.",
      "  ● Read 1 file",
      "  Suite passed; the notes say ship it.",
    ])
  }),
)

App.closeTest()
