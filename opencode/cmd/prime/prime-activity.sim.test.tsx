// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// The low-verbosity activity row while a turn runs, on the simulated TUI
// (sim-tui/) with Prime loaded by path, each at its first SEEDS seeds: the
// model thinks, then runs a command that the test holds. While it runs, the
// row folding the turn names the command it is running beside the thought
// (`1 command, 1 thought, 1 read`, not just `1 thought, 1 read`), no `Running …` status stands
// in for it, and its spinner shows the same frame as Prime's `Executing` row
// at every clock reading: every spinner on screen turns on the one clock.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { longShell, type Model, ranRead, reasoning, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-activity.sim.test.tsx"
/** Seeds this file runs: a seed plays one short turn. */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime"],
  width: 100,
  height: 30,
  // The default verbosity (low) folds the turn into one activity row; spinners turn, as a real TUI's do.
  config: { animations: true },
}

App.bootTest(BOOT)

const ASK = "Thaw the workbox filesystem."
const COMMAND = "sleep 6; printf 'thawed\\n'"

const model: Model = ({ step }) =>
  [
    // A step that thinks and reads (it ends, so its thought is finished), then a step of the held command.
    [reasoning("The probe shows the filesystem frozen; thaw it."), ranRead({ id: "call_probe", path: "probe.txt", output: "frozen\n" })],
    [longShell({ id: "call_thaw", command: COMMAND })],
    [text("Thawed.")],
  ][step] ?? []

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u
/** The spinner glyph leading the first line that holds `label`, or "" when there is none. */
const glyph = (frame: ReadonlyArray<string>, label: string) => {
  const line = frame.find((each) => each.includes(label)) ?? ""
  return SPINNER.exec(line.slice(0, line.indexOf(label)))?.[0] ?? ""
}

interface Played {
  /** The frame once the command runs. */
  readonly running: ReadonlyArray<string>
  /** The activity row's glyph and the Executing row's, at each of several clock readings while it runs. */
  readonly pairs: ReadonlyArray<readonly [string, string]>
}

const play_ = (seed: number) =>
  App.seed(BOOT, { key: "prime-activity", seed, model, title: () => "thaw" }, (tui) =>
    Effect.gen(function* () {
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("running", (frame) => frame.some((line) => line.includes("1 command")) && frame.some((line) => line.includes("Executing")))
      const running = tui.text()
      const pairs: Array<readonly [string, string]> = []
      // Steps that are no multiple of the spinner's 80 ms, so the readings land at every phase of a frame.
      for (const ms of [0, 30, 50, 70, 110, 130, 170, 230, 290, 310]) {
        yield* tui.advance(ms)
        const frame = tui.text()
        pairs.push([glyph(frame, "1 command"), glyph(frame, "Executing")])
      }
      tui.server.exit(tui.sessionID, "thawed\n")
      yield* tui.until("answered", (frame) => frame.join("\n").includes("Thawed.") && !frame.join("\n").includes("Executing"))
      return { running, pairs } satisfies Played
    }),
  )

seeded("a command running after a thought is named in the activity row, with no Running status", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { running } = yield* play(seed)
    const row = running.find((line) => line.includes("1 command")) ?? ""
    expect(row).toMatch(/^ +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 command, 1 thought, 1 read$/u)
    expect(running.join("\n")).not.toMatch(/Running (kernel|command|shell)…/)
  }),
)

seeded("the activity row's spinner and the Executing row's show the same frame at every reading", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { pairs } = yield* play(seed)
    expect(pairs.every(([row, executing]) => row !== "" && row === executing)).toBe(true)
    // And they turn: the readings span more than one frame.
    expect(new Set(pairs.map(([row]) => row)).size).toBeGreaterThan(1)
  }),
)

/** The run at `seed`, played once a seed (both tests read the same run). */
const played = new Map<number, Played>()
const play = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play_(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

App.closeTest()
