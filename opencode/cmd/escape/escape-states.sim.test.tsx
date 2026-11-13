// tests/escape-states.test.ts's names on the simulated TUI (sim-tui/), each at
// its first SEEDS seeds: the fork's real TUI in this process with Prime and the escape
// plugin loaded by path, in front of the server double, on a virtual clock. One
// Escape on a busy session stops its run in every state, never drops the
// prompt the user sent while it ran, and says so when the server does not
// answer. Each test plays its own case of scenarios/escape-states.ts, step for
// step: the model streams its first words and stalls (or, for `tool`, starts a
// shell call that runs until it is cut).
import { Effect } from "effect"
import * as Seed from "../../sim/seed.ts"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import type { Model } from "../../sim-tui/server.ts"
import { hintRow } from "../../tests/composer.ts"

const FILE = "cmd/escape/escape-states.sim.test.tsx"
/** Seeds this file runs: its five cases at 20 seeds each took past 5 s; 4 each fit (measured at load 26). */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime", "cmd/escape"],
  width: 106,
  height: 40,
  // The shell call its own row, as these frames read it; the default (low) folds a turn's calls into one.
  config: { session: { verbosity: "medium" } },
}

Seed.effect(App.BOOT_TEST, App.boot(BOOT))

const ASK = "Rename the helper."
const NEXT = "Also update the docs."
const DRAFT = "half a thought"
const PARTIAL = "Working on it"
type Case = "steer" | "queue" | "tool" | "draft" | "offline"

const modelOf = (which: Case): Model =>
  which === "tool"
    ? ({ step }) =>
        step === 0
          ? [{ _tag: "Text", text: PARTIAL }, { _tag: "Shell", id: "call_wait", command: "sleep 60", description: "Wait" }]
          : [{ _tag: "Text", text: PARTIAL }, { _tag: "Stall" }]
    : () => [{ _tag: "Text", text: PARTIAL }, { _tag: "Stall" }]
const title = () => "helper rename"

/** The case's frames by name (`before`, `after`, `again`, `tool`), as the real scenario saves them. */
const play = (seed: number, which: Case) =>
  App.seed(BOOT, { key: which, seed, model: modelOf(which), title }, (tui) =>
    Effect.gen(function* () {
      const frames: Record<string, ReadonlyArray<string>> = {}
      const has = (text: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(text)
      const at = (start: number, ms: number) => tui.advance(Math.max(0, start + ms - tui.elapsed()))
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      const sent = tui.elapsed()
      yield* tui.until("streaming", has(PARTIAL))
      // Past the 5 s grace, so the first prompt is never taken back.
      yield* at(sent, 6_000)
      if (which === "steer") {
        yield* tui.type(NEXT)
        yield* tui.press({ name: "enter" })
      }
      if (which === "queue") {
        yield* tui.type(NEXT)
        yield* tui.press({ name: "x", ctrl: true })
        yield* tui.press({ name: "enter" })
      }
      if (which === "draft") yield* tui.type(DRAFT)
      yield* tui.advance(1_000)
      if (which === "offline") tui.server.silence()
      frames.before = tui.text()
      yield* tui.press({ name: "escape" })
      if (which === "offline") yield* tui.until("after", has("Still running"))
      else {
        yield* tui.until("after", has("Interrupted"))
        yield* tui.advance(2_500)
      }
      frames.after = tui.text()
      if (which === "steer" || which === "queue") {
        yield* tui.press({ name: "escape" })
        yield* tui.advance(2_500)
        frames.again = tui.text()
      }
      if (which === "tool") frames.tool = [tui.server.shellExits().includes("killed") ? "interrupted" : "running"]
      return frames
    }),
  )

/** The rows above the composer (the transcript, down to Prime's hint line; tests/composer.ts) and the composer's first row. */
const split = (frame: ReadonlyArray<string> | undefined) => {
  const lines = frame ?? []
  const hint = hintRow(lines)
  return { transcript: lines.slice(0, hint).filter((line) => line.trim() !== ""), composer: lines[hint + 1] ?? "" }
}
const golden = (which: Case, frames: Record<string, ReadonlyArray<string>>, names: ReadonlyArray<string>) =>
  names.flatMap((name) => Golden.same(frames[name], Golden.frame("escape-states", `${which}-${name}`)).map((line) => `${name} ${line}`))

for (const which of ["steer", "queue"] as const)
  seeded(
    `a ${which === "steer" ? "steer" : "queued prompt"} sent while the model works: one Escape stops the run and puts the prompt back in the composer`,
    ({ seed, expect }) =>
      Effect.gen(function* () {
        const frames = yield* play(seed, which)
        expect(golden(which, frames, ["before", "after", "again"])).toEqual([])
        expect(split(frames.before).transcript.join("\n")).toContain("Executing")
        const { transcript, composer } = split(frames.after)
        expect(transcript.slice(-3)).toEqual([" ┃ Rename the helper.", "  Working on it", "  ■ Interrupted"])
        expect(composer).toBe(" ┃ Also update the docs.")
        // The second Escape finds an idle session; the prompt stays in the composer.
        expect(split(frames.again).composer).toBe(" ┃ Also update the docs.")
      }),
  )

seeded("a running shell call: one Escape cancels it and interrupts", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* play(seed, "tool")
    expect(golden("tool", frames, ["before", "after"])).toEqual([])
    expect(frames.tool).toEqual(["interrupted"])
    expect(split(frames.after).transcript.slice(-2)).toEqual(["  ● Ran sleep 60 · cancelled", "  ■ Interrupted"])
  }),
)

seeded("a draft in the composer: one Escape interrupts and the draft stays", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* play(seed, "draft")
    expect(golden("draft", frames, ["before", "after"])).toEqual([])
    const { transcript, composer } = split(frames.after)
    expect(transcript.at(-1)).toBe("  ■ Interrupted")
    expect(composer).toBe(" ┃ half a thought")
  }),
)

seeded("the server does not answer: the TUI says so instead of doing nothing", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* play(seed, "offline")
    expect(golden("offline", frames, ["before", "after"])).toEqual([])
    expect((frames.before ?? []).join("\n")).not.toContain("Still running")
    expect((frames.after ?? []).join("\n").replace(/\s*┃\s*/g, " ")).toContain("Still running 5 s after Escape: the server has not")
  }),
)

Seed.effect(App.CLOSE_TEST, App.shutdown)
