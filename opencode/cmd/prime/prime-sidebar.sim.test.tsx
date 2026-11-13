// tests/prime-sidebar.test.ts's names on the simulated TUI (sim-tui/), each at
// 20 seeds: the fork's real TUI in this process with Prime loaded by path, in
// front of the server double, on a virtual clock. The live subagent rows
// beneath the composer stay while the session's sidebar shows: wide, the
// sidebar holds the session and the worker's row is under the dock's count;
// narrow, with no sidebar, it is there too. scenarios/prime-sidebar.ts step for
// step: the model starts one background worker (the orchestrate plugin's worker
// role, on opencode-drive's gpt-sim-model), which thinks and holds.
import { Effect } from "effect"
import * as Seed from "../../sim/seed.ts"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { MODEL_REF, type Model } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-sidebar.sim.test.tsx"
/** Seeds this file runs: 20 fit its 5 s budget (measured at load 26). */
const SEEDS = 20
const { seeded } = App.runner(FILE, SEEDS)
// The scenario's widths are 160 and 106.
const WIDE = 160
const NARROW = 106
const ROWS = 40
const SIDEBAR = 42
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime"],
  width: WIDE,
  height: ROWS,
  // Each call its own row, as these frames read them; the default (low) folds a turn's calls into one.
  config: { session: { verbosity: "medium" } },
}

Seed.effect(App.BOOT_TEST, App.boot(BOOT))

const ASK = "Fix the money parser with one worker."
const STARTED = "A worker is on it."
const TITLE = "money worker"
const WORKER = { id: "call_fix", description: "Fix money parsing", prompt: "Worker brief.", thought: "Check the money parser first." }
const ROW = /^ [◇◈◆] worker gpt  Fix money parsing  /

const model: Model = ({ text, step }) => {
  // The worker thinks, then holds, so it runs throughout.
  if (text.includes(WORKER.prompt)) return [{ _tag: "Reasoning", text: WORKER.thought }, { _tag: "Stall" }]
  if (step === 0)
    return [
      {
        _tag: "Subagent",
        id: WORKER.id,
        input: { description: WORKER.description, prompt: WORKER.prompt, background: true },
        title: WORKER.description,
        agent: "worker",
        model: MODEL_REF,
      },
    ]
  return [{ _tag: "Text", text: STARTED }, { _tag: "Stall" }]
}

/**
 * The scenario at `seed`: its three frames by name, played once a seed (the three tests read the
 * same run, as the real tests read one replay).
 */
const played = new Map<number, Record<string, ReadonlyArray<string>>>()
const scenario = (seed: number) => {
  const done = played.get(seed)
  if (done !== undefined) return Effect.succeed(done)
  return play(seed).pipe(Effect.tap((frames) => Effect.sync(() => played.set(seed, frames))))
}
const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-sidebar", seed, model, title: () => TITLE }, (tui) =>
    Effect.gen(function* () {
      const frames: Record<string, ReadonlyArray<string>> = {}
      const has = (text: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(text)
      const running = has("◆ 1 subagent ")
      // The row once it shows the worker's thought.
      const row = has(`worker gpt  ${WORKER.description}  ${WORKER.thought} · `)
      // The sidebar titles the session in its own column, right of the transcript.
      const sidebar = (frame: ReadonlyArray<string>) => frame.some((line) => line.indexOf(TITLE) >= WIDE - SIDEBAR)
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("sidebar-wide", (frame) => has(STARTED)(frame) && running(frame) && row(frame) && sidebar(frame), 30_000)
      frames.wide = tui.text()
      yield* tui.resize(NARROW, ROWS)
      yield* tui.until("sidebar-narrow", (frame) => running(frame) && row(frame) && !sidebar(frame), 30_000)
      frames.narrow = tui.text()
      yield* tui.resize(WIDE, ROWS)
      yield* tui.until("sidebar-wide-again", (frame) => running(frame) && row(frame) && sidebar(frame), 30_000)
      frames["wide-again"] = tui.text()
      return frames
    }),
  )

/** The composer area: from the dock's count line to the end, left of the sidebar column. */
const composer = (frame: ReadonlyArray<string> | undefined) => {
  const lines = frame ?? []
  const dock = lines.findIndex((line) => / ◆ \d+ subagents?  ·/.test(line))
  return dock < 0 ? [] : lines.slice(dock).map((line) => line.slice(0, WIDE - SIDEBAR))
}
const sidebarOf = (frame: ReadonlyArray<string> | undefined) => (frame ?? []).map((line) => line.slice(WIDE - SIDEBAR)).join("\n")
const golden = (frames: Record<string, ReadonlyArray<string>>, names: ReadonlyArray<string>) =>
  names.flatMap((name) => Golden.same(frames[name], Golden.frame("prime-sidebar", `sidebar-${name}`)).map((line) => `${name} ${line}`))

seeded("wide, the sidebar holds the session and the dock counts the worker", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(golden(frames, ["wide", "wide-again"])).toEqual([])
    for (const frame of [frames.wide, frames["wide-again"]]) {
      expect(sidebarOf(frame)).toContain("money worker")
      expect(composer(frame)[0]).toStartWith(" ◆ 1 subagent  ·")
    }
  }),
)

seeded("wide, with the sidebar open, the worker's row stays beneath the composer", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    for (const frame of [frames.wide, frames["wide-again"]])
      expect(composer(frame)[1]?.trimEnd()).toMatch(new RegExp(`${ROW.source}Check the money parser first\\. · \\d+s$`))
  }),
)

seeded("narrow, there is no sidebar and the worker's row is back under the count", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(golden(frames, ["narrow"])).toEqual([])
    const shown = composer(frames.narrow)
    expect(shown[0]).toStartWith(" ◆ 1 subagent  ·")
    expect(shown[1]).toMatch(new RegExp(`${ROW.source}Check the money parser first\\. · \\d+s$`))
  }),
)

Seed.effect(App.CLOSE_TEST, App.shutdown)
